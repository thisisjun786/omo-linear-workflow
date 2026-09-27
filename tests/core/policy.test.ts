import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SettingsManager } from "@code-yeongyu/senpi";
import type { Assignment, Binding } from "../../src/core/contracts";
import type { RoleModel } from "../../src/core/policy";
import {
  ManagerSettingsError,
  modelForBinding,
  modelForLaunch,
  resolveManagerModel,
} from "../../src/core/policy";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("launch models by role and child stage", () => {
  const cases: Array<{
    readonly role: Assignment["role"];
    readonly stage: "direct" | "plan" | "execute" | "research" | null;
    readonly expected: RoleModel;
  }> = [
    {
      role: "supervisor",
      stage: null,
      expected: { provider: "opencodex", modelId: "gpt-6-astra", thinking: "high" },
    },
    {
      role: "parent",
      stage: null,
      expected: { provider: "opencodex", modelId: "anthropic/claude-opus-5-5", thinking: "xhigh" },
    },
    {
      role: "child",
      stage: null,
      expected: { provider: "opencodex", modelId: "anthropic/claude-opus-5-5", thinking: "xhigh" },
    },
    {
      role: "child",
      stage: "direct",
      expected: { provider: "opencodex", modelId: "anthropic/claude-opus-5-5", thinking: "xhigh" },
    },
    {
      role: "child",
      stage: "plan",
      expected: { provider: "opencodex", modelId: "anthropic/claude-fable-5-1", thinking: "xhigh" },
    },
    {
      role: "child",
      stage: "execute",
      expected: { provider: "opencodex", modelId: "anthropic/claude-opus-5-5", thinking: "medium" },
    },
    {
      role: "child",
      stage: "research",
      expected: { provider: "opencodex", modelId: "anthropic/claude-opus-5-5", thinking: "xhigh" },
    },
  ];

  for (const { role, stage, expected } of cases) {
    test(`${role} at ${stage ?? "default"}`, () => {
      expect(modelForLaunch(role, stage)).toEqual(expected);
    });
  }

  test("manager preserves every native thinking level from settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "olw-manager-settings-"));
    roots.push(root);
    const path = join(root, "settings.json");
    for (const thinking of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
      await Bun.write(
        path,
        JSON.stringify({
          defaultProvider: "fixture-native-provider",
          defaultModel: "fixture-native-model",
          defaultThinkingLevel: thinking,
        }),
      );
      expect(resolveManagerModel(path)).toEqual({
        model: {
          provider: "fixture-native-provider",
          modelId: "fixture-native-model",
          thinking,
        },
        source: "settings",
      });
    }
  });

  test("manager accepts settings written and parsed by pinned Senpi", async () => {
    const root = await mkdtemp(join(tmpdir(), "olw-manager-native-settings-"));
    roots.push(root);
    const agentDir = join(root, ".omo/agent");
    const path = join(agentDir, "settings.json");
    await mkdir(dirname(path), { recursive: true });
    const settings = SettingsManager.create(root, agentDir);
    settings.setDefaultModelAndProvider("fixture-native-provider", "fixture-native-model");
    await settings.flush();
    expect(resolveManagerModel(path)).toEqual({
      model: {
        provider: "fixture-native-provider",
        modelId: "fixture-native-model",
        thinking: "medium",
      },
      source: "settings",
    });
    await Bun.write(
      path,
      `{
        // Native settings support JSONC and trailing commas.
        "defaultProvider": "fixture-native-provider",
        "defaultModel": "fixture-native-model",
        "defaultThinkingLevel": "low",
      }`,
    );
    expect(resolveManagerModel(path)).toEqual({
      model: {
        provider: "fixture-native-provider",
        modelId: "fixture-native-model",
        thinking: "low",
      },
      source: "settings",
    });
  });

  test("manager fallback is explicit and applies only when no default model exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "olw-manager-settings-"));
    roots.push(root);
    const path = join(root, "settings.json");
    const fallback: RoleModel = {
      provider: "opencodex",
      modelId: "anthropic/claude-opus-5-5",
      thinking: "medium",
    };
    expect(resolveManagerModel(path)).toEqual({ model: fallback, source: "fallback_no_default" });
    await Bun.write(path, JSON.stringify({ theme: "dark" }));
    expect(resolveManagerModel(path)).toEqual({ model: fallback, source: "fallback_no_default" });
    await Bun.write(path, "{invalid");
    expect(() => resolveManagerModel(path)).toThrow(ManagerSettingsError);
    await Bun.write(path, JSON.stringify({ defaultModel: "incomplete" }));
    expect(() => resolveManagerModel(path)).toThrow(ManagerSettingsError);
    await rm(path);
    await mkdir(path);
    expect(() => resolveManagerModel(path)).toThrow(ManagerSettingsError);
    // Non-manager models never consult the supplied path, even when it is unreadable.
    expect(modelForLaunch("parent", null, path)).toEqual({
      provider: "opencodex",
      modelId: "anthropic/claude-opus-5-5",
      thinking: "xhigh",
    });
  });

  test("parses medium thinking level from a seeded session", async () => {
    const root = await mkdtemp(join(tmpdir(), "olw-policy-"));
    roots.push(root);
    const sessionPath = join(root, "existing.jsonl");
    await Bun.write(
      sessionPath,
      [
        JSON.stringify({ type: "model_change", provider: "kimi-coding", modelId: "k3" }),
        JSON.stringify({ type: "thinking_level_change", thinkingLevel: "medium" }),
      ].join("\n"),
    );
    const binding: Binding = {
      id: "binding",
      designationId: "designation",
      assignment: {
        role: "parent",
        initiativeId: "initiative",
        projectId: "project",
        ownerBindingId: "supervisor",
      },
      durableSessionId: "session",
      cwd: root,
      checkout: null,
      herdrSocket: "/tmp/herdr.sock",
      omoSocket: "/tmp/omo.sock",
      workspaceId: "workspace",
      paneId: "pane",
      sessionPath,
      launchState: "ready",
      contactState: "active",
      initialization: { state: "accepted", text: "brief" },
    };
    expect(modelForBinding(binding)).toEqual({
      provider: "kimi-coding",
      modelId: "k3",
      thinking: "medium",
    });
  });

  test("unknown seeded thinking level falls back to the launch model", async () => {
    const root = await mkdtemp(join(tmpdir(), "olw-policy-"));
    roots.push(root);
    const sessionPath = join(root, "existing.jsonl");
    await Bun.write(
      sessionPath,
      [
        JSON.stringify({ type: "model_change", provider: "kimi-coding", modelId: "k3" }),
        JSON.stringify({ type: "thinking_level_change", thinkingLevel: "turbo" }),
      ].join("\n"),
    );
    const binding: Binding = {
      id: "binding",
      designationId: "designation",
      assignment: {
        role: "child",
        initiativeId: null,
        projectId: "project",
        issueId: "issue",
        ownerBindingId: "parent",
      },
      durableSessionId: "session",
      cwd: root,
      checkout: null,
      herdrSocket: "/tmp/herdr.sock",
      omoSocket: "/tmp/omo.sock",
      workspaceId: "workspace",
      paneId: "pane",
      sessionPath,
      launchState: "ready",
      contactState: "active",
      initialization: { state: "accepted", text: "brief" },
    };
    expect(modelForBinding(binding)).toEqual(modelForLaunch("child", null));
  });
});
