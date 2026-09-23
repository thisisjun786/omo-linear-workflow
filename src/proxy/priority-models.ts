import type { NativeCost, ProxyModelConfig } from "./model";

/** Senpi's -fast selector means the same Responses model with service_tier=priority. */
export function withPriorityModels(
  models: readonly ProxyModelConfig[],
  costs: ReadonlyMap<string, NativeCost> = new Map(),
): ProxyModelConfig[] {
  const result = [...models];
  const ids = new Set(models.map((model) => model.id));
  for (const model of models) {
    const id = `${model.id}-fast`;
    if (
      model.api !== "openai-responses" ||
      !model.id.startsWith("gpt-") ||
      model.id.endsWith("-fast") ||
      ids.has(id)
    )
      continue;
    result.push({
      ...model,
      id,
      name: `${model.name} Fast`,
      upstreamModelId: model.id,
      serviceTier: "priority",
      cost: costs.get(id) ?? model.cost,
    });
  }
  return result;
}
