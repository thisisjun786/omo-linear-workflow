import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@code-yeongyu/senpi";
import { z } from "zod";
import type {
  Assignment,
  Binding,
  DeliveryRecord,
  Envelope,
  Registry,
  Result,
  RuntimeIdentity,
  ScopeSnapshot,
} from "../src/core/contracts";
import { modelForRole } from "../src/core/policy";
import {
  bindingSchema,
  deliveryRecordSchema,
  designationSchema,
  scopeSnapshotSchema,
} from "../src/core/schema";
import { openRegistry } from "../src/core/store";
import type { HerdrClient, Workspace, WorktreeGrouping } from "../src/herdr";
import { Orchestrator, type OrchestratorDependencies } from "../src/orchestrator";
import { publishReadiness } from "../src/readiness";
import type { NativeSession } from "../src/transport";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}
async function root() {
  const path = await mkdtemp(join(tmpdir(), "olw-standalone-"));
  roots.push(path);
  await mkdir(join(path, ".omo/state"), { recursive: true });
  return path;
}
const projectScope: ScopeSnapshot = {
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
const managerScope: ScopeSnapshot = {
  ...projectScope,
  initiative: { id: "initiative", url: "linear://initiative", revision: "r2" },
  projects: [
    {
      project: { id: "project", url: "linear://project", revision: "r2" },
      issues: [{ id: "extra-issue", url: "linear://extra", revision: "r2" }],
    },
  ],
};
function reserve(
  registry: Registry,
  id: string,
  snapshot: ScopeSnapshot,
  assignment: Assignment,
  approval: { id: string; execute?: boolean; create?: boolean; contact?: boolean } = {
    id: "project-approval",
  },
) {
  const digest = value(registry.importScope(snapshot)).digest;
  return registry.reserve({
    bindingId: id,
    durableSessionId: `session-${id}`,
    snapshot,
    assignment,
    designation: {
      id: approval.id,
      snapshotDigest: digest,
      designatedBy: "user",
      designatedAt: "2026-09-23",
      execute: approval.execute ?? true,
      create: approval.create ?? true,
      contact: approval.contact ?? true,
    },
    cwd: `/worktrees/${id}`,
    checkout: null,
    herdrSocket: "/fixture/herdr",
    omoSocket: "/fixture/omo",
  });
}
function activate(registry: Registry, binding: Binding) {
  value(registry.provision(binding.id, `workspace-${binding.id}`, `pane-${binding.id}`));
  value(registry.observeSession(binding.id, `/sessions/${binding.id}`));
  value(
    registry.activate(binding.id, {
      durableSessionId: binding.durableSessionId,
      sessionPath: `/sessions/${binding.id}`,
      cwd: binding.cwd,
      ...modelForRole(binding.assignment.role),
      extensionProtocol: 1,
    }),
  );
  value(registry.beginInitialization(binding.id, "fixture"));
  return value(registry.finishInitialization(binding.id, "accepted"));
}
function parent(registry: Registry) {
  return activate(
    registry,
    value(
      reserve(registry, "parent", projectScope, {
        role: "parent",
        projectId: "project",
        initiativeId: null,
        ownerBindingId: null,
      }),
    ),
  );
}
function manager(
  registry: Registry,
  snapshot = managerScope,
  approval = { id: "manager-approval" },
) {
  return activate(
    registry,
    value(
      reserve(
        registry,
        "manager",
        snapshot,
        { role: "supervisor", initiativeId: "initiative" },
        approval,
      ),
    ),
  );
}
function message(
  registry: Registry,
  from: Binding,
  to: string | null,
  id: string,
  kind: Envelope["kind"] = "report",
): Envelope {
  return {
    version: 1,
    id,
    fromBindingId: from.id,
    toBindingId: to,
    designationId: from.designationId,
    snapshotDigest: value(registry.designation(from.designationId)).snapshotDigest,
    kind,
    text: "payload",
    outcome: kind === "report" ? "completed" : null,
    evidence: [],
  };
}

test("project-only reservation requires execution approval and retains global project ownership", async () => {
  const registry = openRegistry(join(await root(), ".omo/state/registry.sqlite"));
  try {
    const assignment: Assignment = {
      role: "parent",
      initiativeId: null,
      projectId: "project",
      ownerBindingId: null,
    };
    expect(
      reserve(registry, "denied", projectScope, assignment, { id: "denied", execute: false }),
    ).toMatchObject({ ok: false, error: { code: "execute_denied" } });
    const p = parent(registry);
    const m = manager(registry);
    expect(
      reserve(
        registry,
        "duplicate",
        managerScope,
        { role: "parent", projectId: "project", initiativeId: "initiative", ownerBindingId: m.id },
        { id: "manager-approval" },
      ),
    ).toMatchObject({ ok: false, error: { code: "ownership_conflict" } });
    expect(value(registry.list())).toHaveLength(2);
    expect(p.assignment).toEqual(assignment);
  } finally {
    registry.close();
  }
});

test("explicit cross-designation management preserves project approval and cannot expand child scope", async () => {
  const registry = openRegistry(join(await root(), ".omo/state/registry.sqlite"));
  try {
    const p = parent(registry);
    const m = manager(registry);
    expect(
      registry.authorize(m.durableSessionId, message(registry, m, p.id, "unlinked", "instruction")),
    ).toMatchObject({ ok: false, error: { code: "foreign_designation" } });
    const linked = value(registry.setOwner(p.id, m.id));
    if (p.assignment.role !== "parent") throw new Error("Expected parent");
    expect(linked).toEqual({ ...p, assignment: { ...p.assignment, ownerBindingId: m.id } });
    expect(value(registry.setOwner(p.id, m.id))).toEqual(linked);
    expect(
      value(
        registry.authorize(
          m.durableSessionId,
          message(registry, m, p.id, "instruct", "instruction"),
        ),
      ).id,
    ).toBe(p.id);
    expect(
      value(registry.authorize(p.durableSessionId, message(registry, p, m.id, "report"))).id,
    ).toBe(m.id);
    expect(
      reserve(registry, "expanded", projectScope, {
        role: "child",
        initiativeId: null,
        projectId: "project",
        issueId: "extra-issue",
        ownerBindingId: p.id,
      }),
    ).toMatchObject({ ok: false, error: { code: "scope_violation" } });
    expect(
      reserve(
        registry,
        "wrong-approval",
        managerScope,
        {
          role: "child",
          initiativeId: "initiative",
          projectId: "project",
          issueId: "extra-issue",
          ownerBindingId: p.id,
        },
        { id: "manager-approval" },
      ),
    ).toMatchObject({ ok: false, error: { code: "owner_mismatch" } });
    const c = activate(
      registry,
      value(
        reserve(registry, "child", projectScope, {
          role: "child",
          initiativeId: null,
          projectId: "project",
          issueId: "issue",
          ownerBindingId: p.id,
        }),
      ),
    );
    value(registry.setContactState(m.id, "paused"));
    expect(
      registry.authorize(p.durableSessionId, message(registry, p, m.id, "paused-manager")),
    ).toMatchObject({ ok: false, error: { code: "contact_paused" } });
    expect(
      value(registry.authorize(c.durableSessionId, message(registry, c, p.id, "child-report"))).id,
    ).toBe(p.id);
    expect(
      value(registry.post(p.durableSessionId, message(registry, p, null, "user-question"))).state,
    ).toBe("posted");
    value(registry.setContactState(p.id, "paused"));
    expect(
      registry.post(p.durableSessionId, message(registry, p, null, "paused-parent")),
    ).toMatchObject({ ok: false, error: { code: "contact_paused" } });
    expect(
      registry.authorize(c.durableSessionId, message(registry, c, p.id, "paused-child-report")),
    ).toMatchObject({ ok: false, error: { code: "contact_paused" } });
    value(registry.setOwner(p.id, null));
    expect(value(registry.get(p.id)).contactState).toBe("paused");
    value(registry.setContactState(p.id, "active"));
    value(registry.setContactState(m.id, "active"));
    value(registry.setOwner(p.id, m.id));
    value(registry.beginClose(m.id));
    value(registry.finishClose(m.id));
    expect(value(registry.get(p.id)).assignment).toEqual(linked.assignment);
    expect(
      value(registry.authorize(c.durableSessionId, message(registry, c, p.id, "after-close"))).id,
    ).toBe(p.id);
    expect(
      value(registry.post(p.durableSessionId, message(registry, p, null, "closed-manager"))).state,
    ).toBe("posted");
    value(registry.setOwner(p.id, null));
    expect(value(registry.get(p.id))).toEqual(p);
    expect(registry.beginClose(p.id)).toMatchObject({
      ok: false,
      error: { code: "children_active" },
    });
  } finally {
    registry.close();
  }
});

test.each(["project", "role", "paused", "closed", "contact", "execute"])(
  "link checks manager %s without changing approval",
  async (guard) => {
    const registry = openRegistry(join(await root(), ".omo/state/registry.sqlite"));
    try {
      const p = parent(registry);
      const m = manager(
        registry,
        guard === "project" ? { ...managerScope, projects: [] } : managerScope,
        {
          id: "manager-approval",
          ...(guard === "contact" ? { contact: false } : {}),
          ...(guard === "execute" ? { execute: false } : {}),
        },
      );
      if (guard === "paused") value(registry.setContactState(m.id, "paused"));
      if (guard === "closed") {
        value(registry.beginClose(m.id));
        value(registry.finishClose(m.id));
      }
      expect(registry.setOwner(p.id, guard === "role" ? p.id : m.id).ok).toBe(false);
      expect(value(registry.get(p.id))).toEqual(p);
    } finally {
      registry.close();
    }
  },
);

test("user inbox records immutable reports without a user binding or native receipt", async () => {
  const path = join(await root(), ".omo/state/registry.sqlite");
  const registry = openRegistry(path);
  let stored: DeliveryRecord;
  try {
    const p = parent(registry);
    const report = message(registry, p, null, "result");
    stored = value(registry.post(p.durableSessionId, report));
    expect(stored).toEqual({ envelope: report, state: "posted", receipt: null });
    expect(value(registry.post(p.durableSessionId, report))).toEqual(stored);
    expect(registry.post(p.durableSessionId, { ...report, text: "changed" })).toMatchObject({
      ok: false,
      error: { code: "message_conflict" },
    });
    expect(registry.post("forged", report)).toMatchObject({
      ok: false,
      error: { code: "sender_unknown" },
    });
    expect(
      registry.post(p.durableSessionId, { ...report, id: "digest", snapshotDigest: "foreign" }),
    ).toMatchObject({ ok: false, error: { code: "digest_mismatch" } });
    expect(
      registry.post(p.durableSessionId, { ...report, id: "kind", kind: "instruction" }),
    ).toMatchObject({ ok: false, error: { code: "route_denied" } });
    expect(registry.claim(p.durableSessionId, report)).toMatchObject({
      ok: false,
      error: { code: "route_denied" },
    });
    expect(
      registry.finish(report.id, {
        kind: "error",
        error: { code: "fixture", message: "fixture", next_action: "none" },
      }).ok,
    ).toBe(false);
    expect(registry.uncertain(report.id, "no receipt").ok).toBe(false);
    expect(value(registry.list())).toHaveLength(1);
    expect(value(registry.postedReports({ projectId: "project" }))).toEqual([stored]);
    expect(value(registry.postedReports({ initiativeId: "initiative" }))).toEqual([]);
  } finally {
    registry.close();
  }
  const reopened = openRegistry(path);
  try {
    expect(value(reopened.delivery("result"))).toEqual(stored);
  } finally {
    reopened.close();
  }
});

async function world() {
  const control = await root();
  const dbPath = join(control, ".omo/state/registry.sqlite");
  const identities = new Map<string, RuntimeIdentity>();
  const prompts = new Map<string, Set<string>>();
  const workspaces = new Map<string, Workspace>();
  const groupingRequests = new Map<string, WorktreeGrouping | undefined>();
  const sends: Envelope[] = [];
  const launches: string[] = [];
  let sequence = 0;
  let promptFailure: "before" | "after" | null = null;
  let deliveryState: "accepted" | "uncertain" = "accepted";
  let rejectNext = false;
  const registry = <T>(operation: (registry: Registry) => T): T => {
    const opened = openRegistry(dbPath);
    try {
      return operation(opened);
    } finally {
      opened.close();
    }
  };
  const herdr: HerdrClient = {
    async subscribe() {
      return () => {};
    },
    async createWorkspace(cwd, label) {
      const workspace = {
        cwd,
        label,
        workspaceId: `ws-${++sequence}`,
        rootPaneId: `pane-${sequence}`,
      };
      workspaces.set(workspace.workspaceId, workspace);
      return workspace;
    },
    async createWorktree(checkout, label, grouping) {
      const workspace = await this.createWorkspace(checkout.path, label);
      groupingRequests.set(workspace.workspaceId, grouping);
      if (grouping === undefined) return workspace;
      const grouped = {
        ...workspace,
        groupHeadWorkspaceId:
          "head" in grouping ? workspace.workspaceId : grouping.parentWorkspaceId,
      };
      workspaces.set(workspace.workspaceId, grouped);
      return grouped;
    },
    async run(paneId, argv) {
      launches.push(paneId);
      const path = argv[argv.indexOf("--session") + 1];
      if (!path) throw new Error("Missing seed");
      const session = SessionManager.open(path);
      const binding = registry((r) => value(r.bySession(session.getSessionId())));
      identities.set(binding.id, {
        durableSessionId: binding.durableSessionId,
        sessionPath: path,
        cwd: binding.cwd,
        ...modelForRole(binding.assignment.role),
        extensionProtocol: 1,
      });
      await publishReadiness(control, {
        bindingId: binding.id,
        durableSessionId: binding.durableSessionId,
        sessionPath: path,
        cwd: binding.cwd,
        paneId,
      });
    },
    async snapshot() {
      return {
        focusedWorkspaceId: null,
        focusedTabId: null,
        focusedPaneId: null,
        workspaces: [...workspaces.values()],
        panes: [...workspaces.values()].map((w) => ({
          paneId: w.rootPaneId,
          workspaceId: w.workspaceId,
          revision: 1,
          sessionPath: null,
        })),
      };
    },
    async reportSession() {},
    async closeWorkspace(id) {
      workspaces.delete(id);
    },
    async removeWorktree() {},
    close() {},
  };
  const deps: OrchestratorDependencies = {
    openRegistry,
    createHerdrClient: () => herdr,
    resolveHerdrArtifact: async () => ({ artifactDir: "/fixture/herdr" }),
    ensureHost: async () => {},
    gitTip: async () => "base-commit",
    now: () => "2026-09-23",
    uuid: () => `id-${++sequence}`,
    terminateBinding: async (binding) => {
      identities.delete(binding.id);
    },
    prompt: async (binding, text) => {
      if (promptFailure === "before") throw new Error("not accepted");
      const history = prompts.get(binding.id) ?? new Set<string>();
      history.add(text);
      prompts.set(binding.id, history);
      if (promptFailure === "after") throw new Error("lost ACK");
    },
    attachBinding: async (binding): Promise<NativeSession> => {
      const identity = identities.get(binding.id);
      if (!identity) throw new Error("Exact native session absent");
      return {
        configure: async () => {},
        describe: async () => ({ ok: true, value: identity }),
        hasUserMessage: async (text) => prompts.get(binding.id)?.has(text) ?? false,
        send: async (envelope) =>
          registry((r) => {
            const claim = r.claim(binding.durableSessionId, envelope);
            if (!claim.ok) return claim;
            if (claim.value.disposition === "replay")
              return { ok: true, value: claim.value.record };
            if (claim.value.disposition === "in_progress")
              return {
                ok: false,
                error: {
                  code: "delivery_in_progress",
                  message: "inspect",
                  details: claim.value.record,
                },
              };
            if (claim.value.target === null) return { ok: true, value: claim.value.record };
            sends.push(envelope);
            if (rejectNext) {
              rejectNext = false;
              return r.finish(
                envelope.id,
                {
                  kind: "error",
                  error: {
                    code: "turn_conflict_before_delivery",
                    message: "Target not called",
                    next_action: "Retry same ID",
                  },
                },
                claim.value.nativeKey,
              );
            }
            return deliveryState === "uncertain"
              ? r.uncertain(envelope.id, "lost ACK", claim.value.nativeKey)
              : r.finish(
                  envelope.id,
                  {
                    kind: "ok",
                    thread_id: claim.value.target.durableSessionId,
                    message_seq: sends.length,
                    deduplicated: false,
                    delivery: { kind: "started", turn_id: `turn-${sends.length}` },
                  },
                  claim.value.nativeKey,
                );
          }),
        onEvent: () => () => {},
        close: async () => {},
      };
    },
  };
  const orchestrator = new Orchestrator(control, "/fixture/herdr", deps);
  const digest = registry((r) => value(r.importScope(projectScope)).digest);
  const create = () =>
    orchestrator.createParent({
      scopeDigest: digest,
      designationId: "project-approval",
      projectId: "project",
      repo: control,
      base: "main",
      execute: true,
      fixture: true,
    });
  const createManager = async () => {
    const scopeDigest = registry((r) => value(r.importScope(managerScope)).digest);
    return value(
      await orchestrator.createSupervisor({
        scopeDigest,
        designationId: "manager-approval",
        initiativeId: "initiative",
        execute: true,
        fixture: true,
      }),
    ).binding;
  };
  return {
    control,
    orchestrator,
    registry,
    create,
    createManager,
    workspaces,
    groupingRequests,
    sends,
    launches,
    identities,
    prompts,
    failPrompt: (state: typeof promptFailure) => {
      promptFailure = state;
    },
    uncertainSend: () => {
      deliveryState = "uncertain";
    },
    rejectNextSend: () => {
      rejectNext = true;
    },
  };
}

test.each(["reconcile", "close"] as const)(
  "known workspace identity survives display-name changes: %s",
  async (action) => {
    const w = await world();
    const parent = value(await w.create()).binding;
    if (parent.workspaceId === null) throw new Error("Missing parent workspace");
    const workspace = w.workspaces.get(parent.workspaceId);
    if (!workspace) throw new Error("Missing parent snapshot");
    w.workspaces.set(parent.workspaceId, { ...workspace, label: "human-chosen-project-label" });
    const launchCount = w.launches.length;
    const prompts = new Map([...w.prompts].map(([id, values]) => [id, new Set(values)]));
    const result =
      action === "reconcile"
        ? await w.orchestrator.reconcile({ projectId: "project" })
        : await w.orchestrator.close(parent.id);
    expect(result.ok).toBe(true);
    const current = w.registry((registry) => value(registry.get(parent.id)));
    expect(current.launchState).toBe(action === "close" ? "closed" : "ready");
    expect(current.durableSessionId).toBe(parent.durableSessionId);
    expect(current.checkout).toEqual(parent.checkout);
    expect(w.launches).toHaveLength(launchCount);
    expect(w.prompts).toEqual(prompts);
  },
);

test("new parent heads its group and child placement follows the actual parent workspace", async () => {
  const w = await world();
  const parent = value(await w.create()).binding;
  if (parent.workspaceId === null) throw new Error("Missing parent workspace");
  expect(w.groupingRequests.get(parent.workspaceId)).toEqual({ head: true });
  const child = value(
    await w.orchestrator.createChild({ parentId: parent.id, issueId: "issue" }),
  ).binding;
  if (child.workspaceId === null) throw new Error("Missing child workspace");
  expect(w.groupingRequests.get(child.workspaceId)).toEqual({
    parentWorkspaceId: parent.workspaceId,
  });
  expect(w.workspaces.get(child.workspaceId)?.groupHeadWorkspaceId).toBe(parent.workspaceId);
});

test.each(["missing", "cwd", "child"] as const)(
  "refuses a mismatched parent workspace before reserving a child: %s",
  async (caseName) => {
    const w = await world();
    const parent = value(await w.create()).binding;
    if (parent.workspaceId === null) throw new Error("Missing parent workspace");
    const workspace = w.workspaces.get(parent.workspaceId);
    if (!workspace) throw new Error("Missing parent snapshot");
    if (caseName === "missing") w.workspaces.delete(parent.workspaceId);
    else
      w.workspaces.set(
        parent.workspaceId,
        caseName === "cwd"
          ? { ...workspace, cwd: "/unrelated" }
          : { ...workspace, groupHeadWorkspaceId: "another-parent" },
      );
    expect(
      await w.orchestrator.createChild({ parentId: parent.id, issueId: "issue" }),
    ).toMatchObject({ ok: false, error: { code: "owner_unavailable" } });
    expect(w.registry((registry) => value(registry.list()))).toEqual([parent]);
    expect(w.groupingRequests.size).toBe(1);
  },
);

test("children of existing legacy parents retain their existing layout", async () => {
  const w = await world();
  const parent = value(await w.create()).binding;
  if (parent.workspaceId === null) throw new Error("Missing parent workspace");
  const current = w.workspaces.get(parent.workspaceId);
  if (!current) throw new Error("Missing parent workspace snapshot");
  const legacy = { ...current };
  delete legacy.groupHeadWorkspaceId;
  w.workspaces.set(parent.workspaceId, legacy);
  const child = value(
    await w.orchestrator.createChild({ parentId: parent.id, issueId: "issue" }),
  ).binding;
  if (child.workspaceId === null) throw new Error("Missing child workspace");
  expect(w.groupingRequests.get(child.workspaceId)).toBeUndefined();
  expect(w.workspaces.get(parent.workspaceId)).toEqual(legacy);
});

test("no-supervisor creation through child instruction, report and user inbox uses the real registry", async () => {
  const w = await world();
  const cli = async (args: string[]): Promise<unknown> => {
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "../src/cli.ts"),
        "--root",
        w.control,
        ...args,
        "--json",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ code, err }).toEqual({ code: 0, err: "" });
    return JSON.parse(out);
  };
  const p = value(await w.create()).binding;
  expect(p).toMatchObject({
    assignment: { initiativeId: null, ownerBindingId: null },
    launchState: "ready",
  });
  expect(w.prompts.get(p.id)?.size).toBe(1);
  expect(w.registry((r) => value(r.list())).map((b) => b.assignment.role)).toEqual(["parent"]);
  const c = value(await w.orchestrator.createChild({ parentId: p.id, issueId: "issue" })).binding;
  expect(c.checkout?.baseBranch).toBe(p.checkout?.branch);
  expect(c.checkout?.originalRepoRoot).toBe(p.checkout?.originalRepoRoot);
  expect(
    await w.orchestrator.send({
      fromId: p.id,
      toId: c.id,
      messageId: "packet",
      kind: "instruction",
      text: "issue packet",
    }),
  ).toMatchObject({ ok: true, value: { state: "accepted" } });
  expect(
    await w.orchestrator.report({
      fromId: c.id,
      messageId: "child-result",
      outcome: "completed",
      text: "verified",
      evidence: [],
    }),
  ).toMatchObject({ ok: true, value: { state: "accepted", envelope: { toBindingId: p.id } } });
  const input = {
    fromId: p.id,
    messageId: "parent-result",
    outcome: "completed" as const,
    text: "integrated",
    evidence: ["/fixture/evidence"],
  };
  const report = deliveryRecordSchema.parse(value(await w.orchestrator.report(input)));
  expect(report).toMatchObject({ state: "posted", receipt: null, envelope: { toBindingId: null } });
  expect(value(w.orchestrator.reports({ projectId: "project" }))).toEqual([report]);
  expect(value(w.orchestrator.status({ projectId: "project" }))).toHaveLength(2);
  const m = await w.createManager();
  const sendsBefore = w.sends.length;
  expect(await cli(["parent", "link", "--parent", p.id, "--supervisor", m.id])).toMatchObject({
    ok: true,
    value: {
      id: p.id,
      designationId: p.designationId,
      assignment: { ownerBindingId: m.id, initiativeId: null },
    },
  });
  expect(value(await w.orchestrator.report(input))).toEqual(report);
  expect(await w.orchestrator.report({ ...input, text: "changed" })).toMatchObject({
    ok: false,
    error: { code: "message_conflict" },
  });
  expect(w.sends).toHaveLength(sendsBefore);
  expect(value(await w.orchestrator.reconcile({ projectId: "project" })).bindings).toHaveLength(2);
  expect(w.launches).toHaveLength(3);
  expect(await cli(["reports", "--project", "project"])).toEqual({ ok: true, value: [report] });
  expect(await cli(["parent", "unlink", "--parent", p.id])).toMatchObject({
    ok: true,
    value: { id: p.id, designationId: p.designationId, assignment: { ownerBindingId: null } },
  });
  expect(w.registry((r) => value(r.get(p.id)))).toEqual(p);
  expect(w.sends).toHaveLength(sendsBefore);
});

