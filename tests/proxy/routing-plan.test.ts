import { describe, expect, test } from "bun:test";
import { planRouting, type RoutingGroups } from "../../src/proxy/routing-plan";
import type { RouteRung, UpstreamPolicy } from "../../src/proxy/routing-source";

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

function quick(chain: readonly RouteRung[], offered: readonly string[]) {
  return planRouting(
    { ...policy, agents: {}, categories: { quick: chain } },
    new Set(offered),
    empty,
  );
}

describe("upstream opencodex routing", () => {
  test("maps each upstream provider lane to the same opencodex service", () => {
    // Given upstream lanes for Anthropic, Kimi Code, Xiaomi and xAI.
    const result = quick(
      [
        {
          providers: ["anthropic-subscription", "anthropic"],
          model: "claude-opus-5-5",
          variant: "max",
        },
        {
          providers: ["kimi-coding", "kimi-for-coding", "moonshotai"],
          model: "kimi-k3",
          variant: "max",
        },
        {
          providers: ["kimi-coding", "kimi-for-coding"],
          model: "kimi-for-coding-highspeed",
          variant: "off",
        },
        { providers: ["xiaomi", "opencode-go"], model: "mimo-v2.6-pro", variant: "max" },
        { providers: ["xai", "github-copilot"], model: "grok-4.7", variant: "xhigh" },
      ],
      // When opencodex namespaces those services and also hosts K3 on Ollama Cloud.
      [
        "anthropic/claude-opus-5-5",
        "ollama-cloud/kimi-k3",
        "kimi/k3[1m]",
        "kimi/kimi-for-coding-highspeed",
        "mimo/mimo-v2.6-pro",
        "xai/grok-4.7",
      ],
    );
    // Then reasoning is unchanged and K3 stays on Kimi Code, where OMO names it k3.
    expect(result.groups.categories["quick"]).toEqual({
      models: [
        { model: "opencodex/anthropic/claude-opus-5-5", reasoning: "max" },
        { model: "opencodex/kimi/k3[1m]", reasoning: "max" },
        { model: "opencodex/kimi/kimi-for-coding-highspeed", reasoning: "off" },
        { model: "opencodex/mimo/mimo-v2.6-pro", reasoning: "max" },
        { model: "opencodex/xai/grok-4.7", reasoning: "xhigh" },
      ],
    });
  });

  test("uses the opencodex Fast row for an upstream fast selector, never the base model", () => {
    // Given a priority-tier selector followed by a distinct alternative.
    const chain = [
      { providers: ["chatgpt-subscription", "openai"], model: "gpt-6-luna-fast", variant: "low" },
      { providers: ["openai"], model: "gpt-6-sol", variant: "medium" },
    ];
    // When opencodex publishes its --fast row, it is the same tier selector.
    expect(
      quick(chain, ["gpt-6-luna", "gpt-6-luna--fast", "gpt-6-sol"]).groups.categories["quick"],
    ).toEqual({
      models: [
        { model: "opencodex/gpt-6-luna--fast", reasoning: "low" },
        { model: "opencodex/gpt-6-sol", reasoning: "medium" },
      ],
    });
    // Then without that row the rung is skipped rather than silently served at standard tier.
    const withoutFast = quick(chain, ["gpt-6-luna", "gpt-6-sol"]);
    expect(withoutFast.groups.categories["quick"]).toEqual({
      models: [{ model: "opencodex/gpt-6-sol", reasoning: "medium" }],
    });
    expect(withoutFast.skipped).toContain("categories.quick: gpt-6-luna-fast");
  });

  test.each(["off", "max"])(
    "serves the current DeepSeek Flash identity from another opencodex host with %s reasoning",
    (reasoning) => {
      // Given DeepSeek's rolling ID, which opencodex serves only on Ollama Cloud.
      const result = quick(
        [
          { providers: ["openai"], model: "luna", variant: "low" },
          { providers: ["deepseek"], model: "deepseek-flash", variant: reasoning },
        ],
        ["luna", "command-code/deepseek-deepseek-v4.1-flash", "ollama-cloud/deepseek-v4.1-flash"],
      );
      // Then the exact V4.1 Flash ID is used and the reasoning level is preserved.
      expect(result.groups.categories["quick"]).toEqual({
        models: [
          { model: "opencodex/luna", reasoning: "low" },
          { model: "opencodex/ollama-cloud/deepseek-v4.1-flash", reasoning },
        ],
      });
    },
  );

  test("never substitutes another version or variant for an unserved rung", () => {
    // Given rungs whose exact models opencodex does not publish.
    const result = quick(
      [
        { providers: ["anthropic"], model: "claude-opus-4-6", variant: "max" },
        { providers: ["zai-coding-plan", "opencode-go"], model: "glm-5.3", variant: "max" },
        { providers: ["openai"], model: "luna", variant: "low" },
      ],
      ["anthropic/claude-opus-5-5", "opencode-go/glm-5.3-flash", "luna"],
    );
    // Then newer or Flash siblings are not chosen in their place.
    expect(result.groups.categories["quick"]).toEqual({
      models: [{ model: "opencodex/luna", reasoning: "low" }],
    });
    expect(result.skipped).toEqual([
      "categories.quick: claude-opus-4-6",
      "categories.quick: glm-5.3",
    ]);
  });

  test("maps available exact identities in upstream order with reasoning", () => {
    // Given an upstream preference that opencodex does not serve.
    // When the policy is mapped, only explicit upstream alternatives are eligible.
    const result = planRouting(policy, available, empty);
    // Then duplicate provider lanes collapse without inventing model alternatives.
    expect(result.groups.categories["quick"]).toEqual({
      models: [
        { model: "opencodex/luna", reasoning: "low" },
        { model: "opencodex/sol", reasoning: "medium" },
      ],
    });
    expect(result.skipped).toContain("categories.quick: unavailable");
  });

  test("retains manual changes while updating untouched managed routes", () => {
    const first = planRouting(policy, available, empty);
    const edited: RoutingGroups = {
      categories: { quick: { models: ["opencodex/opus"], description: "Custom" } },
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
      agents: { reviewer: { models: ["opencodex/opus"], disable: false } },
    };
    const result = planRouting(policy, available, current);
    expect(result.groups.agents["reviewer"]).toEqual({ disable: false });
    expect(result.managed.agents["reviewer"]).toEqual({});
  });

  test("retires removed managed routes but preserves unrelated user configuration", () => {
    const first = planRouting(policy, available, empty);
    const current: RoutingGroups = {
      categories: { ...first.groups.categories, custom: { models: ["opencodex/opus"] } },
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
