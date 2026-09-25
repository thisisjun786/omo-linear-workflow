import { z } from "zod";
import { ROUTING_PROVIDER } from "./routing-plan";

// opencodex exports every model with this output stand-in (lidge-jun/opencodex#5828).
export const PLACEHOLDER_OUTPUT_LIMIT = 32_000;

export type InputModality = "text" | "image" | "video";
export interface ModelMetadata {
  readonly id: string;
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly input: InputModality[];
  readonly reasoning: boolean;
}
export type CatalogField = "contextWindow" | "maxTokens" | "input" | "reasoning";
export interface CatalogEntry {
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly input?: InputModality[];
  readonly reasoning?: boolean;
  readonly source: string;
}

// User-managed metadata for models opencodex publishes late or wrong. A set field
// always wins over the ocx export; omit a field to keep ocx's value. Keys are ocx
// model ids; a `--fast` tier uses its base entry.
export const MODEL_CATALOG: Readonly<Record<string, CatalogEntry>> = {
  "anthropic/claude-opus-5-5": { maxTokens: 128_000, source: "Anthropic models overview" },
  "anthropic/claude-fable-5-1": { maxTokens: 128_000, source: "Anthropic models overview" },
  "anthropic/claude-sonnet-5": { maxTokens: 128_000, source: "Anthropic models overview" },
  "anthropic/claude-haiku-4-5": { maxTokens: 64_000, source: "Anthropic models overview" },
  "gpt-5.6-luna": { maxTokens: 128_000, source: "OpenAI model catalog" },
  "gpt-5.6-sol": { maxTokens: 128_000, source: "OpenAI model catalog" },
  "gpt-5.6-terra": { maxTokens: 128_000, source: "OpenAI model catalog" },
  "gpt-6-astra": { maxTokens: 128_000, source: "OpenAI model catalog" },
  "gpt-6-luna": { maxTokens: 128_000, source: "OpenAI model catalog" },
  "gpt-6-sol": { maxTokens: 128_000, source: "OpenAI model catalog" },
  "google/gemini-3.8-flash": { maxTokens: 65_536, source: "Google model card" },
  "kimi/k3[1m]": { maxTokens: 131_072, source: "Moonshot kimi-k3" },
  "kimi/kimi-for-coding-highspeed": {
    maxTokens: 262_144,
    input: ["text", "image"],
    reasoning: true,
    source: "user: same model as Kimi K2.7 code highspeed (Moonshot catalog 262144/262144, vision)",
  },
  "ollama-cloud/deepseek-v4.1-flash": { maxTokens: 384_000, source: "DeepSeek v4.1 flash" },
  "ollama-cloud/glm-5.3": { maxTokens: 131_072, source: "Z.ai GLM-5.3" },
  "ollama-cloud/glm-5.3-flash": { maxTokens: 131_072, source: "Z.ai GLM-5.3 flash" },
  "xai/grok-4.7": { maxTokens: 500_000, source: "xAI model catalog" },
  "xai/grok-4.20-0309-non-reasoning": { maxTokens: 30_000, source: "xAI model catalog" },
};

export interface CatalogChange {
  readonly id: string;
  readonly field: CatalogField;
  readonly from: unknown;
  readonly to: unknown;
}
export interface CatalogPlan<T> {
  readonly models: T[];
  readonly changes: CatalogChange[];
  readonly redundant: { readonly id: string; readonly field: CatalogField }[];
  readonly placeholder: string[];
  readonly stale: string[];
}

const FIELDS: readonly CatalogField[] = ["contextWindow", "maxTokens", "input", "reasoning"];
const baseId = (id: string) => id.replace(/--fast$/, "");

const exportedSchema = z.object({
  providers: z.record(z.string(), z.unknown()),
});
const exportedProviderSchema = z.object({
  models: z.array(
    z.object({
      id: z.string().min(1),
      contextWindow: z.number(),
      maxTokens: z.number(),
      input: z.array(z.enum(["text", "image", "video"])),
      reasoning: z.boolean().default(false),
    }),
  ),
});

export function exportedModels(modelsJson: unknown): ModelMetadata[] {
  const provider = exportedSchema.parse(modelsJson).providers[ROUTING_PROVIDER];
  return exportedProviderSchema.parse(provider).models;
}

export function planCatalog<T extends ModelMetadata>(
  exported: readonly T[],
  catalog: Readonly<Record<string, CatalogEntry>> = MODEL_CATALOG,
): CatalogPlan<T> {
  const changes: CatalogChange[] = [];
  const redundant: CatalogPlan<T>["redundant"] = [];
  const placeholder: string[] = [];
  const models = exported.map((model) => {
    const entry = catalog[baseId(model.id)];
    const next: ModelMetadata = {
      id: model.id,
      contextWindow: entry?.contextWindow ?? model.contextWindow,
      maxTokens: entry?.maxTokens ?? model.maxTokens,
      input: entry?.input ?? model.input,
      reasoning: entry?.reasoning ?? model.reasoning,
    };
    const final = { ...next, maxTokens: Math.min(next.maxTokens, next.contextWindow) };
    if (final.maxTokens === PLACEHOLDER_OUTPUT_LIMIT) placeholder.push(model.id);
    let changed = false;
    for (const field of FIELDS) {
      const same = JSON.stringify(model[field]) === JSON.stringify(final[field]);
      if (!same) {
        changes.push({ id: model.id, field, from: model[field], to: final[field] });
        changed = true;
      } else if (entry?.[field] !== undefined && model.id === baseId(model.id))
        redundant.push({ id: model.id, field });
    }
    return changed ? { ...model, ...final } : model;
  });
  const exportedBases = new Set(exported.map((model) => baseId(model.id)));
  const stale = Object.keys(catalog).filter((id) => !exportedBases.has(id));
  return { models, changes, redundant, placeholder, stale };
}
