import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
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
import { planRouting, ROUTING_PROVIDER, RoutingError } from "./routing-plan";

const configSchema = groupsSchema.partial().passthrough();
const packageSchema = z.object({ name: z.literal("omo-ai"), version: z.string().min(1) });
const catalogSchema = z.object({
  disabledProviders: z.array(z.string()).optional(),
  providers: z.record(z.string(), z.unknown()),
});
const providerCatalogSchema = z.object({
  models: z.array(z.object({ id: z.string().min(1) })).min(1),
});
export interface SyncOptions {
  readonly upstream: string;
  readonly configPath: string;
  readonly stateDir: string;
  /** OMO's models.json, whose opencodex block the opencodex integration maintains. */
  readonly catalogPath: string;
  readonly adopt: boolean;
  readonly check: boolean;
  readonly force: boolean;
}

async function readCatalog(path: string): Promise<string[]> {
  const catalog = catalogSchema.parse(JSON.parse(await readFile(path, "utf8")));
  if (catalog.disabledProviders?.includes(ROUTING_PROVIDER))
    throw new RoutingError(`${ROUTING_PROVIDER} is disabled in ${path}`);
  const models = providerCatalogSchema.safeParse(catalog.providers[ROUTING_PROVIDER]);
  if (!models.success)
    throw new RoutingError(
      `${path} has no ${ROUTING_PROVIDER} models; run \`ocx integration client enable --client omo\``,
    );
  return models.data.models.map((model) => model.id);
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
  const unchanged =
    !options.force &&
    previous?.provider === ROUTING_PROVIDER &&
    previous.digest === sourceDigest &&
    previous.version === identity.version &&
    previous.configDigest === digest(configText) &&
    previous.upstream === options.upstream
      ? previous
      : undefined;
  let available: string[];
  try {
    available = await readCatalog(options.catalogPath);
  } catch (error) {
    // An unchanged start never needed the catalog, so its absence must not block OMO.
    if (unchanged) return unchanged;
    throw error;
  }
  if (unchanged && JSON.stringify(unchanged.available) === JSON.stringify(available))
    return unchanged;
  const { extractRoutingPolicy } = await import("./routing-source");
  const policy = extractRoutingPolicy(source, identity.version);
  const config = configSchema.parse(Bun.JSON5.parse(configText));
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
    provider: ROUTING_PROVIDER,
    version: policy.version,
    digest: policy.digest,
    upstream: options.upstream,
    configDigest: digest(text),
    managed: plan.managed,
    available,
    overrides: [...plan.overrides],
    skipped: [...new Set(plan.skipped)],
    unroutable: [...plan.unroutable],
    changes: [...plan.changes],
    backup,
  };
  if (!options.check)
    await publishRouting(options.stateDir, options.configPath, configText, text, receipt);
  return receipt;
}
