import { expect, test } from "bun:test";
import { extensionFixture, fixture } from "./fixtures";

test("extension completes discovery before registration and wires explicit and per-turn refresh", async () => {
  const f = fixture([{ id: "gpt-6-astra", owned_by: "openai" }]);
  const h = await extensionFixture(f.url);
  const selectedModels: unknown[] = [];
  h.runtime.setModel = async (model) => {
    selectedModels.push(model);
    return true;
  };
  const original = h.registry.find("cliproxyapi", "gpt-6-astra");
  if (!original) throw new Error("Fixture model missing");
  expect(h.models().map((model) => model.id)).toEqual(["gpt-6-astra", "gpt-6-astra-fast"]);
  f.routes["/v0/management/model-definitions/codex"] = {
    models: [
      {
        id: "gpt-6-astra",
        context_length: 400000,
        max_completion_tokens: 64000,
        supportedInputModalities: ["text", "image"],
      },
    ],
  };
  const ctx = h.runner.createCommandContext();
  Object.defineProperty(ctx, "model", { value: original });
  const command = h.extension.commands.get("proxy-refresh");
  if (!command) throw new Error("Refresh command missing");
  await command.handler("", ctx);
  const before = f.hits.filter((path) => path === "/v1/models").length;
  for (const handler of h.extension.handlers.get("before_agent_start") ?? []) {
    await handler(
      {
        type: "before_agent_start",
        prompt: "",
        systemPrompt: "",
        systemPromptOptions: { cwd: "/" },
      },
      ctx,
    );
  }
  expect(f.hits.filter((path) => path === "/v1/models").length).toBe(before + 1);
  expect(selectedModels).toContainEqual(
    expect.objectContaining({ id: "gpt-6-astra", contextWindow: 400000 }),
  );
});

test("network refresh failure retains the latest catalog instead of restoring startup models", async () => {
  const f = fixture([{ id: "gpt-6-astra" }, { id: "opus-main" }]);
  const h = await extensionFixture(f.url);
  f.routes["/v1/models"] = { data: [{ id: "gpt-6-astra" }] };
  expect((await h.refresh()).errors.size).toBe(0);
  delete f.routes["/v1/models"];
  const failed = await h.refresh();
  expect(failed.errors.has("cliproxyapi")).toBe(true);
  expect(h.models().map((model) => model.id)).toEqual(["gpt-6-astra", "gpt-6-astra-fast"]);
});

test("partial metadata failure retains both channels from the last successful catalog", async () => {
  const f = fixture([{ id: "gpt-6-astra" }, { id: "opus-main" }]);
  const h = await extensionFixture(f.url);
  delete f.routes["/v0/management/model-definitions/claude"];
  const failed = await h.refresh();
  expect(failed.errors.has("cliproxyapi")).toBe(true);
  expect(h.models().map((model) => model.id)).toEqual([
    "gpt-6-astra",
    "opus-main",
    "gpt-6-astra-fast",
  ]);
});

test.each([
  ["gpt-6-astra", undefined],
  ["gpt-6-astra", 372000],
  ["gpt-6-astra-fast", undefined],
  ["gpt-6-astra-fast", 372000],
] as const)(
  "removed model %s cannot send requests with context override %p",
  async (id, contextWindow) => {
    const f = fixture([{ id: "gpt-6-astra" }]);
    const h = await extensionFixture(f.url, contextWindow);
    const stale = h.registry.find("cliproxyapi", id);
    if (!stale) throw new Error("Fixture model missing");
    f.routes["/v1/models"] = { data: [] };
    expect((await h.refresh()).errors.size).toBe(0);
    f.hits.length = 0;
    const response = await h.registry
      .streamSimple(
        stale,
        {
          messages: [{ role: "user", content: "Hello", timestamp: 0 }],
        },
        {
          maxRetries: 0,
          onPayload: (payload) =>
            h.runner.emitBeforeProviderRequest(payload, undefined, { model: stale, headers: {} }),
        },
      )
      .result();
    expect(response.stopReason).toBe("error");
    expect(f.hits).toEqual([]);
  },
);