test.each([false, true])(
  "pre-delivery report rejection rechecks its original route (unlink=%s)",
  async (unlink) => {
    const w = await world();
    const p = value(await w.create()).binding;
    const m = await w.createManager();
    value(w.orchestrator.linkParent(p.id, m.id));
    const input = {
      fromId: p.id,
      messageId: "retry-report",
      outcome: "completed" as const,
      text: "verified result",
      evidence: [],
    };
    w.rejectNextSend();
    const rejected = deliveryRecordSchema.parse(value(await w.orchestrator.report(input)));
    expect(rejected.state).toBe("rejected");
    expect(rejected.attempts).toHaveLength(1);
    if (unlink) value(w.orchestrator.unlinkParent(p.id));
    const recovered = await w.orchestrator.report(input);
    if (unlink) {
      expect(recovered).toMatchObject({ ok: false, error: { code: "foreign_designation" } });
      expect(w.sends).toHaveLength(1);
      expect(w.registry((r) => value(r.delivery(input.messageId)))).toEqual(rejected);
    } else {
      const accepted = deliveryRecordSchema.parse(value(recovered));
      expect(accepted).toMatchObject({ state: "accepted", envelope: { toBindingId: m.id } });
      expect(accepted.attempts).toHaveLength(2);
      expect(accepted.attempts?.[0]).toEqual(rejected.attempts?.[0]);
      expect(accepted.attempts?.[1]?.nativeKey).not.toBe(accepted.attempts?.[0]?.nativeKey);
      expect(value(await w.orchestrator.report(input))).toEqual(accepted);
      expect(w.sends).toHaveLength(2);
    }
    expect(value(w.orchestrator.reports())).toEqual([]);
  },
);

