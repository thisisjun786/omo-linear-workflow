import { describe, expect, test } from "bun:test";
import { planRouting, type RoutingGroups } from "../../src/proxy/routing-plan";
import type { UpstreamPolicy } from "../../src/proxy/routing-source";

const available = new Set(["sol", "luna", "opus"]);
const policy: UpstreamPolicy = {
  version: "new",
  digest: "source",
  categories: {
    quick: [
      { providers: ["native"], model: "unavailable", variant: "off" },
      { providers: ["native"], model: "luna", variant: "low" },
      { providers: ["other"], model: "luna", variant: "low" },
      { providers: ["native"], model: "sol", variant: "medium" },
    ],
  },
  agents: {
    explore: { models: [{ providers: ["native"], model: "luna", variant: "low" }] },
    reviewer: { categories: ["quick"] },
  },
};
const empty: RoutingGroups = { categories: {}, agents: {} };

describe("upstream proxy routing", () => {
  test.each([
    {
      offered: ["kimi-k2.7-code-highspeed", "luna"],
      expected: "kimi-k2.7-code-highspeed",
      reasoning: "off",
    },
    {
      offered: ["kimi-for-coding-highspeed", "kimi-k2.7-code-highspeed", "luna"],
      expected: "kimi-for-coding-highspeed",
      reasoning: "off",
    },
    { offered: ["kimi-k3", "luna"], expected: "luna", reasoning: "low" },
  ])("resolves the verified HighSpeed identity without changing reasoning: $expected", (row) => {
    // Given the Kimi product ID followed by a distinct upstream alternative.
    const upstream: UpstreamPolicy = {
      ...policy,
      categories: {},
      agents: {
        explore: {
          models: [
            {
              providers: ["kimi-coding", "kimi-for-coding"],
              model: "kimi-for-coding-highspeed",
              variant: "off",
            },
            { providers: ["openai"], model: "luna", variant: "low" },
          ],
        },
      },
    };
    // When only a verified spelling, the exact ID, or an unrelated Kimi is offered.
    const result = planRouting(upstream, new Set(row.offered), empty);
    // Then choose the same HighSpeed identity when possible, never K3 in its place.
    expect(result.groups.agents["explore"]?.["models"]).toEqual(
      row.expected === "luna"
        ? [{ model: "cliproxyapi/luna", reasoning: "low" }]
        : [
            { model: `cliproxyapi/${row.expected}`, reasoning: row.reasoning },
            { model: "cliproxyapi/luna", reasoning: "low" },
          ],
    );
  });

  test("maps available exact identities in upstream order with reasoning", () => {
    // Given an upstream preference that the proxy does not serve.
    // When the policy is mapped, only explicit upstream alternatives are eligible.
    const result = planRouting(policy, available, empty);
    // Then duplicate provider lanes collapse without inventing model alternatives.
    expect(result.groups.categories["quick"]).toEqual({
      models: [
        { model: "cliproxyapi/luna", reasoning: "low" },
        { model: "cliproxyapi/sol", reasoning: "medium" },
      ],
    });
    expect(result.skipped).toContain("categories.quick: unavailable");
  });

  test("retains manual changes while updating untouched managed routes", () => {
    const first = planRouting(policy, available, empty);
    const edited: RoutingGroups = {
      categories: { quick: { models: ["cliproxyapi/opus"], description: "Custom" } },
      agents: first.groups.agents,
    };
    const result = planRouting(policy, available, edited, first.managed);
    expect(result.groups.categories["quick"]).toEqual(edited.categories["quick"]);
    expect(result.overrides).toContain("categories.quick");
    expect(result.managed.categories["quick"]).toEqual(first.managed.categories["quick"]);
  });

  test("removes migration overrides from agents inheriting upstream categories", () => {
    const current: RoutingGroups = {
      categories: {},
      agents: { reviewer: { models: ["cliproxyapi/opus"], disable: false } },
    };
    const result = planRouting(policy, available, current);
    expect(result.groups.agents["reviewer"]).toEqual({ disable: false });
    expect(result.managed.agents["reviewer"]).toEqual({});
  });

  test("retires removed managed routes but preserves unrelated user configuration", () => {
    const first = planRouting(policy, available, empty);
    const current: RoutingGroups = {
      categories: { ...first.groups.categories, custom: { models: ["cliproxyapi/opus"] } },
      agents: first.groups.agents,
    };
    const result = planRouting(
      { ...policy, categories: {}, agents: {} },
      available,
      current,
      first.managed,
    );
    expect(result.groups.categories["quick"]).toBeUndefined();
    expect(result.groups.categories["custom"]).toEqual(current.categories["custom"]);
    expect(result.groups.agents["explore"]).toBeUndefined();
  });

  test("rejects a policy with no available upstream alternative instead of guessing", () => {
    expect(() => planRouting(policy, new Set(["opus"]), empty)).toThrow("categories.quick");
  });
});
