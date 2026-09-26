import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/cli";
import type {
  Binding,
  Envelope,
  Registry,
  ReserveInput,
  Result,
  ScopeSnapshot,
} from "../../src/core/contracts";
import { modelForRole } from "../../src/core/policy";
import { openRegistry } from "../../src/core/store";
import type { HerdrClient, Workspace } from "../../src/herdr";
import { roleLabel } from "../../src/linear";
import { Orchestrator } from "../../src/orchestrator";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}
const scope: ScopeSnapshot = {
  version: 1,
  source: "fixture",
  initiative: null,
  decisionRefs: [],
  projects: [
    {
      project: { id: "p", url: "linear://p", revision: "1" },
      issues: [{ id: "i", url: "linear://i", revision: "1" }],
    },
  ],
};
async function world() {
  const root = await mkdtemp(join(tmpdir(), "gate-t17-world-"));
  roots.push(root);
  await mkdir(join(root, ".omo/state"), { recursive: true });
  const path = join(root, ".omo/state/registry.sqlite");
  const registry = openRegistry(path);
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
  const base = {
    designation,
    snapshot: scope,
    cwd: root,
    checkout: null,
    herdrSocket: "/fake/herdr",
    omoSocket: "/fake/omo",
  };
  const parent = value(
    registry.reserve({
      ...base,
      bindingId: "parent",
      durableSessionId: "s-parent",
      assignment: { role: "parent", initiativeId: null, projectId: "p", ownerBindingId: null },
    }),
  );
  const assignment = {
    role: "child",
    initiativeId: null,
    projectId: "p",
    issueId: "i",
    ownerBindingId: parent.id,
  } as const;
  const input = (id: string): ReserveInput => ({
    ...base,
    bindingId: id,
    durableSessionId: `s-${id}`,
    assignment,
    checkout: {
      originalRepoRoot: root,
      path: root,
      branch: "issue",
      baseBranch: "main",
      baseCommit: "commit",
    },
  });
  const workspaces = new Map<string, Workspace>();
  const paneSessions = new Map<string, string>();
  const engines = new Set<string>();
  const events: string[] = [];
  let listener: ((event: unknown) => void) | undefined;
  let fault:
    | "none"
    | "after-quit"
    | "after-terminate"
    | "before-workspace"
    | "after-workspace"
    | "before-finish"
    | "after-finish" = "none";
  const unused = async (): Promise<never> => {
    throw new Error("Unexpected launch operation");
  };
  const herdr: HerdrClient = {
    createWorkspace: unused,
    createWorktree: unused,
    createTab: unused,
    renameTab: unused,
    run: unused,
    reportSession: unused,
    removeWorktree: unused,
    subscribe: async (cb) => {
      events.push("subscribe");
      listener = cb;
      return () => {
        listener = undefined;
      };
    },
    sendKeys: async (pane, text, keys) => {
      expect(listener).toBeDefined();
      expect([text, keys]).toEqual(["/quit", ["Enter"]]);
      events.push(`quit:${pane}`);
      paneSessions.delete(pane);
      listener?.({ event: "pane.updated", data: { pane: { pane_id: pane, agent_session: null } } });
      if (fault === "after-quit") throw new Error(fault);
    },
    snapshot: async () => ({
      focusedWorkspaceId: null,
      focusedTabId: null,
      focusedPaneId: null,
      workspaces: [...workspaces.values()],
      panes: [...paneSessions].map(([paneId, sessionPath]) => ({
        paneId,
        sessionPath,
        workspaceId: paneId.split(":")[0] ?? "",
        revision: 1,
      })),
    }),
    closeWorkspace: async (id) => {
      if (fault === "before-workspace") throw new Error(fault);
      expect(engines.has("execute")).toBe(false);
      events.push(`workspace:${id}`);
      workspaces.delete(id);
      if (fault === "after-workspace") throw new Error(fault);
    },
    close: () => {
      events.push("disconnect");
    },
  };
  const dependencies = {
    attachBinding: unused,
    prompt: unused,
    gitTip: async () => "commit",
    now: () => "now",
    uuid: () => "unused-id",
    openRegistry: (file: string, options?: Parameters<typeof openRegistry>[1]): Registry => {
      const opened = openRegistry(file, options);
      return {
        ...opened,
        finishClose: (id) => {
          if (fault === "before-finish") throw new Error(fault);
          const result = opened.finishClose(id);
          if (fault === "after-finish") throw new Error(fault);
          return result;
        },
      };
    },
    createHerdrClient: () => herdr,
    resolveHerdrArtifact: async () => ({ artifactDir: join(root, ".managed-herdr") }),
    ensureHost: async () => {},
    terminateBinding: async (binding: Binding) => {
      if (binding.paneId !== null && paneSessions.has(binding.paneId))
        throw new Error("TUI remains attached");
      events.push(`terminate:${binding.id}`);
      engines.delete(binding.id);
      if (fault === "after-terminate") throw new Error(fault);
    },
  };
  const orchestrator = new Orchestrator(root, "/fake/herdr", dependencies);
  const ready = (binding: Binding, ws: string, pane: string) => {
    const sessionPath = join(root, `${binding.id}.jsonl`);
    value(registry.provision(binding.id, ws, pane));
    value(registry.observeSession(binding.id, sessionPath));
    value(
      registry.activate(binding.id, {
        durableSessionId: binding.durableSessionId,
        sessionPath,
        cwd: binding.cwd,
        ...modelForRole(binding.assignment.role),
        extensionProtocol: 2,
      }),
    );
    value(registry.beginInitialization(binding.id, "fixture"));
    value(registry.finishInitialization(binding.id, "accepted"));
    workspaces.set(ws, {
      workspaceId: ws,
      cwd: root,
      rootPaneId: pane,
      label: roleLabel(binding.assignment, scope, binding.id),
    });
    paneSessions.set(pane, sessionPath);
    engines.add(binding.id);
    return value(registry.get(binding.id));
  };
  ready(parent, "parentws", "parentws:p");
  const reserve = (id: string, stage: "plan" | "direct" | null = "plan") => {
    const binding = value(registry.reserve(input(id)));
    if (stage !== null) value(registry.recordStage(id, "i", stage, 0, null));
    return binding;
  };
  const planned = (provision = true) => {
    const plan = ready(reserve("plan"), "childws", "childws:plan");
    value(
      registry.recordHandoff(plan.id, {
        planPath: join(root, "plan.md"),
        planSha256: "a".repeat(64),
        head: "commit",
        completedAt: "now",
      }),
    );
    paneSessions.delete("childws:plan");
    engines.delete("plan");
    const execute = value(registry.successorReservation("plan", input("execute"), "execute"));
    if (provision) ready(execute, "childws", "childws:execute");
    return { plan: value(registry.get("plan")), execute: value(registry.get("execute")) };
  };
  return {
    root,
    path,
    registry,
    parent,
    input,
    reserve,
    ready,
    planned,
    workspaces,
    paneSessions,
    engines,
    events,
    herdr,
    orchestrator,
    dependencies,
    setFault: (f: typeof fault) => {
      fault = f;
    },
    cleanup: () => registry.close(),
  };
}