test.each(["accepted", "uncertain"] as const)(
  "%s reports keep their original recipient across unlink, close and replay",
  async (state) => {
    const w = await world();
    const p = value(await w.create()).binding;
    const m = await w.createManager();
    value(w.orchestrator.linkParent(p.id, m.id));
    if (state === "uncertain") w.uncertainSend();
    const input = {
      fromId: p.id,
      messageId: "native-result",
      outcome: "completed" as const,
      text: "result",
      evidence: [],
    };
    expect(await w.orchestrator.report(input)).toMatchObject({ ok: true, value: { state } });
    const count = w.sends.length;
    value(w.orchestrator.unlinkParent(p.id));
    value(await w.orchestrator.close(m.id));
    const replay = await w.orchestrator.report(input);
    expect(replay).toMatchObject(
      state === "accepted"
        ? { ok: true, value: { state, envelope: { toBindingId: m.id } } }
        : { ok: false, error: { code: "delivery_in_progress" } },
    );
    expect(await w.orchestrator.report({ ...input, toUser: true })).toMatchObject({
      ok: false,
      error: { code: "message_conflict" },
    });
    expect(w.sends).toHaveLength(count);
    expect(value(w.orchestrator.reports({}))).toEqual([]);
  },
);

test("manager pause, loss and close are independent of parent pause and local user reporting", async () => {
  const w = await world();
  const p = value(await w.create()).binding;
  const m = await w.createManager();
  value(w.orchestrator.linkParent(p.id, m.id));
  const report = (id: string, toUser = false) =>
    w.orchestrator.report({
      fromId: p.id,
      messageId: id,
      outcome: "blocked",
      text: "user decision?",
      evidence: [],
      toUser,
    });
  value(w.orchestrator.setPaused(m.id, true));
  expect(await report("manager-paused")).toMatchObject({
    ok: false,
    error: { code: "contact_paused" },
  });
  expect(await report("question", true)).toMatchObject({ ok: true, value: { state: "posted" } });
  const c = value(await w.orchestrator.createChild({ parentId: p.id, issueId: "issue" })).binding;
  value(w.orchestrator.setPaused(p.id, true));
  expect(await report("parent-paused", true)).toMatchObject({
    ok: false,
    error: { code: "contact_paused" },
  });
  expect(
    await w.orchestrator.report({
      fromId: c.id,
      messageId: "paused-parent-result",
      outcome: "failed",
      text: "failure",
      evidence: [],
    }),
  ).toMatchObject({ ok: false, error: { code: "contact_paused" } });
  value(w.orchestrator.setPaused(p.id, false));
  value(w.orchestrator.setPaused(m.id, false));
  w.identities.delete(m.id);
  expect(await report("missing-manager", true)).toMatchObject({
    ok: true,
    value: { state: "posted" },
  });
  w.registry((r) => value(r.setLaunchState(m.id, "uncertain")));
  expect(await report("known-missing")).toMatchObject({ ok: true, value: { state: "posted" } });
  value(await w.orchestrator.close(m.id));
  expect(await report("closed-manager")).toMatchObject({ ok: true, value: { state: "posted" } });
  expect(value(w.orchestrator.status({ projectId: "project" })).map((b) => b.launchState)).toEqual([
    "ready",
    "ready",
  ]);
  value(w.orchestrator.unlinkParent(p.id));
  expect(w.launches).toHaveLength(3);
});

