import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { extractRoutingPolicy, readRoutingPolicy } from "../../src/proxy/routing-source";

const categoryTable = `{
  "visual-engineering": [{ providers: ["anthropic", "copilot"], model: "vision-model", variant: "max" }],
  "deep-low": [{ providers: ["openai"], model: "reasoner", variant: "medium" }],
  quick: [
    { providers: ["fast"], model: "speed-one", variant: "low" },
    { providers: ["fallback", "mirror"], model: "speed-two" }
  ]
}`;

const agentTable = `{
  explore: [{ providers: ["fast"], model: "speed-one", variant: "off" }],
  librarian: [{ providers: ["search"], model: "researcher" }],
  "plan-consultant": [{ providers: ["anthropic"], model: "advisor", variant: "max" }],
  "plan-reviewer": [{ providers: ["openai"], model: "reviewer", variant: "high" }]
}`;

function fixture({
  categories = categoryTable,
  agents = agentTable,
  extra = "",
}: {
  categories?: string;
  agents?: string;
  extra?: string;
} = {}): string {
  return `
    const categoryRoutes = ${categories};
    const agentRoutes = ${agents};
    const codeReviewer = {
      name: "omo-native-code-reviewer",
      mode: "subagent",
      categories: ["unspecified-high"]
    };
    const gateReviewer = {
      name: "omo-native-gate-reviewer",
      mode: "subagent",
      categories: ["deep-high", "unspecified-high"]
    };
    ${extra}
  `;
}

