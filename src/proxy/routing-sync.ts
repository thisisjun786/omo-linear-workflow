import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { modelForLaunch, OLW_ROLE_MODELS } from "../core/policy";
import {
  exportedModelRows,
  type ModelMetadata,
  PLACEHOLDER_OUTPUT_LIMIT,
  planCatalog,
} from "./model-catalog";
import {
  atomicText,
  baselineSchema,
  digest,
  editRoutingConfig,
  groupsSchema,
  optionalText,
  publishRouting,
  type RoutingReceipt,
  receiptSchema,
  recoverRouting,
} from "./routing-config";
import {
  fields,
  planRouting,
  ROUTING_PLAN_REVISION,
  ROUTING_PROVIDER,
  RoutingError,
} from "./routing-plan";

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
  readonly routingPolicy?: "pinned" | "follow";
  readonly apply?: readonly string[] | "all";
  readonly managerSettingsPath?: string;
}

async function latestBaseline(stateDir: string) {
  const directory = join(stateDir, "baselines");
  const entries = await import("node:fs/promises")
    .then(({ readdir }) => readdir(directory))
    .catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    });
  const name = entries
    .filter((entry) => entry.endsWith("-user-baseline.json"))
    .sort()
    .at(-1);
  if (!name) return undefined;
  return {
    name,
    value: baselineSchema.parse(JSON.parse(await readFile(join(directory, name), "utf8"))),
  };
}

export async function saveRoutingBaseline(
  configPath: string,
  catalogPath: string,
  stateDir: string,
  now = new Date(),
  reason = "user saved current routing as baseline",
): Promise<string> {
  const [configText, stateText, catalogModels] = await Promise.all([
    readFile(configPath, "utf8"),
    readFile(join(stateDir, "state.json"), "utf8"),
    readCatalogModels(catalogPath),
  ]);
  const config = configSchema.parse(Bun.JSON5.parse(configText));
  const receipt = receiptSchema.parse(JSON.parse(stateText));
  const date = now.toISOString().slice(0, 10);
  const path = join(stateDir, "baselines", `${date}-user-baseline.json`);
  await atomicText(
    path,
    `${JSON.stringify(
      {
        createdAt: now.toISOString(),
        reason,
        upstream: {
          version: receipt.version,
          digest: receipt.digest,
          upstream: receipt.upstream,
        },
        ...(catalogModels.models.length === 0 ? {} : { catalog: catalogModels.models }),
        upstreamRouting: receipt.acceptedUpstream ?? receipt.managed,
        routing: {
          categories: Object.fromEntries(
            Object.entries(config.categories ?? {}).map(([name, route]) => [name, fields(route)]),
          ),
          agents: Object.fromEntries(
            Object.entries(config.agents ?? {}).map(([name, route]) => [name, fields(route)]),
          ),
        },
      },
      null,
      2,
    )}\n`,
  );
  return path;
}

