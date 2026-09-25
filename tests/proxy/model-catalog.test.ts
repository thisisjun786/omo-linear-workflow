import { expect, test } from "bun:test";
import {
  exportedModels,
  MODEL_CATALOG,
  type ModelMetadata,
  PLACEHOLDER_OUTPUT_LIMIT,
  planCatalog,
} from "../../src/proxy/model-catalog";

const exported = (id: string, overrides: Partial<ModelMetadata> = {}): ModelMetadata => ({
  id,
  contextWindow: 1_000_000,
  maxTokens: PLACEHOLDER_OUTPUT_LIMIT,
  input: ["text", "image"],
  reasoning: true,
  ...overrides,
});

test("catalog fields override ocx and report each change", () => {
  const plan = planCatalog(
    [
      exported("kimi/kimi-for-coding-highspeed", {
        contextWindow: 262_144,
        input: ["text"],
        reasoning: false,
      }),
    ],
    {
      "kimi/kimi-for-coding-highspeed": {
        contextWindow: 262_144,
        maxTokens: 262_144,
        input: ["text", "image"],
        reasoning: true,
        source: "test",
      },
    },
  );
  expect(plan.models[0]).toEqual(
    exported("kimi/kimi-for-coding-highspeed", {
      contextWindow: 262_144,
      maxTokens: 262_144,
      input: ["text", "image"],
      reasoning: true,
    }),
  );
  expect(plan.changes).toEqual([
    { id: "kimi/kimi-for-coding-highspeed", field: "maxTokens", from: 32_000, to: 262_144 },
    { id: "kimi/kimi-for-coding-highspeed", field: "input", from: ["text"], to: ["text", "image"] },
    { id: "kimi/kimi-for-coding-highspeed", field: "reasoning", from: false, to: true },
  ]);
  expect(plan.redundant).toEqual([
    { id: "kimi/kimi-for-coding-highspeed", field: "contextWindow" },
  ]);
});

test("a --fast tier inherits its base entry and output is clamped to the final context", () => {
  const plan = planCatalog([exported("xai/grok-4.7--fast", { contextWindow: 500_000 })], {
    "xai/grok-4.7": { contextWindow: 100_000, maxTokens: 500_000, source: "test" },
  });
  expect(plan.models[0]?.contextWindow).toBe(100_000);
  expect(plan.models[0]?.maxTokens).toBe(100_000);
});

test("uncatalogued models keep ocx values and a still-placeholder output is reported", () => {
  const entry = { ...exported("devin/swe-2"), baseUrl: "http://127.0.0.1:10100/v1" };
  const plan = planCatalog([entry], {});
  expect(plan.models[0]).toBe(entry);
  expect(plan.changes).toEqual([]);
  expect(plan.placeholder).toEqual(["devin/swe-2"]);
});

test("a catalog entry for a model ocx no longer exports is reported as stale", () => {
  const plan = planCatalog([], { "gone/model": { maxTokens: 1, source: "test" } });
  expect(plan.stale).toEqual(["gone/model"]);
});

test("reads the ocx-owned opencodex block and treats a missing reasoning flag as false", () => {
  const models = exportedModels({
    providers: {
      other: { models: [] },
      opencodex: {
        models: [{ id: "a", contextWindow: 10, maxTokens: 5, input: ["text"] }],
      },
    },
  });
  expect(models).toEqual([
    { id: "a", contextWindow: 10, maxTokens: 5, input: ["text"], reasoning: false },
  ]);
});

test("every shipped catalog entry has a source and positive integer limits", () => {
  for (const [id, entry] of Object.entries(MODEL_CATALOG)) {
    expect(entry.source.length, id).toBeGreaterThan(0);
    for (const value of [entry.contextWindow, entry.maxTokens])
      if (value !== undefined) expect(Number.isInteger(value) && value > 0, id).toBe(true);
  }
});
