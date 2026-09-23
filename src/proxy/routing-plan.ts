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
// Kimi documents this product ID as K2.7 Code HighSpeed:
// https://www.kimi.com/code/docs/en/kimi-code/models.html
const PROXY_MODEL_IDS: Readonly<Record<string, string>> = {
  "kimi-for-coding-highspeed": "kimi-k2.7-code-highspeed",
  // Current rolling-ID version: https://api-docs.deepseek.com/quick_start/pricing
  "deepseek-flash": "deepseek-v4.1-flash",
};
export class RoutingError extends Error {}

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
  const mapChain = (chain: readonly RouteRung[], path: string): RoutingFields => {
    const models: { model: string; reasoning?: string }[] = [];
    const seen = new Set<string>();
    for (const rung of chain) {
      const modelId = available.has(rung.model)
        ? rung.model
        : (PROXY_MODEL_IDS[rung.model] ?? rung.model);
      if (!available.has(modelId)) {
        skipped.push(`${path}: ${rung.model}`);
        continue;
      }
      const entry = {
        model: `cliproxyapi/${modelId}`,
        ...(rung.variant ? { reasoning: rung.variant } : {}),
      };
      const key = JSON.stringify(entry);
      if (!seen.has(key)) models.push(entry);
      seen.add(key);
    }
    if (models.length === 0)
      throw new RoutingError(`${path}: no advertised proxy model in the upstream chain`);
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
