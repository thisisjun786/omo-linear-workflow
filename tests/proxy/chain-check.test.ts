import { expect, test } from "bun:test";
import { catalogModels, checkChains, summarizeChains } from "../../src/proxy/chain-check";

const catalog = catalogModels({
  providers: {
    opencodex: {
      models: [
        { id: "gpt-6-astra" },
        { id: "gpt-6-sol" },
        { id: "anthropic/claude-opus-5-5" },
        { id: "xai/grok-4.7" },
      ],
    },
  },
});
const role = { provider: "opencodex", modelId: "gpt-6-astra", thinking: "high" } as const;

test("warns only about routes that cannot fall back or cannot run", () => {
  // Given healthy, single-survivor and fully dead routes, including an inheriting agent.
  const report = checkChains(
    {
      categories: {
        ultrabrain: {
          models: [
            { model: "opencodex/gpt-6-astra", reasoning: "max" },
            { model: "opencodex/gpt-6-sol", reasoning: "max" },
          ],
        },
        architect: { models: [{ model: "opencodex/anthropic/claude-opus-5-5" }] },
        quick: { models: ["opencodex/gone", "opencodex/gpt-6-sol", "opencodex/gpt-6-sol"] },
        dead: { models: ["opencodex/gone", "anthropic-subscription/claude-haiku-4-5"] },
      },
      agents: { reviewer: {}, explore: { models: ["opencodex/xai/grok-4.7", "opencodex/gone"] } },
    },
    [role, { ...role, modelId: "retired" }],
    catalog,
  );
  // Then a one-provider chain passes, duplicates count once, and inheriting agents are skipped.
  expect(report.warnings.map((issue) => `${issue.path}: ${issue.message}`)).toEqual([
    "categories.architect: no fallback: only anthropic/claude-opus-5-5 is available",
    "categories.quick: no fallback: only gpt-6-sol is available",
    "categories.dead: no working model: none of its models is in the opencodex catalog",
    "agents.explore: no fallback: only xai/grok-4.7 is available",
    "olw.role.opencodex/retired: not in the opencodex catalog; the OLW role cannot start",
  ]);
  expect(summarizeChains(report)).toStartWith("Model chain warnings: categories.architect (");
});

test("a managed route left without candidates is reported once as having no working model", () => {
  const report = checkChains({ categories: { architect: {} } }, [role], catalog, [
    "categories.architect",
  ]);
  expect(report.warnings).toEqual([
    {
      path: "categories.architect",
      message: "no working model: no upstream choice is published by opencodex",
    },
  ]);
});

test("a healthy configuration produces no output", () => {
  const report = checkChains(
    { categories: { deep: { models: ["opencodex/gpt-6-astra", "opencodex/gpt-6-sol"] } } },
    [role],
    catalog,
  );
  expect(report.warnings).toEqual([]);
  expect(summarizeChains(report)).toBeUndefined();
});
