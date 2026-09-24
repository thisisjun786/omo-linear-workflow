import type { RouteRung, UpstreamPolicy } from "./routing-source";

export type RoutingFields = Readonly<Record<string, unknown>>;
export type RoutingGroups = Readonly<
  Record<"categories" | "agents", Readonly<Record<string, RoutingFields>>>
>;
export interface RoutingPlan {
  readonly groups: RoutingGroups;
  readonly managed: RoutingGroups;
  readonly overrides: readonly string[];
  readonly skipped: readonly string[];
  readonly changes: readonly string[];
}

const ROUTING_KEYS = [
  "model",
  "models",
  "reasoning",
  "variant",
  "reasoningEffort",
  "fallback_models",
] as const;
export const ROUTING_PROVIDER = "opencodex";
// opencodex publishes OpenAI (ChatGPT) models bare and every other service as
// `<ocx provider>/<model>`. Keys are the upstream OMO providers for the same service.
const OPENCODEX_NAMESPACES: Readonly<Record<string, string>> = {
  "chatgpt-subscription": "",
  openai: "",
  "anthropic-subscription": "anthropic",
  anthropic: "anthropic",
  "anthropic-api": "anthropic",
  "kimi-coding": "kimi",
  "kimi-for-coding": "kimi",
  xai: "xai",
  xiaomi: "mimo",
  google: "google",
  "opencode-go": "opencode-go",
};
// OMO's own Kimi Code translation (omo-task.js) requests kimi-k3 there as k3.
const NAMESPACE_MODEL_IDS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  kimi: { "kimi-k3": "k3", "kimi-k3-256k": "k3-256k" },
};
// Current rolling-ID version: https://api-docs.deepseek.com/quick_start/pricing
const ROLLING_MODEL_IDS: Readonly<Record<string, string>> = {
  "deepseek-flash": "deepseek-v4.1-flash",
};
// opencodex appends [1m] to a 1M-context variant; the marker is not part of the model name.
const CONTEXT_MARKER = /\[1m\]$/i;
// opencodex's priority-tier row; Senpi spells the same selector with a single hyphen.
const FAST_SELECTOR = "-fast";
const OPENCODEX_FAST_ROW = "--fast";
export class RoutingError extends Error {}

/** Resolve a rung to its own provider's opencodex service, else the exact ID on another host. */
function opencodexResolver(
  available: ReadonlySet<string>,
): (rung: RouteRung) => string | undefined {
  const byName = new Map<string, string>();
  for (const id of available) {
    const name = id.replace(CONTEXT_MARKER, "");
    if (!byName.has(name)) byName.set(name, id);
  }
  const hosted = [...byName.keys()].filter((name) => name.includes("/")).sort();
  return (rung) => {
    const names = [rung.model, ROLLING_MODEL_IDS[rung.model]].filter(
      (name): name is string => name !== undefined,
    );
    for (const provider of rung.providers) {
      const namespace = OPENCODEX_NAMESPACES[provider];
      if (namespace === undefined) continue;
      for (const name of names) {
        const model = NAMESPACE_MODEL_IDS[namespace]?.[name] ?? name;
        const candidates = namespace
          ? [`${namespace}/${model}`]
          : model.endsWith(FAST_SELECTOR)
            ? [model, `${model.slice(0, -FAST_SELECTOR.length)}${OPENCODEX_FAST_ROW}`]
            : [model];
        for (const candidate of candidates) {
          const id = byName.get(candidate);
          if (id) return id;
        }
      }
    }
    for (const name of names) {
      const host = hosted.find((entry) => entry.slice(entry.indexOf("/") + 1) === name);
      const id = byName.get(name) ?? (host === undefined ? undefined : byName.get(host));
      if (id) return id;
    }
    return undefined;
  };
}

function fields(route: RoutingFields): RoutingFields {
  return Object.fromEntries(
    ROUTING_KEYS.filter((key) => Object.hasOwn(route, key)).map((key) => [key, route[key]]),
  );
}

function withoutRouting(route: RoutingFields): Record<string, unknown> {
  const result = { ...route };
  for (const key of ROUTING_KEYS) delete result[key];
  return result;
}

export function planRouting(
  policy: UpstreamPolicy,
  available: ReadonlySet<string>,
  current: RoutingGroups,
  previous?: RoutingGroups,
): RoutingPlan {
  const groups = { categories: { ...current.categories }, agents: { ...current.agents } };
  const managed: Record<"categories" | "agents", Record<string, RoutingFields>> = {
    categories: {},
    agents: {},
  };
  const overrides: string[] = [],
    skipped: string[] = [],
    changes: string[] = [];
  const resolve = opencodexResolver(available);
  const mapChain = (chain: readonly RouteRung[], path: string): RoutingFields => {
    const models: { model: string; reasoning?: string }[] = [];
    const seen = new Set<string>();
    for (const rung of chain) {
      const modelId = resolve(rung);
      if (modelId === undefined) {
        skipped.push(`${path}: ${rung.model}`);
        continue;
      }
      const entry = {
        model: `${ROUTING_PROVIDER}/${modelId}`,
        ...(rung.variant ? { reasoning: rung.variant } : {}),
      };
      const key = JSON.stringify(entry);
      if (!seen.has(key)) models.push(entry);
      seen.add(key);
    }
    if (models.length === 0)
      throw new RoutingError(`${path}: no ${ROUTING_PROVIDER} model in the upstream chain`);
    return { models };
  };
  for (const scope of ["categories", "agents"] as const) {
    const names = new Set([...Object.keys(policy[scope]), ...Object.keys(previous?.[scope] ?? {})]);
    for (const name of names) {
      const path = `${scope}.${name}`;
      const actual = current[scope][name];
      const last = previous?.[scope][name];
      // Only routing fields are owned. Prompts, tools, disable flags and other tuning remain user-owned.
      if (
        previous &&
        (last === undefined
          ? actual !== undefined
          : JSON.stringify(fields(actual ?? {})) !== JSON.stringify(last))
      ) {
        overrides.push(path);
        if (last !== undefined) managed[scope][name] = last;
        continue;
      }
      let desired: RoutingFields | undefined;
      if (scope === "categories") {
        const chain = policy.categories[name];
        if (chain) desired = mapChain(chain, path);
      } else {
        const agent = policy.agents[name];
        if (agent?.models) desired = mapChain(agent.models, path);
        else if (agent?.categories) {
          if (agent.categories.some((category) => !Object.hasOwn(policy.categories, category)))
            throw new RoutingError(
              `${path}: inherited category is missing from the upstream policy`,
            );
          desired = {};
        }
      }
      const retained = withoutRouting(actual ?? {});
      if (desired === undefined) {
        if (Object.keys(retained).length) groups[scope][name] = retained;
        else delete groups[scope][name];
      } else {
        groups[scope][name] = { ...retained, ...desired };
        managed[scope][name] = desired;
      }
      if (JSON.stringify(actual) !== JSON.stringify(groups[scope][name])) changes.push(path);
    }
  }
  return { groups, managed, overrides, skipped, changes };
}