test.each(["plan", "execute"])(
  "status/close: close by %s stops live stage before workspace and unblocks parent",
  async (id) => {
    const w = await world();
    try {
      w.planned();
      expect(await w.orchestrator.close("parent")).toMatchObject({
        ok: false,
        error: { code: "children_active" },
      });
      value(await w.orchestrator.close(id));
      expect(w.events.indexOf("quit:childws:execute")).toBeLessThan(
        w.events.indexOf("terminate:execute"),
      );
      expect(w.events.indexOf("terminate:execute")).toBeLessThan(
        w.events.indexOf("workspace:childws"),
      );
      expect(value(w.registry.lineageFor("plan")).stages.map((s) => s.launchState)).toEqual([
        "closed",
        "closed",
      ]);
      w.paneSessions.delete("parentws:p");
      value(await w.orchestrator.close("parent"));
      value(await w.orchestrator.close(id));
      expect(w.events.filter((e) => e === "workspace:childws")).toHaveLength(1);
    } finally {
      w.cleanup();
    }
  },
);

test("status/close: repeated interruptions finish closure with exactly one workspace removal", async () => {
  const w = await world();
  try {
    w.planned();
    for (const fault of [
      "after-quit",
      "after-terminate",
      "before-workspace",
      "after-workspace",
      "before-finish",
      "after-finish",
    ] as const) {
      w.setFault(fault);
      expect(await w.orchestrator.close("plan")).toMatchObject({
        ok: false,
        error: { code: "runtime_unavailable" },
      });
      expect(
        value(w.registry.list()).filter(
          (b) => b.assignment.role === "child" && b.launchState !== "closed",
        ).length,
      ).toBeLessThanOrEqual(1);
    }
    w.setFault("none");
    value(await w.orchestrator.close("plan"));
    expect(value(w.registry.get("execute")).launchState).toBe("closed");
    expect(w.events.filter((e) => e === "workspace:childws")).toHaveLength(1);
    expect(w.events.filter((e) => e === "quit:childws:execute")).toHaveLength(1);
  } finally {
    w.cleanup();
  }
});