describe("OMO upstream routing extraction", () => {
  test("preserves literal route order, provider order, and reasoning variants", () => {
    const source = fixture();
    const policy = extractRoutingPolicy(source, "5.0.0-test");

    expect(policy).toEqual({
      version: "5.0.0-test",
      digest: createHash("sha256").update(source).digest("hex"),
      categories: {
        "visual-engineering": [
          { providers: ["anthropic", "copilot"], model: "vision-model", variant: "max" },
        ],
        "deep-low": [{ providers: ["openai"], model: "reasoner", variant: "medium" }],
        quick: [
          { providers: ["fast"], model: "speed-one", variant: "low" },
          { providers: ["fallback", "mirror"], model: "speed-two" },
        ],
      },
      agents: {
        explore: { models: [{ providers: ["fast"], model: "speed-one", variant: "off" }] },
        librarian: { models: [{ providers: ["search"], model: "researcher" }] },
        "plan-consultant": {
          models: [{ providers: ["anthropic"], model: "advisor", variant: "max" }],
        },
        "plan-reviewer": {
          models: [{ providers: ["openai"], model: "reviewer", variant: "high" }],
        },
        "omo-native-code-reviewer": { categories: ["unspecified-high"] },
        "omo-native-gate-reviewer": {
          categories: ["deep-high", "unspecified-high"],
        },
      },
    });
  });

  test("reflects added and removed literal routes and entries from the same tables", () => {
    const changedCategories = `{
      "visual-engineering": [{ providers: ["anthropic"], model: "vision-model" }],
      "deep-low": [{ providers: ["openai"], model: "reasoner", variant: "high" }],
      quick: [{ providers: ["new-provider"], model: "new-fast", variant: "minimal" }],
      writing: [{ providers: ["writer"], model: "prose" }]
    }`;
    const changedAgents = `{
      explore: [{ providers: ["new-provider"], model: "new-fast" }],
      librarian: [{ providers: ["search"], model: "researcher" }],
      "plan-consultant": [{ providers: ["anthropic"], model: "advisor" }],
      "plan-reviewer": [{ providers: ["openai"], model: "reviewer" }],
      debugger: [{ providers: ["debug"], model: "debugger" }]
    }`;

    const policy = extractRoutingPolicy(
      fixture({ categories: changedCategories, agents: changedAgents }),
      "next",
    );
    const quick = "quick";
    const writing = "writing";
    const debuggerAgent = "debugger";
    expect(policy.categories[quick]).toEqual([
      { providers: ["new-provider"], model: "new-fast", variant: "minimal" },
    ]);
    expect(policy.categories[writing]).toEqual([{ providers: ["writer"], model: "prose" }]);
    expect(policy.agents[debuggerAgent]).toEqual({
      models: [{ providers: ["debug"], model: "debugger" }],
    });
  });

  test.each([
    ["category", fixture({ categories: "{}" })],
    ["agent", fixture({ agents: "{}" })],
    ["category", fixture({ extra: `const duplicateCategories = ${categoryTable};` })],
    ["agent", fixture({ extra: `const duplicateAgents = ${agentTable};` })],
  ])("rejects missing or ambiguous %s routing tables", (kind, source) => {
    expect(() => extractRoutingPolicy(source, "test")).toThrow(kind);
  });

  test.each([
    categoryTable.replace('model: "reasoner"', "model: chooseModel()"),
    categoryTable.replace('providers: ["openai"]', "providers: inheritedProviders"),
    categoryTable.replace(
      '{ providers: ["openai"], model: "reasoner", variant: "medium" }',
      "...inheritedRoutes",
    ),
  ])("rejects nonliteral category policy expressions", (categories) => {
    expect(() => extractRoutingPolicy(fixture({ categories }), "test")).toThrow("category");
  });

  test("rejects unsupported named and native agent routing shapes", () => {
    const dynamicAgents = agentTable.replace(
      '[{ providers: ["fast"], model: "speed-one", variant: "off" }]',
      "buildRoutes()",
    );
    expect(() => extractRoutingPolicy(fixture({ agents: dynamicAgents }), "test")).toThrow(
      "literal",
    );

    const unsupportedNative = fixture({
      extra: `const unsupported = {
        name: "omo-native-dynamic",
        mode: "subagent",
        categories: inheritedCategories
      };`,
    });
    expect(() => extractRoutingPolicy(unsupportedNative, "test")).toThrow("omo-native-dynamic");
  });

  test("captures every native subagent's inherited categories without flattening models", () => {
    const source = fixture({
      extra: `const qa = {
        name: "omo-native-qa-executor",
        mode: "subagent",
        categories: ["deep-low", "unspecified-low"]
      };`,
    });
    expect(extractRoutingPolicy(source, "test").agents["omo-native-qa-executor"]).toEqual({
      categories: ["deep-low", "unspecified-low"],
    });
  });

  test("parses source without executing arbitrary bundle code", () => {
    const marker = "__olwRoutingSourceExecuted";
    Reflect.deleteProperty(globalThis, marker);
    const source = fixture({
      extra: `globalThis.${marker} = true; (() => { throw new Error("executed") })();`,
    });
    const quick = "quick";
    expect(extractRoutingPolicy(source, "test").categories[quick]).toHaveLength(2);
    expect(Reflect.get(globalThis, marker)).toBeUndefined();
  });

  test("reads and hashes the installed pinned OMO bundle through its package root", async () => {
    const packageRoot = resolve(import.meta.dir, "../../node_modules/omo-ai");
    const [policy, manifestText, bundle] = await Promise.all([
      readRoutingPolicy(packageRoot),
      readFile(resolve(packageRoot, "package.json"), "utf8"),
      readFile(resolve(packageRoot, "plugin/extensions/omo-task.js")),
    ]);
    const manifest = JSON.parse(manifestText);

    expect(policy.version).toBe(manifest.version);
    expect(policy.digest).toBe(createHash("sha256").update(bundle).digest("hex"));
    expect(Object.keys(policy.categories)).toEqual(
      expect.arrayContaining(["visual-engineering", "deep-low", "deep-high", "quick"]),
    );
    const quick = "quick";
    const explore = "explore";
    expect(policy.categories[quick]?.length).toBeGreaterThan(0);
    expect(policy.agents[explore]?.models?.length).toBeGreaterThan(0);
    expect(policy.agents["plan-reviewer"]?.models?.length).toBeGreaterThan(0);
    expect(policy.agents["omo-native-code-reviewer"]).toEqual({
      categories: ["unspecified-high"],
    });
    expect(policy.agents["omo-native-gate-reviewer"]).toEqual({
      categories: ["deep-high", "unspecified-high"],
    });
    expect(policy.agents["omo-native-qa-executor"]).toEqual({
      categories: ["deep-low", "unspecified-low"],
    });
  });
});
