import { expect, test } from "bun:test";
import { z } from "zod";
import { extensionFixture, fixture } from "./fixtures";

test("upstream fast selectors use the same proxy model with priority service tier", async () => {
  const f = fixture([{ id: "gpt-6-astra" }]);
  const h = await extensionFixture(f.url);
  const fast = h.registry.find("cliproxyapi", "gpt-6-astra-fast");
  expect(fast?.upstreamModelId).toBe("gpt-6-astra");
  if (!fast) throw new Error("Priority variant missing");
  await h.registry
    .streamSimple(
      fast,
      {
        messages: [{ role: "user", content: "Hello", timestamp: 0 }],
      },
      { maxRetries: 0 },
    )
    .result();
  const request = z
    .object({ model: z.string(), service_tier: z.string() })
    .parse(f.requests[0]?.body);
  expect(request).toEqual({ model: "gpt-6-astra", service_tier: "priority" });
});

test("Claude transport uses the proxy messages route without a duplicate v1", async () => {
  const f = fixture([{ id: "opus-main" }]);
  const h = await extensionFixture(f.url);
  const model = h.registry.find("cliproxyapi", "opus-main");
  if (!model) throw new Error("Fixture model missing");
  await h.registry
    .streamSimple(
      model,
      {
        messages: [{ role: "user", content: "Hello", timestamp: 0 }],
      },
      { maxRetries: 0 },
    )
    .result();
  expect(f.requests.map((request) => request.path)).toEqual(["/v1/messages"]);
});

test("Kimi transport sends the instruction as system rather than developer", async () => {
  const f = fixture([{ id: "kimi-k3" }]);
  f.routes["/v0/management/model-definitions/kimi"] = {
    models: [
      {
        id: "kimi-k3",
        context_length: 262144,
        max_completion_tokens: 32768,
        supportedInputModalities: ["text"],
        thinking: { levels: ["high", "max"] },
      },
    ],
  };
  const h = await extensionFixture(f.url);
  const model = h.registry.find("cliproxyapi", "kimi-k3");
  if (!model) throw new Error("Fixture model missing");
  await h.registry
    .streamSimple(
      model,
      {
        systemPrompt: "Follow the instruction.",
        messages: [{ role: "user", content: "Hello", timestamp: 0 }],
      },
      { maxRetries: 0 },
    )
    .result();
  expect(f.requests.map((request) => request.path)).toEqual(["/v1/chat/completions"]);
  const request = z
    .object({
      messages: z.array(z.object({ role: z.string() })),
    })
    .parse(f.requests[0]?.body);
  expect(request.messages.map((message) => message.role)).toEqual(["system", "user"]);
});