test("status/close: stale workspace cwd is refused without terminating or closing it", async () => {
  const w = await world();
  try {
    w.planned();
    w.workspaces.set("childws", {
      workspaceId: "childws",
      cwd: "/foreign",
      rootPaneId: "childws:execute",
    });
    expect(await w.orchestrator.close("plan")).toMatchObject({
      ok: false,
      error: { code: "identity_mismatch" },
    });
    expect(w.events).toEqual(["disconnect"]);
    expect(w.engines.has("execute")).toBe(true);
  } finally {
    w.cleanup();
  }
});

test.each([false, true])(
  "status/close: unprovisioned successor closes the workspace recorded on its plan member (confirm=%s)",
  async (confirm) => {
    const w = await world();
    try {
      w.planned(false);
      const result = await w.orchestrator.close("plan", confirm);
      expect(result).toMatchObject({ ok: true, value: { launchState: "closed" } });
      expect(w.workspaces.has("childws")).toBe(false);
      expect(value(w.registry.lineageFor("plan")).stages.map((stage) => stage.launchState)).toEqual(
        ["closed", "closed"],
      );
      expect(w.events.filter((event) => event === "workspace:childws")).toHaveLength(1);
    } finally {
      w.cleanup();
    }
  },
);

test.each([false, true])(
  "status/close: lineage reservation discovers labeled workspace before provision (confirm=%s)",
  async (confirm) => {
    const w = await world();
    try {
      const child = w.reserve("child", "direct");
      w.workspaces.set("orphan", {
        workspaceId: "orphan",
        cwd: w.root,
        rootPaneId: "orphan:p",
        label: roleLabel(child.assignment, scope, child.id),
      });
      const result = await w.orchestrator.close(child.id, confirm);
      expect(result).toMatchObject({ ok: true, value: { launchState: "closed" } });
      expect(w.workspaces.has("orphan")).toBe(false);
      expect(w.events.filter((event) => event === "workspace:orphan")).toHaveLength(1);
    } finally {
      w.cleanup();
    }
  },
);

test("status/close: old generation close leaves new generation live, and new generation can close", async () => {
  const w = await world();
  try {
    w.planned();
    value(await w.orchestrator.close("plan"));
    const fresh = w.ready(w.reserve("fresh", "direct"), "freshws", "freshws:p");
    value(await w.orchestrator.close("execute"));
    expect(w.engines.has("fresh")).toBe(true);
    expect(value(w.orchestrator.status()).find((b) => b.id === fresh.id)?.stageBindings).toEqual([
      { bindingId: fresh.id, stage: "direct", launchState: "ready" },
    ]);
    value(await w.orchestrator.close(fresh.id));
    expect(w.workspaces.has("freshws")).toBe(false);
  } finally {
    w.cleanup();
  }
});

test("status/close: legacy reservation and confirm-absent retain their original behavior", async () => {
  const w = await world();
  try {
    const child = w.reserve("legacy", null);
    expect(value(w.orchestrator.status()).find((b) => b.id === child.id)).toEqual(child);
    w.workspaces.set("legacyws", {
      workspaceId: "legacyws",
      cwd: w.root,
      rootPaneId: "legacyws:p",
      label: `omo-child-${child.id}`,
    });
    value(await w.orchestrator.close(child.id));
    expect(w.workspaces.has("legacyws")).toBe(false);
    const absent = w.reserve("absent", "direct");
    expect(await w.orchestrator.close(absent.id)).toMatchObject({
      ok: false,
      error: { code: "closure_uncertain" },
    });
    value(await w.orchestrator.close(absent.id, true));
  } finally {
    w.cleanup();
  }
});

