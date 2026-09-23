import type { Api, Model } from "./engine";
import type { Alias, AvailableModel, Definition } from "./schema";

export type NativeCost = Model<Api>["cost"];
export type ProxyModelConfig = Omit<Model<Api>, "provider" | "baseUrl"> & { promptPreset?: string };

export type Candidate = {
  channel: string;
  definition: Definition;
  alias?: Alias;
  nativeModel?: Model<Api>;
  transportDefaults?: Pick<Model<Api>, "maxTokens" | "compat" | "thinkingLevelMap">;
};

export class DiscoveryError extends Error {
  constructor(message: string) {
    super(`CLIProxyAPI catalog: ${message}`);
    this.name = "DiscoveryError";
  }
}

const ZERO_COST: NativeCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function thinkingMap(levels: readonly string[] | undefined): Model<Api>["thinkingLevelMap"] {
  if (!levels?.some((level) => THINKING_LEVELS.some((known) => known === level))) return undefined;
  const supported = new Set(levels);
  return {
    minimal: supported.has("minimal") ? "minimal" : null,
    low: supported.has("low") ? "low" : null,
    medium: supported.has("medium") ? "medium" : null,
    high: supported.has("high") ? "high" : null,
    xhigh: supported.has("xhigh") ? "xhigh" : null,
    max: supported.has("max") ? "max" : null,
  };
}

function aliasPromptPreset(upstreamId: string): string | undefined {
  const id = upstreamId.toLowerCase();
  if (/^gpt-6(?:-|$)/.test(id)) return "gpt-6-astra";
  const gpt5 = id.match(/^gpt-(5(?:\.[2-6])?)(?:-|$)/)?.[1];
  if (gpt5) return `gpt-${gpt5}`;
  if (id.startsWith("kimi-k3")) return "kimi-k3";
  if (id.includes("kimi-k2.8")) return "kimi-k2-8";
  const grok = id.match(/^grok-(4\.[5-7])(?:-|$)/)?.[1];
  if (grok) return `grok-${grok}`;
  for (const family of [
    "claude-fable-5-1",
    "claude-fable-5",
    "claude-opus-5-5",
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-opus-4-5",
  ])
    if (id.includes(family.replace("claude-", ""))) return family;
  return undefined;
}

function isExplicitNonChat(definition: Definition): boolean {
  if (
    definition.supportedOutputModalities &&
    !definition.supportedOutputModalities.includes("text")
  )
    return true;
  if (
    definition.context_length ||
    definition.inputTokenLimit ||
    definition.max_completion_tokens ||
    definition.outputTokenLimit
  )
    return false;
  return /^(?:gpt-image-|grok-imagine-(?:image|video))/.test(definition.id);
}

function protocol(channel: string, definition: Definition): Api {
  if (channel === "openai-compatibility") return "openai-completions";
  if (channel === "codex" || definition.type === "openai") return "openai-responses";
  if (channel === "claude" || definition.type === "claude") return "anthropic-messages";
  return "openai-completions";
}

export function toModel(
  available: AvailableModel,
  candidate: Candidate,
  costs: ReadonlyMap<string, NativeCost>,
): ProxyModelConfig | undefined {
  const definition = candidate.definition;
  // CLIProxyAPI catalogs image/video generation IDs beside chat IDs. They are intentionally not callable through Senpi's chat model API.
  if (isExplicitNonChat(definition)) return undefined;
  const contextWindow =
    positiveInteger(definition.context_length) ??
    positiveInteger(definition.inputTokenLimit) ??
    positiveInteger(candidate.nativeModel?.contextWindow);
  const maxTokens =
    positiveInteger(definition.max_completion_tokens) ??
    positiveInteger(definition.outputTokenLimit) ??
    positiveInteger(candidate.nativeModel?.maxTokens) ??
    positiveInteger(candidate.transportDefaults?.maxTokens);
  const modalities = definition.supportedInputModalities ?? candidate.nativeModel?.input;
  if (!contextWindow || !maxTokens || !modalities?.includes("text")) {
    throw new DiscoveryError(
      `${available.id} is available but lacks chat context, output-token, or text-input metadata; update CLIProxyAPI model definitions or classify it as non-chat`,
    );
  }
  const input = modalities.filter(
    (item): item is "text" | "image" | "video" =>
      item === "text" || item === "image" || item === "video",
  );
  const upstreamId = candidate.alias?.name ?? definition.id;
  const map = thinkingMap(definition.thinking?.levels);
  const promptPreset = candidate.alias ? aliasPromptPreset(upstreamId) : undefined;
  const api = protocol(candidate.channel, definition);
  return {
    id: available.id,
    // Keep the client-visible alias on the wire. CLIProxyAPI owns alias-to-upstream routing.
    name: candidate.alias?.["display-name"] ?? definition.display_name ?? available.id,
    api,
    ...(candidate.transportDefaults?.compat ? { compat: candidate.transportDefaults.compat } : {}),
    ...(candidate.nativeModel?.compat ? { compat: candidate.nativeModel.compat } : {}),
    ...(api === "openai-responses" ? { compat: { supportsStrictMode: true } } : {}),
    ...(candidate.channel === "kimi" ? { compat: { supportsDeveloperRole: false } } : {}),
    reasoning:
      definition.thinking !== undefined
        ? definition.thinking.levels === undefined || map !== undefined
        : (candidate.nativeModel?.reasoning ?? false),
    ...(candidate.transportDefaults?.thinkingLevelMap || map
      ? { thinkingLevelMap: { ...candidate.transportDefaults?.thinkingLevelMap, ...map } }
      : {}),
    ...(promptPreset ? { promptPreset } : {}),
    input,
    cost: candidate.nativeModel?.cost ?? costs.get(upstreamId) ?? ZERO_COST,
    contextWindow,
    maxTokens,
  };
}
