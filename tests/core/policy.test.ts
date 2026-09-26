import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Assignment, Binding } from "../../src/core/contracts";
import type { RoleModel } from "../../src/core/policy";
import { modelForBinding, modelForLaunch } from "../../src/core/policy";

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

  test("manager reads valid settings and falls back for missing, malformed and incomplete settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "olw-manager-settings-"));
    roots.push(root);
    const path = join(root, "settings.json");
    const fallback: RoleModel = {
      provider: "opencodex",
      modelId: "anthropic/claude-opus-5-5",
      thinking: "medium",
    };
    expect(modelForLaunch("manager", null, path)).toEqual(fallback);
    await Bun.write(path, "{invalid");
    expect(modelForLaunch("manager", null, path)).toEqual(fallback);
    await Bun.write(path, JSON.stringify({ defaultModel: "incomplete" }));
    expect(modelForLaunch("manager", null, path)).toEqual(fallback);
    await Bun.write(
      path,
      JSON.stringify({
        defaultProvider: "custom",
        defaultModel: "model",
        defaultThinkingLevel: "high",
      }),
    );
    expect(modelForLaunch("manager", null, path)).toEqual({
      provider: "custom",
      modelId: "model",
      thinking: "high",
    });
    // Non-manager models never consult the supplied path, even when it is absent.
    expect(modelForLaunch("parent", null, join(root, "absent"))).toEqual({
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
