import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Binding, Result, ScopeSnapshot } from "../src/core/contracts";
import { modelForRole } from "../src/core/policy";
import { openRegistry } from "../src/core/store";
import { Orchestrator, type OrchestratorDependencies } from "../src/orchestrator";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "olw-legacy-gate-"));
  roots.push(root);
  await mkdir(join(root, ".omo/state"), { recursive: true });
  const registry = openRegistry(join(root, ".omo/state/registry.sqlite"));
  const scope: ScopeSnapshot = {
    version: 1,
    source: "fixture",
    initiative: null,
    decisionRefs: [],
    projects: [
      {
        project: { id: "p", url: "linear://p", revision: "1" },
        issues: [{ id: "i", key: "QA-1", url: "linear://i", revision: "1" }],
      },
    ],
  };
  const digest = value(registry.importScope(scope)).digest;
  const designation = {
    id: "d",
    snapshotDigest: digest,
    designatedBy: "user",
    designatedAt: "now",
    create: true,
    execute: true,
    contact: true,
  };
  const reserve = (id: string, assignment: Binding["assignment"]) =>
    value(
      registry.reserve({
        bindingId: id,
        durableSessionId: `session-${id}`,
        designation,
        snapshot: scope,
        assignment,
        cwd: join(root, id),
        checkout: {
          originalRepoRoot: root,
          path: join(root, id),
          branch: id,
          baseBranch: "main",
          baseCommit: "commit",
        },
        herdrSocket: "/legacy/socket",
        omoSocket: "/legacy/host",
      }),
    );
  const parent = reserve("parent", {
    role: "parent",
    initiativeId: null,
    projectId: "p",
    ownerBindingId: null,
  });
  value(registry.provision(parent.id, "old-group-head", "old-parent-pane"));
  value(registry.observeSession(parent.id, join(root, "parent.jsonl")));
  value(
    registry.activate(parent.id, {
      durableSessionId: parent.durableSessionId,
      sessionPath: join(root, "parent.jsonl"),
      cwd: parent.cwd,
      ...modelForRole("parent"),
      extensionProtocol: 2,
    }),
  );
  value(registry.beginInitialization(parent.id, "fixture"));
  value(registry.finishInitialization(parent.id, "accepted"));
  const plan = reserve("plan", {
    role: "child",
    initiativeId: null,
    projectId: "p",
    issueId: "i",
    ownerBindingId: parent.id,
  });
  value(registry.recordStage(plan.id, "i", "plan", 0, null));
  const calls: string[] = [];
  const unexpected = (name: string): never => {
    calls.push(name);
    throw new Error(`Unexpected ${name}`);
  };
  const deps: OrchestratorDependencies = {
    openRegistry,
    createHerdrClient: () => unexpected("Herdr"),
    resolveHerdrArtifact: async () => unexpected("artifact"),
    ensureHost: async () => unexpected("host"),
    checkHostProfile: async () => unexpected("host profile"),
    gitTip: async () => unexpected("Git"),
    uuid: () => unexpected("reservation ID"),
    now: () => "now",
    attachBinding: async () => unexpected("native attach"),
    terminateBinding: async () => unexpected("native terminate"),
    prompt: async () => unexpected("prompt"),
  };
  return {
    root,
    registry,
    digest,
    parent,
    plan,
    calls,
    orchestrator: new Orchestrator(root, "/legacy/socket", deps),
  };
}

test.each(["direct", "planned", "research", "execute"] as const)(
  "legacy parent rejects %s before Herdr, Git, host or reservation side effects",
  async (mode) => {
    const w = await fixture();
    try {
      const before = value(w.registry.list());
      const result =
        mode === "execute"
          ? await w.orchestrator.stageStart({
              fromId: w.plan.id,
              parentId: w.parent.id,
              stage: "execute",
              messageId: "start",
            })
          : await w.orchestrator.createChild({ parentId: w.parent.id, issueId: "i", mode });
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "legacy_parent_unsupported",
          details: {
            bindingId: w.parent.id,
            checkoutKind: "linked-worktree",
            rollback: "docs/operations.md#one-release-rollback",
          },
        },
      });
      expect(w.calls).toEqual([]);
      expect(value(w.registry.list())).toEqual(before);
      expect(value(w.registry.lineageFor(w.plan.id)).stages).toHaveLength(1);
    } finally {
      w.registry.close();
    }
  },
);

test("new linked parent creation is refused before any external side effect or reservation", async () => {
  const w = await fixture();
  try {
    const before = value(w.registry.list());
    expect(
      await w.orchestrator.createParent({
        projectId: "p",
        scopeDigest: w.digest,
        designationId: "d",
        execute: true,
        fixture: true,
        repo: w.root,
        base: "main",
      }),
    ).toMatchObject({ ok: false, error: { code: "legacy_parent_unsupported" } });
    expect(w.calls).toEqual([]);
    expect(value(w.registry.list())).toEqual(before);
  } finally {
    w.registry.close();
  }
});