test.each(["before", "after"] as const)(
  "standalone initialization lost ACK (%s) reconciles without a second prompt",
  async (when) => {
    const w = await world();
    w.failPrompt(when);
    expect(await w.create()).toMatchObject({ ok: false, error: { code: "brief_uncertain" } });
    w.failPrompt(null);
    const result = await w.orchestrator.reconcile({ projectId: "project" });
    expect(result.ok).toBe(when === "after");
    expect(w.launches).toHaveLength(1);
    const p = value(w.orchestrator.status())[0];
    if (!p) throw new Error("No parent");
    expect(w.prompts.get(p.id)?.size ?? 0).toBe(when === "after" ? 1 : 0);
  },
);

test("legacy schema rows and receipts survive reopen and optional unlink byte-for-byte", async () => {
  const path = join(await root(), ".omo/state/registry.sqlite");
  const fixture = z
    .strictObject({
      digest: z.string(),
      snapshot: scopeSnapshotSchema,
      designation: designationSchema,
      bindings: z.array(bindingSchema),
      deliveries: z.array(deliveryRecordSchema),
    })
    .parse(await Bun.file(join(import.meta.dir, "fixtures/legacy-registry.json")).json());
  const db = new Database(path);
  db.run("CREATE TABLE scopes (digest TEXT PRIMARY KEY, json TEXT NOT NULL)");
  db.run(
    "CREATE TABLE designations (id TEXT PRIMARY KEY, scope_digest TEXT NOT NULL REFERENCES scopes(digest), json TEXT NOT NULL)",
  );
  db.run(
    "CREATE TABLE bindings (id TEXT PRIMARY KEY, designation_id TEXT NOT NULL REFERENCES designations(id), durable_session_id TEXT NOT NULL UNIQUE, ownership_key TEXT NOT NULL, launch_state TEXT NOT NULL, json TEXT NOT NULL)",
  );
  db.run(
    "CREATE UNIQUE INDEX bindings_live_owner ON bindings(ownership_key) WHERE launch_state <> 'closed'",
  );
  db.run(
    "CREATE TABLE deliveries (message_id TEXT PRIMARY KEY, envelope_json TEXT NOT NULL, state TEXT NOT NULL, receipt_json TEXT, uncertain_reason TEXT)",
  );
  // This frozen fixture predates nullable scope/owners and local posted reports.
  db.query("INSERT INTO scopes VALUES (?, ?)").run(
    fixture.digest,
    JSON.stringify(fixture.snapshot),
  );
  db.query("INSERT INTO designations VALUES (?, ?, ?)").run(
    fixture.designation.id,
    fixture.digest,
    JSON.stringify(fixture.designation),
  );
  for (const b of fixture.bindings)
    db.query("INSERT INTO bindings VALUES (?, ?, ?, ?, ?, ?)").run(
      b.id,
      b.designationId,
      b.durableSessionId,
      b.assignment.role === "supervisor"
        ? "initiative:legacy-initiative"
        : "project:legacy-project",
      b.launchState,
      JSON.stringify(b),
    );
  for (const d of fixture.deliveries)
    db.query("INSERT INTO deliveries VALUES (?, ?, ?, ?, ?)").run(
      d.envelope.id,
      JSON.stringify(d.envelope),
      d.state,
      d.receipt === null ? null : JSON.stringify(d.receipt),
      d.state === "uncertain" ? "lost ACK" : null,
    );
  const before = {
    scopes: db.query("SELECT * FROM scopes").all(),
    designations: db.query("SELECT * FROM designations").all(),
    bindings: db.query("SELECT * FROM bindings").all(),
    deliveries: db.query("SELECT * FROM deliveries").all(),
  };
  db.close();
  const registry = openRegistry(path);
  try {
    expect(value(registry.list())).toEqual(fixture.bindings);
    for (const delivery of fixture.deliveries)
      expect(value(registry.delivery(delivery.envelope.id))).toEqual(delivery);
    expect(value(registry.postedReports({}))).toEqual([]);
  } finally {
    registry.close();
  }
  const check = new Database(path, { readonly: true });
  try {
    expect({
      scopes: check.query("SELECT * FROM scopes").all(),
      designations: check.query("SELECT * FROM designations").all(),
      bindings: check.query("SELECT * FROM bindings").all(),
      deliveries: check.query("SELECT * FROM deliveries").all(),
    }).toEqual(before);
  } finally {
    check.close();
  }
  const reopened = openRegistry(path);
  try {
    const previous = value(reopened.get("legacy-parent"));
    if (previous.assignment.role !== "parent") throw new Error("Expected legacy parent");
    expect(value(reopened.setOwner(previous.id, null))).toEqual({
      ...previous,
      assignment: { ...previous.assignment, ownerBindingId: null },
    });
    for (const delivery of fixture.deliveries)
      expect(value(reopened.delivery(delivery.envelope.id))).toEqual(delivery);
  } finally {
    reopened.close();
  }
});
