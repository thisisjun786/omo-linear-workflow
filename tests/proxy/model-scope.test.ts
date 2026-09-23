import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { modelScopeArguments, referencedModels } from "../../src/proxy/model-scope";

test("selection scope retains every live reference but not catalog or thinking history", () => {
  // Given explicit routing, auxiliary, role and favorite choices, plus stale history.
  const config = {
    categories: {
      quick: {
        models: [
          { model: "cliproxyapi/old-but-used", reasoning: "low" },
          { model: "cliproxyapi/mimo-v2.6-pro", reasoning: "max" },
        ],
        description: "cliproxyapi/not-a-model-reference",
      },
    },
    agents: {
      worker: {
        model: "short-id",
        fallback_models: [{ provider: "cliproxyapi", model_id: "agent-fallback" }],
      },
    },
    model_profiles: { work: { models: ["cliproxyapi/profile"] } },
  };
  const settings = {
    defaultProvider: "cliproxyapi",
    defaultModel: "main",
    compaction: { model: "cliproxyapi/summary" },
    lookAt: { models: ["cliproxyapi/vision"] },
    retry: {
      fallbackChains: {
        "cliproxyapi/retry-primary": ["cliproxyapi/retry-fallback"],
        "unused-native-guard": [],
      },
    },
    favoriteModels: ["cliproxyapi/favorite"],
    modelThinkingLevels: { "cliproxyapi/mimo-v2.6-flash": "high" },
  };
  // When forming the OMO selection scope, not deleting the upstream catalog.
  const result = referencedModels(config, settings, [
    { provider: "cliproxyapi", modelId: "role", thinking: "high" },
  ]);
  // Then even an older in-use fallback stays, while unused MiMo gets no exemption.
  expect(result).toEqual(
    [
      "agent-fallback",
      "favorite",
      "main",
      "mimo-v2.6-pro",
      "old-but-used",
      "profile",
      "retry-fallback",
      "retry-primary",
      "role",
      "short-id",
      "summary",
      "vision",
    ]
      .map((id) => `cliproxyapi/${id}`)
      .sort(),
  );
});

test("selection scope follows changed references rather than a fixed model allowlist", () => {
  // Given a new upstream model in the applied configuration.
  const config = { categories: { quick: { models: [{ model: "cliproxyapi/new-model" }] } } };
  // When the next launch computes its scope.
  const result = referencedModels(config, {}, []);
  // Then the newly referenced model is included without another allowlist edit.
  expect(result).toEqual(["cliproxyapi/new-model"]);
});

test.each(["referenced", "all"] as const)(
  "scope CLI selects %s without editing ordinary settings or needing a proxy",
  async (mode) => {
    // Given an isolated home with the opposite scope preference.
    const home = await mkdtemp(join(tmpdir(), "olw-model-scope-"));
    const state = join(home, ".omo/proxy-routing");
    const settingsPath = join(home, ".omo/agent/settings.json");
    const settings =
      '{"defaultProvider":"cliproxyapi","defaultModel":"main","enabledModels":["cliproxyapi/*"]}\n';
    try {
      await mkdir(state, { recursive: true });
      await mkdir(join(home, ".omo/agent"), { recursive: true });
      await writeFile(settingsPath, settings);
      await writeFile(
        join(home, ".omo/omo.jsonc"),
        mode === "all"
          ? "invalid configuration during recovery"
          : '{"categories":{"quick":{"models":["cliproxyapi/mimo-v2.6-pro"]}}}',
      );
      await writeFile(
        join(state, "model-scope.json"),
        JSON.stringify({ mode: mode === "all" ? "referenced" : "all" }),
      );
      // When the actual CLI changes or restores scope.
      const child = Bun.spawn(
        [
          process.execPath,
          resolve(import.meta.dir, "../../scripts/proxy-routing.ts"),
          "scope",
          mode,
        ],
        { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" },
      );
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      // Then the user's ordinary settings are unchanged and the previous scope is recoverable.
      expect(code, stderr).toBe(0);
      const result = z.object({ mode: z.string(), backup: z.string() }).parse(JSON.parse(stdout));
      expect(result.mode).toBe(mode);
      expect(JSON.parse(await readFile(result.backup, "utf8"))).toEqual({
        mode: mode === "all" ? "referenced" : "all",
      });
      expect(await readFile(settingsPath, "utf8")).toBe(settings);
      const args = await modelScopeArguments(home, []);
      if (mode === "all") expect(args).toEqual([]);
      else {
        expect(args[0]).toBe("--models");
        expect(args[1]?.split(",")).toContain("cliproxyapi/mimo-v2.6-pro");
        expect(args[1]?.split(",")).not.toContain("cliproxyapi/mimo-v2.6-flash");
        expect(await modelScopeArguments(home, ["--models", "cliproxyapi/*"])).toEqual([]);
        expect((await modelScopeArguments(home, ["--model", "cliproxyapi/explicit"]))[1]).toContain(
          "cliproxyapi/explicit",
        );
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);
