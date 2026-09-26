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
import { fields, planRouting, ROUTING_PROVIDER, RoutingError } from "./routing-plan";

const configSchema = groupsSchema.partial().passthrough();
const packageSchema = z.object({ name: z.literal("omo-ai"), version: z.string().min(1) });
const catalogSchema = z.object({
  disabledProviders: z.array(z.string()).optional(),
  providers: z.record(z.string(), z.unknown()),
});
const providerCatalogSchema = z.object({
  models: z.array(z.object({ id: z.string().min(1) })).min(1),
});

// A launcher is either a symlink into the package or a small script: bun's generated shim
// records the entry as a whole-line `# entry: <path>`, and hand-written wrappers exec it as a
// quoted or bare argument. The package is the nearest ancestor whose package.json is omo-ai.
const ENTRY_RECORD = /^# entry: (\/.*\/bin\/omo\.js)[ \t]*$/gm;
const QUOTED_ENTRY = /(['"])(\/(?:(?!\1).)*\/bin\/omo\.js)\1/g;
const BARE_ENTRY = /(?:^|[\s=])(\/[^\s'"]*\/bin\/omo\.js)(?=$|[\s;])/gm;

function launcherEntries(script: string): string[] {
  return [
    ...[...script.matchAll(ENTRY_RECORD)].map((match) => match[1]),
    ...[...script.matchAll(QUOTED_ENTRY)].map((match) => match[2]),
    ...[...script.matchAll(BARE_ENTRY)].map((match) => match[1]),
  ].filter((entry): entry is string => entry !== undefined);
}

async function omoAiPackageAbove(path: string): Promise<string | undefined> {
  for (let dir = dirname(path); dir !== dirname(dir); dir = dirname(dir)) {
    const text = await optionalText(join(dir, "package.json"));
    if (text === undefined) continue;
    let manifest: unknown;
    try {
      manifest = JSON.parse(text);
    } catch {
      continue; // an unreadable manifest on the way up is not omo-ai
    }
    if (packageSchema.safeParse(manifest).success) return dir;
  }
  return undefined;
}

/** Package root of the global omo-ai install behind a symlinked bin or a launcher script. */
export async function upstreamPackageRoot(upstream: string): Promise<string> {
  const target = await realpath(upstream);
  const tried = [target];
  const direct = await omoAiPackageAbove(target);
  if (direct !== undefined) return direct;
  const head = (await readFile(target, "utf8")).slice(0, 4096);
  if (head.startsWith("#!")) {
    for (const entry of launcherEntries(head)) {
      const resolved = await realpath(entry).catch(() => undefined);
      if (resolved === undefined) continue;
      tried.push(resolved);
      const root = await omoAiPackageAbove(resolved);
      if (root !== undefined) return root;
    }
  }
  throw new RoutingError(`No omo-ai package found for ${upstream} (tried ${tried.join(", ")})`);
}
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
  const root = await upstreamPackageRoot(options.upstream);
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

const routedEntrySchema = z.union([z.string(), z.object({ model: z.string() }).passthrough()]);
const routedSchema = z
  .object({
    model: z.string().optional(),
    models: z.array(routedEntrySchema).optional(),
    fallback_models: z.array(z.object({ provider: z.string(), model_id: z.string() })).optional(),
  })
  .passthrough();

/** Every model a route can choose, qualified; throws on a shape the launcher cannot judge. */
function routedModels(route: unknown): string[] {
  const parsed = routedSchema.parse(route);
  return [
    ...(parsed.model === undefined ? [] : [parsed.model]),
    ...(parsed.models ?? []).map((entry) => (typeof entry === "string" ? entry : entry.model)),
    ...(parsed.fallback_models ?? []).map((entry) => `${entry.provider}/${entry.model_id}`),
  ];
}

/**
 * Whether a failed preflight may fall back to the installed routing: an opencodex receipt,
 * and every route it manages still present and choosing only opencodex models (manual
 * opencodex edits made since the last sync are fine).
 */
export async function retainedRoutingInstalled(
  configPath: string,
  stateDir: string,
): Promise<boolean> {
  const [configText, receiptText] = await Promise.all([
    optionalText(configPath),
    optionalText(join(stateDir, "state.json")),
  ]);
  if (configText === undefined || receiptText === undefined) return false;
  try {
    const receipt = receiptSchema.parse(JSON.parse(receiptText));
    if (receipt.provider !== ROUTING_PROVIDER) return false;
    const config = configSchema.parse(Bun.JSON5.parse(configText));
    return (Object.keys(receipt.managed) as Array<keyof typeof receipt.managed>).every((scope) =>
      Object.entries(receipt.managed[scope]).every(([name, managed]) => {
        const actual = config[scope]?.[name];
        if (actual === undefined) return false;
        const models = routedModels(fields(actual));
        // A route that inherits (managed without models) may stay empty; any chosen model
        // must still go through opencodex.
        if (models.length === 0) return routedModels(fields(managed)).length === 0;
        return models.every((model) => model.startsWith(`${ROUTING_PROVIDER}/`));
      }),
    );
  } catch {
    return false; // an unreadable receipt or config is not a safe fallback
  }
}
