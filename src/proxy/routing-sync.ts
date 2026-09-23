import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { CatalogDiscovery, DEFAULT_CHANNELS } from "./catalog";
import { withPriorityModels } from "./priority-models";
import {
  digest,
  editRoutingConfig,
  groupsSchema,
  optionalText,
  publishRouting,
  type RoutingReceipt,
  receiptSchema,
  recoverRouting,
} from "./routing-config";
import { planRouting, RoutingError } from "./routing-plan";
import { clientAccessSchema, managementAccessSchema } from "./schema";

const configSchema = groupsSchema.partial().passthrough();
const packageSchema = z.object({ name: z.literal("omo-ai"), version: z.string().min(1) });
export interface SyncOptions {
  readonly upstream: string;
  readonly configPath: string;
  readonly stateDir: string;
  readonly clientCredentials: string;
  readonly managementCredentials: string;
  readonly adopt: boolean;
  readonly check: boolean;
  readonly force: boolean;
}

export async function syncRouting(options: SyncOptions): Promise<RoutingReceipt> {
  if (!options.check) await recoverRouting(options.stateDir);
  else if (await optionalText(join(options.stateDir, "pending.json")))
    throw new RoutingError("An interrupted publication needs sync before a read-only check");
  const root = dirname(dirname(await realpath(options.upstream)));
  const [packageText, source, configText, previousText] = await Promise.all([
    readFile(join(root, "package.json"), "utf8"),
    readFile(join(root, "plugin/extensions/omo-task.js"), "utf8"),
    readFile(options.configPath, "utf8"),
    optionalText(join(options.stateDir, "state.json")),
  ]);
  const identity = packageSchema.parse(JSON.parse(packageText));
  const previous = previousText ? receiptSchema.parse(JSON.parse(previousText)) : undefined;
  if (!previous && !options.adopt && !options.check)
    throw new RoutingError(
      "Routing tracking is not initialized; run proxy:routing sync --adopt after checking its diff",
    );
  const sourceDigest = digest(source);
  if (
    !options.force &&
    previous?.digest === sourceDigest &&
    previous.version === identity.version &&
    previous.configDigest === digest(configText) &&
    previous.upstream === options.upstream
  )
    return previous;
  const { extractRoutingPolicy } = await import("./routing-source");
  const policy = extractRoutingPolicy(source, identity.version);
  const config = configSchema.parse(Bun.JSON5.parse(configText));
  let available = previous?.available;
  if (options.force || !available || previous?.digest !== sourceDigest) {
    const [clientText, managementText] = await Promise.all([
      readFile(options.clientCredentials, "utf8"),
      readFile(options.managementCredentials, "utf8"),
    ]);
    const client = clientAccessSchema.parse(JSON.parse(clientText));
    const management = managementAccessSchema.parse(JSON.parse(managementText));
    const discovery = new CatalogDiscovery({
      clientBaseUrl: client.baseUrl,
      clientKey: client.apiKey,
      managementUrl: management.managementUrl,
      managementKey: management.managementKey,
      channels: DEFAULT_CHANNELS,
      nativeCosts: new Map(),
      nativeModels: async () => {
        // Standalone CLI execution has no Senpi extension-loader import aliases.
        // Resolve the policy authority's public SDK catalog, only when compatible
        // providers need it; do not enable or authenticate any native provider.
        const engine = await Bun.resolve("@code-yeongyu/senpi", root);
        const catalog = await Bun.resolve("@earendil-works/pi-ai/providers/all", dirname(engine));
        const native: typeof import("@earendil-works/pi-ai/providers/all") = await import(
          pathToFileURL(catalog).href
        );
        return native
          .getBuiltinProviders()
          .flatMap((provider) => native.getBuiltinModels(provider));
      },
    });
    available = withPriorityModels(
      await discovery.discover({ force: true, signal: AbortSignal.timeout(15_000) }),
    ).map((model) => model.id);
  }
  const plan = planRouting(
    policy,
    new Set(available),
    {
      categories: config.categories ?? {},
      agents: config.agents ?? {},
    },
    previous?.managed,
  );
  const text = plan.changes.length ? editRoutingConfig(configText, plan.groups) : configText;
  let backup = previous?.backup ?? null;
  if (!options.check && text !== configText) {
    await mkdir(join(options.stateDir, "backups"), { recursive: true, mode: 0o700 });
    backup = join(options.stateDir, "backups", `${crypto.randomUUID()}.jsonc`);
    await writeFile(backup, configText, { mode: 0o600, flag: "wx" });
  }
  const receipt: RoutingReceipt = {
    generation: crypto.randomUUID(),
    version: policy.version,
    digest: policy.digest,
    upstream: options.upstream,
    configDigest: digest(text),
    managed: plan.managed,
    available,
    overrides: [...plan.overrides],
    skipped: [...new Set(plan.skipped)],
    changes: [...plan.changes],
    backup,
  };
  if (!options.check)
    await publishRouting(options.stateDir, options.configPath, configText, text, receipt);
  return receipt;
}
