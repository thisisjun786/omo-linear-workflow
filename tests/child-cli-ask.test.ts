import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Assignment, Registry, Result, ScopeSnapshot } from "../src/core/contracts";
import { openRegistry } from "../src/core/store";
import { Orchestrator, type OrchestratorDependencies } from "../src/orchestrator";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

const snapshot: ScopeSnapshot = {
  version: 1,
  source: "fixture",
  initiative: null,
  projects: [
    {
      project: { id: "project", url: "linear://project", revision: "r1" },
      issues: [{ id: "issue", url: "linear://issue", revision: "r1" }],
    },
  ],
  decisionRefs: [],
};

function reserve(registry: Registry, id: string, assignment: Assignment): void {
  const digest = value(registry.importScope(snapshot)).digest;
  value(
    registry.reserve({
      bindingId: id,
      durableSessionId: `session-${id}`,
      snapshot,
      assignment,
      designation: {
        id: "approval",
        snapshotDigest: digest,
        designatedBy: "user",
        designatedAt: "2026-09-27",
        execute: true,
        create: true,
        contact: true,
      },
      cwd: "/fixture",
      checkout: null,
      herdrSocket: "/fixture/herdr",
      omoSocket: "/fixture/omo",
    }),
  );
}

test("CLI ask rejects child senders before delivery and directs them to olw_ask", async () => {
  const root = await mkdtemp(join(tmpdir(), "olw-child-cli-ask-"));
  roots.push(root);
  await mkdir(join(root, ".omo/state"), { recursive: true });
  const registry = openRegistry(join(root, ".omo/state/registry.sqlite"));
  reserve(registry, "parent", {
    role: "parent",
    initiativeId: null,
    projectId: "project",
    ownerBindingId: null,
  });
  reserve(registry, "child", {
    role: "child",
    initiativeId: null,
    projectId: "project",
    issueId: "issue",
    ownerBindingId: "parent",
  });
  registry.close();

  let hostChecks = 0;
  const dependencies: OrchestratorDependencies = {
    openRegistry,
    createHerdrClient: () => {
      throw new Error("must not open Herdr");
    },
    resolveHerdrArtifact: async () => ({ artifactDir: "/fixture/herdr" }),
    ensureHost: async () => {},
    checkHostProfile: async () => {
      hostChecks += 1;
    },
    gitTip: async () => "unused",
    now: () => "2026-09-27",
    uuid: () => "unused",
    terminateBinding: async () => {},
    prompt: async () => {},
    attachBinding: async () => {
      throw new Error("must not attach to a child for CLI ask");
    },
  };

  const result = await new Orchestrator(root, "/fixture/herdr", dependencies).ask({
    fromId: "child",
    messageId: "question",
    text: "Which option?",
    toUser: false,
  });
  expect(result).toEqual({
    ok: false,
    error: {
      code: "child_cli_ask_unsupported",
      message: "Child sessions must ask through the olw_ask tool so their active goal is paused",
    },
  });
  expect(hostChecks).toBe(0);
});
