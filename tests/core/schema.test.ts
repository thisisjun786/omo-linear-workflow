import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Binding } from "../../src/core/contracts";
import { matchesRuntime, modelForRole } from "../../src/core/policy";
import { envelopeSchema, workerRequestSchema } from "../../src/core/schema";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("frozen core schemas and role policy", () => {
  test("modelForRole returns exactly the three proven tuples", () => {
    expect(modelForRole("supervisor")).toEqual({
      provider: "cliproxyapi",
      modelId: "gpt-6-astra",
      thinking: "high",
    });
    expect(modelForRole("parent")).toEqual({
      provider: "cliproxyapi",
      modelId: "claude-opus-5-5",
      thinking: "xhigh",
    });
    expect(modelForRole("child")).toEqual({
      provider: "cliproxyapi",
      modelId: "claude-opus-5-5",
      thinking: "xhigh",
    });
  });

  test("matches an existing binding against the identity seeded in its session", async () => {
    const root = await mkdtemp(join(tmpdir(), "olw-policy-"));
    roots.push(root);
    const sessionPath = join(root, "existing.jsonl");
    await Bun.write(
      sessionPath,
      [
        JSON.stringify({ type: "session", version: 3, id: "session", cwd: root }),
        JSON.stringify({
          type: "model_change",
          provider: "kimi-coding",
          modelId: "k3",
        }),
        JSON.stringify({ type: "thinking_level_change", thinkingLevel: "max" }),
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
    expect(
      matchesRuntime(binding, {
        durableSessionId: "session",
        sessionPath,
        cwd: root,
        provider: "kimi-coding",
        modelId: "k3",
        thinking: "max",
        extensionProtocol: 1,
      }),
    ).toBe(true);
    expect(
      matchesRuntime(binding, {
        durableSessionId: "session",
        sessionPath,
        cwd: root,
        provider: "cliproxyapi",
        modelId: "kimi-k3",
        thinking: "max",
        extensionProtocol: 1,
      }),
    ).toBe(false);
  });

  test("strict schemas reject unknown boundary fields", () => {
    const envelope = {
      version: 1,
      id: "m",
      fromBindingId: "a",
      toBindingId: "b",
      designationId: "d",
      snapshotDigest: "hash",
      kind: "instruction",
      text: "do it",
      outcome: null,
      evidence: [],
      extra: true,
    };
    expect(envelopeSchema.safeParse(envelope).success).toBe(false);
    expect(
      workerRequestSchema.safeParse({ version: 1, dbPath: "/tmp/x", action: "retry", input: {} })
        .success,
    ).toBe(false);
  });
});