test("status/close: status counts unanswered sent/received records, excludes answers and unrelated inbox questions", async () => {
  const w = await world();
  try {
    w.planned();
    const execute = value(w.registry.get("execute"));
    const question = (id: string, from: Binding, to: string | null): Envelope => ({
      version: 1,
      id: `question:${from.id}:${id}`,
      fromBindingId: from.id,
      toBindingId: to,
      designationId: from.designationId,
      snapshotDigest: value(w.registry.designation(from.designationId)).snapshotDigest,
      kind: "question",
      text: id,
      outcome: null,
      evidence: [],
      question: {
        questions: [{ id: "x", question: "x?", options: [{ label: "x" }], multiSelect: false }],
        escalates: null,
      },
    });
    for (const id of ["open", "answered"]) {
      const envelope = question(id, execute, "parent");
      value(w.registry.claim(execute.durableSessionId, envelope));
      value(
        w.registry.finish(envelope.id, {
          kind: "ok",
          thread_id: w.parent.durableSessionId,
          message_seq: 1,
          deduplicated: false,
          delivery: { kind: "started", turn_id: "turn" },
        }),
      );
      if (id === "answered")
        value(
          w.registry.claim(w.parent.durableSessionId, {
            ...envelope,
            id: `answer:${envelope.id}`,
            kind: "answer",
            fromBindingId: "parent",
            toBindingId: execute.id,
            question: undefined,
            answer: {
              questionId: envelope.id,
              answers: { x: { selected: ["x"] } },
              unanswered: [],
            },
          }),
        );
    }
    value(w.registry.post(w.parent.durableSessionId, question("inbox", w.parent, null)));
    // The authorization matrix currently forbids parent->child questions. Seed a stored historical inbound question to check the status read projection independently of that routing rule.
    const db = new Database(w.path);
    try {
      const q = question("inbound", w.parent, execute.id);
      db.query(
        "INSERT INTO deliveries(message_id,envelope_json,state,receipt_json) VALUES (?,?,'sending',NULL)",
      ).run(q.id, JSON.stringify(q));
    } finally {
      db.close();
    }
    expect(value(w.orchestrator.status()).find((b) => b.id === execute.id)).toMatchObject({
      mode: "planned",
      stage: "execute",
      openQuestions: 2,
    });
    const proc = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "../../src/cli.ts"),
        "--root",
        w.root,
        "status",
        "--json",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [exit, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect([exit, err]).toEqual([0, ""]);
    expect(JSON.parse(out).value.find((b: { id: string }) => b.id === execute.id)).toMatchObject({
      mode: "planned",
      stage: "execute",
      openQuestions: 2,
    });
  } finally {
    w.cleanup();
  }
});

test("status/close: actual CLI close returns success but must remove a discovered unprovisioned workspace", async () => {
  const w = await world();
  try {
    w.planned(false);
    const code = await runCli(
      ["--root", w.root, "close", "--binding", "plan", "--confirm-absent", "--json"],
      w.dependencies,
    );

    expect(code).toBe(0);
    expect(w.workspaces.has("childws")).toBe(false);
  } finally {
    w.cleanup();
  }
});

test("status/close: close preserves dirty checkout contents", async () => {
  const w = await world();
  try {
    w.planned();
    expect(Bun.spawnSync(["git", "init", "-q", w.root]).exitCode).toBe(0);
    const file = join(w.root, "dirty.txt");
    await Bun.write(file, "uncommitted changes\n");
    expect(Bun.spawnSync(["git", "-C", w.root, "add", "-N", "dirty.txt"]).exitCode).toBe(0);
    const before = Bun.spawnSync([
      "git",
      "-C",
      w.root,
      "diff",
      "--",
      "dirty.txt",
    ]).stdout.toString();
    expect(before).toContain("+uncommitted changes");
    value(await w.orchestrator.close("plan"));
    expect(Bun.spawnSync(["git", "-C", w.root, "diff", "--", "dirty.txt"]).stdout.toString()).toBe(
      before,
    );
  } finally {
    w.cleanup();
  }
});
