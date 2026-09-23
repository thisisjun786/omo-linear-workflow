// Senpi supplies these public modules to extensions. The compiler resolves its
// pinned vendored copy through tsconfig paths; the build keeps imports external.
export type { Api, Model } from "@earendil-works/pi-ai";
export { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
export { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
export { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
export { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
