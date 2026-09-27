import { existsSync, watch } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ProviderConfig } from "@code-yeongyu/senpi";
import { createAssistantMessageEventStream } from "../node_modules/@code-yeongyu/senpi/node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js";

// Offline QA replaces only inference. Native TUI, shared host, extension delivery,
// question persistence and Herdr integration are unchanged and can fail normally.
export default function offlineProvider(pi: ExtensionAPI, gate?: string): void {
  pi.rpc.handle("oi.qa.olw-ask", async (input: unknown) => {
    const result = await pi.executeTool("olw_ask", input);
    if (result.isError)
      throw new Error(
        result.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n"),
      );
    return result.details;
  });
  const stream: NonNullable<ProviderConfig["streamSimple"]> = (model, context) => {
    const events = createAssistantMessageEventStream();
    queueMicrotask(async () => {
      if (gate !== undefined && JSON.stringify(context.messages).includes("OLW_ENTRY_BUSY_GATE")) {
        const released = Promise.withResolvers<void>();
        const inspect = () => {
          if (existsSync(join(gate, "release"))) released.resolve();
        };
        const watcher = watch(gate, inspect);
        const deadline = setTimeout(() => released.reject(new Error("QA release deadline")), 60000);
        try {
          await writeFile(join(gate, "entered"), "entered");
          inspect();
          await released.promise;
        } finally {
          watcher.close();
          clearTimeout(deadline);
        }
      }
      const message = {
        role: "assistant" as const,
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [{ type: "text" as const, text: "QA_ACK" }],
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop" as const,
        timestamp: Date.now(),
      };
      events.push({ type: "start", partial: message });
      events.push({ type: "done", reason: "stop", message });
      events.end(message);
    });
    return events;
  };
  pi.registerProvider("opencodex", {
    api: "openai-completions",
    baseUrl: "http://offline.invalid",
    apiKey: "qa-offline-not-a-secret",
    streamSimple: stream,
    models: ["anthropic/claude-opus-5-5", "anthropic/claude-fable-5-1", "gpt-6-astra"].map(
      (id) => ({
        id,
        name: id,
        reasoning: true,
        input: ["text"],
        contextWindow: 1_000_000,
        maxTokens: 32_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }),
    ),
  });
}
