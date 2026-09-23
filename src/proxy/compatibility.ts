import type { Api, Model } from "./engine";
import type { Candidate } from "./model";
import type { Compatibility, Definition } from "./schema";

export function compatibleCandidates(
  providers: readonly Compatibility[],
  nativeModels: readonly Model<Api>[] = [],
): Map<string, Candidate[]> {
  const candidates = new Map<string, Candidate[]>();
  for (const provider of providers) {
    if (provider.disabled) continue;
    const baseUrl = provider["base-url"].replace(/\/+$/, "");
    for (const configured of provider.models) {
      const exposedId = provider.prefix
        ? `${provider.prefix.replace(/\/$/, "")}/${configured.alias}`
        : configured.alias;
      const nativeModel = nativeModels.find(
        (model) => model.baseUrl.replace(/\/+$/, "") === baseUrl && model.id === configured.name,
      );
      const definition: Definition = {
        id: configured.name,
        owned_by: provider.name,
        type: "openai",
        display_name: configured["display-name"],
        context_length: configured["max-context-length"],
        supportedInputModalities: configured["input-modalities"],
        supportedOutputModalities: configured["output-modalities"],
        thinking: configured.thinking,
      };
      candidates.set(exposedId, [
        ...(candidates.get(exposedId) ?? []),
        {
          channel: "openai-compatibility",
          definition,
          ...(nativeModel ? { nativeModel } : {}),
          ...(baseUrl === "https://ollama.com/v1"
            ? {
                transportDefaults: {
                  // Ollama does not publish output limits. This is Senpi's bounded
                  // Ollama client budget, not an asserted server/model maximum.
                  maxTokens: 16384,
                  compat: {
                    supportsStore: false,
                    supportsDeveloperRole: false,
                    supportsReasoningEffort: true,
                    maxTokensField: "max_tokens" as const,
                    supportsStrictMode: false,
                    supportsLongCacheRetention: false,
                  },
                  ...(configured.thinking?.levels?.includes("none")
                    ? { thinkingLevelMap: { off: "none" as const } }
                    : {}),
                },
              }
            : {}),
        },
      ]);
    }
  }
  return candidates;
}
