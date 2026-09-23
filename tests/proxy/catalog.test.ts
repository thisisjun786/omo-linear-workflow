import { expect, test } from "bun:test";
import { Type } from "@earendil-works/pi-ai";
import { convertResponsesTools } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { z } from "zod";
import { discovery, fixture } from "./fixtures";

test("maps wire metadata and managed aliases without alias-name inference", async () => {
  const f = fixture([
    { id: "gpt-6-astra", owned_by: "openai" },
    { id: "opus-main", owned_by: "anthropic" },
  ]);
  const models = await discovery(f.url).discover({ force: true });
  expect(models).toEqual([
    {
      id: "gpt-6-astra",
      name: "GPT 6.0 Astra",
      api: "openai-responses",
      compat: { supportsStrictMode: true },
      reasoning: true,
      thinkingLevelMap: {
        minimal: null,
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: "max",
      },
      input: ["text", "image"],
      cost: { input: 4, output: 16, cacheRead: 1, cacheWrite: 0 },
      contextWindow: 272000,
      maxTokens: 128000,
    },
    {
      id: "opus-main",
      name: "Opus Main",
      api: "anthropic-messages",
      promptPreset: "claude-opus-4-7",
      reasoning: true,
      thinkingLevelMap: {
        minimal: null,
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: "max",
      },
      input: ["text", "image"],
      cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      contextWindow: 1_000_000,
      maxTokens: 128000,
    },
  ]);
});

test("discovers configured OpenAI-compatible aliases from matching native metadata", async () => {
  const f = fixture([
    { id: "team/mimo-flash", owned_by: "mimo" },
    { id: "disabled/mimo-flash", owned_by: "disabled-mimo" },
  ]);
  f.routes["/v0/management/openai-compatibility"] = {
    "openai-compatibility": [
      {
        name: "disabled-mimo",
        disabled: true,
        prefix: "disabled",
        "base-url": "https://token-plan-sgp.xiaomimimo.com/v1",
        models: [{ name: "mimo-v2.6-flash", alias: "mimo-flash" }],
      },
      {
        name: "mimo",
        prefix: "team",
        "base-url": "https://token-plan-sgp.xiaomimimo.com/v1/",
        models: [
          {
            name: "mimo-v2.6-flash",
            alias: "mimo-flash",
            "display-name": "MiMo Flash",
            "max-context-length": 1_048_576,
            "input-modalities": ["text", "image"],
            "output-modalities": ["text"],
            thinking: { levels: ["high"] },
            "use-max-completion-tokens": true,
          },
          {
            name: "mimo-v2.6-pro",
            alias: "mimo-pro",
            "max-context-length": 1_048_576,
            "input-modalities": ["text", "image"],
            "output-modalities": ["text"],
            thinking: { levels: ["high"] },
          },
        ],
      },
    ],
  };

  const models = await discovery(f.url).discover({ force: true });

  expect(models).toEqual([
    {
      id: "team/mimo-flash",
      name: "MiMo Flash",
      api: "openai-completions",
      compat: {
        requiresReasoningContentOnAssistantMessages: true,
        thinkingFormat: "deepseek",
        supportsDisabledThinking: false,
      },
      reasoning: true,
      thinkingLevelMap: {
        minimal: null,
        low: null,
        medium: null,
        high: "high",
        xhigh: null,
        max: null,
      },
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_048_576,
      maxTokens: 131_072,
    },
  ]);
  expect(models.some((model) => model.id === "team/mimo-pro")).toBe(false);
  expect(models.some((model) => model.id === "disabled/mimo-flash")).toBe(false);
});

test("refresh removes unavailable IDs and rechecks metadata", async () => {
  const f = fixture([
    { id: "gpt-6-astra", owned_by: "openai" },
    { id: "opus-main", owned_by: "anthropic" },
  ]);
  const d = discovery(f.url);
  await d.discover({ force: true });
  const before = f.hits.filter((x) => x.includes("model-definitions")).length;
  await d.discover({ force: false });
  expect(f.hits.filter((x) => x.includes("model-definitions")).length).toBeGreaterThan(before);
  f.routes["/v1/models"] = { object: "list", data: [{ id: "gpt-6-astra", owned_by: "openai" }] };
  expect((await d.discover({ force: false })).map((x) => x.id)).toEqual(["gpt-6-astra"]);
  expect(d.has("opus-main")).toBe(false);
});

test("empty OAuth alias configuration accepts the proxy's null response", async () => {
  const f = fixture([{ id: "gpt-6-astra" }]);
  f.routes["/v0/management/oauth-model-alias"] = { "oauth-model-alias": null };
  const models = await discovery(f.url).discover({ force: true });
  expect(models.map((model) => model.id)).toEqual(["gpt-6-astra"]);
});

test("refresh applies changed model metadata even when advertised IDs stay the same", async () => {
  const f = fixture([{ id: "gpt-6-astra", owned_by: "openai" }]);
  const d = discovery(f.url);
  await d.discover({ force: true });
  f.routes["/v0/management/model-definitions/codex"] = {
    channel: "codex",
    models: [
      {
        id: "gpt-6-astra",
        owned_by: "openai",
        type: "openai",
        context_length: 400000,
        max_completion_tokens: 64000,
        supportedInputModalities: ["text", "image"],
        thinking: { levels: ["low", "medium", "high"] },
      },
    ],
  };
  const refreshed = await d.discover({ force: false });
  expect(refreshed[0]?.contextWindow).toBe(400000);
  expect(refreshed[0]?.maxTokens).toBe(64000);
  expect(refreshed[0]?.thinkingLevelMap?.xhigh).toBeNull();
});

test("Codex tool schemas explicitly preserve optional arguments", async () => {
  const f = fixture([{ id: "gpt-6-astra", owned_by: "openai" }]);
  const [model] = await discovery(f.url).discover({ force: true });
  const tools = convertResponsesTools(
    [
      {
        name: "task",
        description: "Start a task",
        parameters: Type.Object({
          prompt: Type.String(),
          merge: Type.Optional(Type.String()),
        }),
      },
    ],
    {
      supportsStrictMode:
        model?.compat && "supportsStrictMode" in model.compat
          ? (model.compat.supportsStrictMode ?? false)
          : false,
    },
  );
  expect(tools[0]).toMatchObject({
    type: "function",
    strict: false,
    parameters: { required: ["prompt"] },
  });
});

test("missing essential metadata is actionable without dropping valid chat models", async () => {
  const f = fixture([
    { id: "gpt-6-astra", owned_by: "openai" },
    { id: "mystery-alias", owned_by: "anthropic" },
  ]);
  const d = discovery(f.url);
  expect((await d.discover({ force: true })).map((model) => model.id)).toEqual(["gpt-6-astra"]);
  expect(d.diagnostics().join(" ")).toContain("mystery-alias");
});

test("explicit image-only definitions are omitted rather than treated as broken chat metadata", async () => {
  const f = fixture([
    { id: "gpt-6-astra", owned_by: "openai" },
    { id: "gpt-image-2", owned_by: "openai" },
  ]);
  const codex = z
    .object({ models: z.array(z.unknown()) })
    .parse(f.routes["/v0/management/model-definitions/codex"]);
  codex.models.push({
    id: "gpt-image-2",
    owned_by: "openai",
    type: "openai",
    display_name: "GPT Image 2",
  });
  f.routes["/v0/management/model-definitions/codex"] = codex;
  const d = discovery(f.url);
  expect((await d.discover({ force: true })).map((model) => model.id)).toEqual(["gpt-6-astra"]);
  expect(d.diagnostics()).toEqual([]);
});