export async function dismissRoutingAdvice(
  stateDir: string,
  paths: readonly string[],
): Promise<RoutingReceipt> {
  const statePath = join(stateDir, "state.json");
  const receipt = receiptSchema.parse(JSON.parse(await readFile(statePath, "utf8")));
  const selected = new Set(paths);
  for (const path of selected)
    if (!receipt.advice.some((item) => item.path === path))
      throw new RoutingError(`No pending routing advice for ${path}`);
  const dismissed = { ...receipt.dismissed };
  for (const item of receipt.advice)
    if (selected.has(item.path))
      dismissed[item.path] = digest(
        JSON.stringify({
          path: item.path,
          before: item.before,
          after: item.after,
        }),
      );
  const next = {
    ...receipt,
    generation: crypto.randomUUID(),
    advice: receipt.advice.filter((item) => !selected.has(item.path)),
    dismissed,
  };
  await atomicText(statePath, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export interface RoutingAdviceSummary {
  readonly count: number;
  readonly line: string;
  readonly unchanged?: string;
  readonly routes: RoutingReceipt["advice"];
  readonly catalog: RoutingReceipt["catalogFindings"];
}

async function summarizeRoutingAdvice(
  stateDir: string,
  receipt: RoutingReceipt,
): Promise<RoutingAdviceSummary> {
  const baseline = await latestBaseline(stateDir);
  const count = receipt.advice.length + receipt.catalogFindings.length;
  const upstreamUnchanged = baseline
    ? baseline.value.upstream.digest === receipt.digest &&
      baseline.value.upstream.version === receipt.version
    : false;
  const unchanged = upstreamUnchanged
    ? `upstream routing unchanged since baseline ${basename(baseline?.name ?? "", "-user-baseline.json")} (omo-ai ${baseline?.value.upstream.version})`
    : undefined;
  const missingCatalogSnapshot = receipt.catalogFindings.some(
    (finding) => finding.issue === "no_snapshot",
  );
  return {
    count,
    line:
      missingCatalogSnapshot && count === 1
        ? "no catalog snapshot; run `proxy:routing baseline save`"
        : count
          ? `${count} routing or catalog findings; run bun run proxy:routing status to review`
          : upstreamUnchanged || Object.keys(receipt.dismissed).length === 0
            ? "none"
            : "upstream routing differs from baseline; all findings are dismissed",
    ...(unchanged ? { unchanged } : {}),
    routes: receipt.advice,
    catalog: receipt.catalogFindings,
  };
}

export async function readRoutingAdvice(stateDir: string): Promise<RoutingAdviceSummary> {
  const stateText = await optionalText(join(stateDir, "state.json"));
  if (!stateText) return { count: 0, line: "none", routes: [], catalog: [] };
  const receipt = receiptSchema.parse(JSON.parse(stateText));
  return summarizeRoutingAdvice(stateDir, receipt);
}

export async function checkRoutingAdvice(options: SyncOptions): Promise<RoutingAdviceSummary> {
  return summarizeRoutingAdvice(options.stateDir, await syncRouting({ ...options, check: true }));
}

interface CatalogHealthRows {
  readonly models: ModelMetadata[];
  readonly unavailable: readonly string[];
}

async function readCatalogModels(path: string): Promise<CatalogHealthRows> {
  const rows = exportedModelRows(JSON.parse(await readFile(path, "utf8")));
  return { ...rows, models: planCatalog(rows.models).models };
}

async function readCatalog(path: string): Promise<string[]> {
  const value = JSON.parse(await readFile(path, "utf8"));
  const catalog = catalogSchema.parse(value);
  if (catalog.disabledProviders?.includes(ROUTING_PROVIDER))
    throw new RoutingError(`${ROUTING_PROVIDER} is disabled in ${path}`);
  const models = providerCatalogSchema.safeParse(catalog.providers[ROUTING_PROVIDER]);
  if (!models.success)
    throw new RoutingError(
      `${path} has no ${ROUTING_PROVIDER} models; run \`ocx integration client enable --client omo\``,
    );
  return models.data.models.map((model) => model.id);
}

function modelReferences(groups: ReturnType<typeof groupsSchema.parse>) {
  const references = new Map<string, string[]>();
  for (const scope of ["categories", "agents"] as const)
    for (const [name, route] of Object.entries(groups[scope]))
      for (const qualified of routedModels(route)) {
        const id = qualified.replace(`${ROUTING_PROVIDER}/`, "");
        references.set(id, [...(references.get(id) ?? []), `${scope}.${name}`]);
      }
  return references;
}

function catalogHealth(
  accepted: readonly ModelMetadata[] | undefined,
  current: CatalogHealthRows,
  groups: ReturnType<typeof groupsSchema.parse>,
  managerSettingsPath?: string,
): RoutingReceipt["catalogFindings"] {
  if (!accepted) return [];
  const currentById = new Map(current.models.map((model) => [model.id, model]));
  const presentWithoutMetadata = new Set(current.unavailable);
  const acceptedIds = new Set(accepted.map((model) => model.id));
  const references = modelReferences(groups);
  const manager = modelForLaunch("manager", null, managerSettingsPath);
  const roleEntries = [
    ...Object.entries(OLW_ROLE_MODELS),
    ...(manager.provider === ROUTING_PROVIDER ? [["manager", manager.modelId] as const] : []),
  ];
  const referenced = new Set([...references.keys(), ...roleEntries.map(([, id]) => id)]);
  const actions = ["disable the route rung", "pick another rung", "add a MODEL_CATALOG override"];
  const findings: RoutingReceipt["catalogFindings"] = [];
  for (const before of accepted) {
    if (!referenced.has(before.id)) continue;
    const after = currentById.get(before.id);
    const routes = references.get(before.id) ?? [];
    const roles = roleEntries.filter(([, id]) => id === before.id).map(([role]) => role);
    const add = (
      issue: RoutingReceipt["catalogFindings"][number]["issue"],
      oldValue?: unknown,
      newValue?: unknown,
    ) =>
      findings.push({
        model: before.id,
        issue,
        before: oldValue,
        after: newValue,
        routes,
        roles,
        actions,
      });
    if (!after) {
      if (presentWithoutMetadata.has(before.id)) continue;
      const renamed = current.models.find(
        (candidate) =>
          !acceptedIds.has(candidate.id) &&
          candidate.contextWindow === before.contextWindow &&
          candidate.maxTokens === before.maxTokens &&
          JSON.stringify(candidate.input) === JSON.stringify(before.input) &&
          candidate.reasoning === before.reasoning,
      );
      add(renamed ? "renamed_or_aliased" : "removed", before.id, renamed?.id);
      continue;
    }
    if (after.contextWindow < before.contextWindow)
      add("context_shrank", before.contextWindow, after.contextWindow);
    if (after.maxTokens < before.maxTokens)
      add("max_tokens_shrank", before.maxTokens, after.maxTokens);
    if (
      after.maxTokens === PLACEHOLDER_OUTPUT_LIMIT &&
      before.maxTokens !== PLACEHOLDER_OUTPUT_LIMIT
    )
      add("placeholder_32000", before.maxTokens, after.maxTokens);
    if (before.input.includes("image") && !after.input.includes("image"))
      add("lost_image", before.input, after.input);
    if (before.reasoning !== after.reasoning)
      add("reasoning_flipped", before.reasoning, after.reasoning);
  }
  return findings;
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
    previous.planRevision === ROUTING_PLAN_REVISION &&
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
  const requestedPolicy = options.routingPolicy ?? previous?.routingPolicy ?? "pinned";
  const migrated =
    previousText !== undefined && !Object.hasOwn(JSON.parse(previousText), "routingPolicy");
  const policyTransition = previous !== undefined && requestedPolicy !== previous.routingPolicy;
  const currentCatalog = await readCatalogModels(options.catalogPath);
  const baseline = await latestBaseline(options.stateDir);
  const settingsDigest = digest((await optionalText(options.managerSettingsPath ?? "")) ?? "");
  const rolesDigest = digest(JSON.stringify(OLW_ROLE_MODELS));
  const adviceInputs = {
    baseline: baseline ? digest(JSON.stringify(baseline.value)) : null,
    settings: settingsDigest,
    roles: rolesDigest,
    catalogHealth: digest(JSON.stringify(currentCatalog.unavailable)),
  };
  if (
    unchanged &&
    JSON.stringify(unchanged.available) === JSON.stringify(available) &&
    JSON.stringify(unchanged.catalog) === JSON.stringify(currentCatalog.models) &&
    unchanged.adviceInputs?.catalogHealth === digest(JSON.stringify(currentCatalog.unavailable)) &&
    JSON.stringify(unchanged.adviceInputs) === JSON.stringify(adviceInputs) &&
    !migrated &&
    !policyTransition &&
    options.apply === undefined
  )
    return unchanged;
  const { extractRoutingPolicy } = await import("./routing-source");
  const policy = extractRoutingPolicy(source, identity.version);
  const config = configSchema.parse(Bun.JSON5.parse(configText));
  const current = {
    categories: config.categories ?? {},
    agents: config.agents ?? {},
  };
  const plan = planRouting(policy, new Set(available), current, previous?.managed);
  const wouldBe = planRouting(policy, new Set(available), current);
  const acceptedUpstream =
    previous?.acceptedUpstream ?? baseline?.value.upstreamRouting ?? previous?.managed;
  const dismissed = previous?.dismissed ?? {};
  const advice = [] as RoutingReceipt["advice"];
  if (acceptedUpstream) {
    for (const scope of ["categories", "agents"] as const) {
      const names = new Set([
        ...Object.keys(acceptedUpstream[scope]),
        ...Object.keys(wouldBe.managed[scope]),
      ]);
      for (const name of names) {
        const path = `${scope}.${name}`;
        const before = acceptedUpstream[scope][name];
        const after = wouldBe.managed[scope][name];
        const actual = current[scope][name];
        const currentModels = routedModels(fields(actual ?? {}));
        const unavailable = currentModels.filter(
          (model) =>
            model.startsWith(`${ROUTING_PROVIDER}/`) &&
            !available.includes(model.slice(ROUTING_PROVIDER.length + 1)),
        );
        if (!unavailable.length && JSON.stringify(before) === JSON.stringify(after)) continue;
        const alternatives = routedModels(after ?? {}).filter(
          (model) => !unavailable.includes(model),
        );
        const item = {
          path,
          ...(before === undefined ? {} : { before }),
          ...(after === undefined ? {} : { after }),
          ...(actual === undefined ? {} : { current: fields(actual) }),
          status: unavailable.length ? ("unavailable" as const) : ("changed" as const),
          alternatives,
        };
        const signature = digest(JSON.stringify({ path, before, after }));
        if (dismissed[path] !== signature) advice.push(item);
      }
    }
  }
  const selected =
    options.apply === "all"
      ? new Set(advice.map((item) => item.path))
      : new Set(options.apply ?? []);
  const groups: Record<
    "categories" | "agents",
    Record<string, Record<string, unknown>>
  > = structuredClone(current);
  const managed: Record<
    "categories" | "agents",
    Record<string, Record<string, unknown>>
  > = structuredClone(previous?.managed ?? plan.managed);
  for (const path of selected) {
    const [scope, name] = path.split(".", 2);
    if ((scope !== "categories" && scope !== "agents") || !name)
      throw new RoutingError(`Unknown routing path ${path}`);
    const item = advice.find((entry) => entry.path === path);
    if (!item) throw new RoutingError(`No pending routing advice for ${path}`);
    const retained = { ...(current[scope][name] ?? {}) };
    for (const key of [
      "model",
      "models",
      "reasoning",
      "variant",
      "reasoningEffort",
      "fallback_models",
    ])
      delete retained[key];
    if (item.after === undefined) {
      if (Object.keys(retained).length) groups[scope][name] = retained;
      else delete groups[scope][name];
      delete managed[scope][name];
    } else {
      groups[scope][name] = { ...retained, ...item.after };
      managed[scope][name] = item.after;
    }
  }
  const shouldFollow = requestedPolicy === "follow" || previous === undefined;
  const outputGroups = shouldFollow ? plan.groups : selected.size ? groups : current;
  const outputManaged = shouldFollow ? plan.managed : managed;
  const outputAcceptedUpstream: Record<
    "categories" | "agents",
    Record<string, Record<string, unknown>>
  > = structuredClone(acceptedUpstream ?? plan.managed);
  for (const path of selected) {
    const [scope, name] = path.split(".", 2);
    if ((scope !== "categories" && scope !== "agents") || !name) continue;
    const after = wouldBe.managed[scope][name];
    if (after === undefined) delete outputAcceptedUpstream[scope][name];
    else outputAcceptedUpstream[scope][name] = after;
  }
  const observedDismissed = { ...dismissed };
  for (const scope of ["categories", "agents"] as const) {
    const names = new Set([
      ...Object.keys(acceptedUpstream?.[scope] ?? {}),
      ...Object.keys(wouldBe.managed[scope]),
      ...Object.keys(observedDismissed)
        .filter((path) => path.startsWith(`${scope}.`))
        .map((path) => path.slice(scope.length + 1)),
    ]);
    for (const name of names) {
      const path = `${scope}.${name}`;
      const before = acceptedUpstream?.[scope][name];
      const after = wouldBe.managed[scope][name];
      const currentSignature = digest(JSON.stringify({ path, before, after }));
      if (observedDismissed[path] !== undefined && observedDismissed[path] !== currentSignature)
        delete observedDismissed[path];
    }
  }
  const remainingAdvice = advice.filter((item) => !selected.has(item.path));
  const acceptedCatalog = baseline?.value.catalog ?? previous?.catalog;
  const catalogFindings = [
    ...(baseline && !baseline.value.catalog
      ? [
          {
            model: "catalog",
            issue: "no_snapshot" as const,
            routes: [],
            roles: [],
            actions: ["run `proxy:routing baseline save`"],
          },
        ]
      : []),
    ...(acceptedCatalog
      ? catalogHealth(acceptedCatalog, currentCatalog, current, options.managerSettingsPath)
      : []),
    ...(currentCatalog.unavailable.length
      ? [
          {
            model: "catalog",
            issue: "metadata_unavailable" as const,
            before: currentCatalog.unavailable.length,
            routes: [],
            roles: [],
            actions: ["review catalog metadata"],
          },
        ]
      : []),
  ];
  const text = (shouldFollow ? plan.changes.length > 0 : selected.size > 0)
    ? editRoutingConfig(configText, outputGroups)
    : configText;
  let backup = previous?.backup ?? null;
  if (!options.check && text !== configText) {
    await mkdir(join(options.stateDir, "backups"), { recursive: true, mode: 0o700 });
    backup = join(options.stateDir, "backups", `${crypto.randomUUID()}.jsonc`);
    await writeFile(backup, configText, { mode: 0o600, flag: "wx" });
  }
  const receipt: RoutingReceipt = {
    generation: crypto.randomUUID(),
    provider: ROUTING_PROVIDER,
    planRevision: ROUTING_PLAN_REVISION,
    version: policy.version,
    digest: policy.digest,
    upstream: options.upstream,
    configDigest: digest(text),
    managed: outputManaged,
    available,
    overrides: [...plan.overrides],
    skipped: [...new Set(wouldBe.skipped)],
    unroutable: [...wouldBe.unroutable],
    changes: shouldFollow ? [...plan.changes] : [...selected],
    backup,
    routingPolicy: requestedPolicy,
    advice: requestedPolicy === "follow" || previous === undefined ? [] : remainingAdvice,
    dismissed: observedDismissed,
    catalogFindings,
    acceptedUpstream: requestedPolicy === "follow" ? plan.managed : outputAcceptedUpstream,
    catalog: currentCatalog.models,
    adviceInputs,
  };
  if (!options.check) {
    await publishRouting(options.stateDir, options.configPath, configText, text, receipt);
    if (selected.size && baseline) {
      const routing: Record<
        "categories" | "agents",
        Record<string, Record<string, unknown>>
      > = structuredClone(baseline.value.routing);
      for (const path of selected) {
        const [scope, name] = path.split(".", 2);
        if ((scope !== "categories" && scope !== "agents") || !name) continue;
        const acceptedRoute = managed[scope][name];
        if (acceptedRoute === undefined) delete routing[scope][name];
        else routing[scope][name] = acceptedRoute;
      }
      await atomicText(
        join(options.stateDir, "baselines", baseline.name),
        `${JSON.stringify(
          {
            ...baseline.value,
            routing,
            upstreamRouting: outputAcceptedUpstream,
          },
          null,
          2,
        )}\n`,
      );
    }
  }
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
