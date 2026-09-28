import { Database } from "bun:sqlite";
import { afterEach, expect, spyOn, test } from "bun:test";
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
import { NativeSessionAbsentError } from "../../src/transport";

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
    focusWorkspace: unused,
    focusPane: unused,
    paneContainsProcess: unused,
    run: unused,
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

test.each(["stage", "close"] as const)(
  "%s waits for a live omo pane with no session path to exit",
  async (operation) => {
    const w = await world();
    const quit = Promise.withResolvers<void>();
    const exit = Promise.withResolvers<void>();
    const timeout = setTimeout(() => quit.reject(new Error("Expected /quit")), 2000);
    try {
      if (operation === "stage") {
        const db = new Database(join(w.root, ".omo/state/registry.sqlite"));
        try {
          db.query(
            "UPDATE bindings SET json = json_set(json, '$.checkout', json(?)) WHERE id = 'parent'",
          ).run(
            JSON.stringify({
              kind: "owned-clone",
              originalRepoRoot: w.root,
              path: w.root,
              branch: "parent",
              baseBranch: "main",
              baseCommit: "commit",
            }),
          );
        } finally {
          db.close();
        }
      }
      const plan = w.ready(w.reserve("plan"), "childws", "childws:plan");
      value(
        w.registry.recordHandoff(plan.id, {
          planPath: join(w.root, "plan.md"),
          planSha256: "a".repeat(64),
          head: "commit",
          completedAt: "now",
        }),
      );
      if (operation === "stage") {
        const planPath = join(w.root, "plan.md");
        await Bun.write(planPath, "fixture plan");
        const db = new Database(join(w.root, ".omo/state/registry.sqlite"));
        try {
          const handoff = db
            .query<{ handoff_json: string }, []>(
              "SELECT handoff_json FROM stage_lineage WHERE binding_id = 'plan'",
            )
            .get();
          if (handoff === null) throw new Error("Missing fixture handoff");
          const parsed = JSON.parse(handoff.handoff_json);
          parsed.planSha256 = new Bun.CryptoHasher("sha256").update("fixture plan").digest("hex");
          parsed.completionReportId = "fixture-plan-report";
          db.query("UPDATE stage_lineage SET handoff_json = ? WHERE binding_id = 'plan'").run(
            JSON.stringify(parsed),
          );
          db.query(
            "INSERT INTO deliveries (message_id, envelope_json, state, receipt_json) VALUES (?, ?, 'accepted', ?)",
          ).run(
            "fixture-plan-report",
            JSON.stringify({
              version: 1,
              id: "fixture-plan-report",
              fromBindingId: plan.id,
              toBindingId: "parent",
              designationId: plan.designationId,
              snapshotDigest: value(w.registry.designation(plan.designationId)).snapshotDigest,
              kind: "report",
              text: "done",
              outcome: "completed",
              evidence: [planPath],
            }),
            JSON.stringify({
              kind: "ok",
              thread_id: "s-parent",
              message_seq: 1,
              deduplicated: false,
              delivery: { kind: "started", turn_id: "fixture" },
            }),
          );
        } finally {
          db.close();
        }
      }
      const snapshot = w.herdr.snapshot;
      w.herdr.snapshot = async () => ({
        ...(await snapshot()),
        panes: [
          {
            paneId: "childws:plan",
            workspaceId: "childws",
            revision: 1,
            sessionPath: null,
            agent: "omo",
          },
        ],
      });
      let listener: ((event: unknown) => void) | undefined;
      w.herdr.subscribe = async (cb) => {
        listener = cb;
        return () => {
          listener = undefined;
        };
      };
      w.herdr.sendKeys = async (pane, text, keys) => {
        expect([pane, text, keys]).toEqual(["childws:plan", "/quit", ["Enter"]]);
        w.events.push("quit");
        listener?.({
          event: "pane.updated",
          data: { pane: { pane_id: pane, agent: "omo", agent_session: null } },
        });
        quit.resolve();
      };
      const orchestrator = new Orchestrator(w.root, "/fake/herdr", {
        ...w.dependencies,
        attachBinding: async (binding) => ({
          configure: async () => {},
          hasUserMessage: async () => false,
          describe: async () => ({
            ok: true,
            value: {
              durableSessionId: binding.durableSessionId,
              sessionPath: binding.sessionPath ?? "",
              cwd: binding.cwd,
              ...modelForRole(binding.assignment.role),
              extensionProtocol: 2,
            },
          }),
          send: async () => {
            throw new Error("Unexpected send");
          },
          deliverUserAnswer: async () => {
            throw new Error("Unexpected answer");
          },
          onEvent: () => () => {},
          close: async () => {},
        }),
        terminateBinding: async () => {
          w.events.push("terminate");
          await exit.promise;
          throw new Error("Verified exit-before-terminate boundary");
        },
      });
      const pending =
        operation === "stage"
          ? orchestrator.stageStart({
              fromId: plan.id,
              parentId: "parent",
              stage: "execute",
              messageId: "start",
            })
          : orchestrator.close(plan.id);
      await Promise.race([
        quit.promise,
        pending.then((result) => {
          throw new Error(`Ended before quit: ${JSON.stringify(result)}`);
        }),
      ]);
      expect(w.events).not.toContain("terminate");
      listener?.({
        event: "pane_agent_detected",
        data: {
          type: "pane_agent_detected",
          pane_id: "childws:plan",
          agent: "omo",
          released: true,
          final_status: "idle",
        },
      });
      exit.resolve();
      expect(await pending).toMatchObject({
        ok: false,
        error: { code: "runtime_unavailable", details: "Verified exit-before-terminate boundary" },
      });
      expect(w.events.indexOf("quit")).toBeLessThan(w.events.indexOf("terminate"));
    } finally {
      clearTimeout(timeout);
      exit.resolve();
      w.cleanup();
    }
  },
);

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

test("status and close preserve storage_corrupt for a successor's malformed predecessor handoff", async () => {
  const w = await world();
  try {
    w.planned();
    const db = new Database(w.path);
    try {
      db.query("UPDATE stage_lineage SET handoff_json = ? WHERE binding_id = 'plan'").run(
        JSON.stringify({ head: 7 }),
      );
    } finally {
      db.close();
    }
    const corrupt = {
      ok: false,
      error: { code: "storage_corrupt", message: "Stored stage handoff is invalid" },
    };
    expect(w.orchestrator.status()).toMatchObject(corrupt);
    expect(await w.orchestrator.close("execute")).toMatchObject(corrupt);

    let output = "";
    const stdout = spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      expect(
        await runCli(["--root", w.root, "close", "--binding", "execute", "--json"], w.dependencies),
      ).toBe(2);
      expect(JSON.parse(output)).toMatchObject(corrupt);
    } finally {
      stdout.mockRestore();
    }
    expect(value(w.registry.get("execute")).launchState).toBe("ready");
  } finally {
    w.cleanup();
  }
});

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
      if (id === "answered") {
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
        // A claim alone is not delivery; only a native accepted receipt answers it.
        expect(value(w.orchestrator.status()).find((b) => b.id === execute.id)?.openQuestions).toBe(
          2,
        );
        value(
          w.registry.finish(`answer:${envelope.id}`, {
            kind: "ok",
            thread_id: execute.durableSessionId,
            message_seq: 2,
            deduplicated: false,
            delivery: { kind: "started", turn_id: "answer-turn" },
          }),
        );
      }
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

test("status is read-only while reconcile posts one host-loss notice and preserves runtime state", async () => {
  const w = await world();
  try {
    const child = w.ready(w.reserve("child", "direct"), "childws", "childws:p");
    const prompts: Array<{ bindingId: string; text: string }> = [];
    const healthySession = (binding: Binding) => ({
      configure: async () => {},
      hasUserMessage: async () => false,
      describe: async () => ({
        ok: true as const,
        value: {
          durableSessionId: binding.durableSessionId,
          sessionPath: binding.sessionPath ?? "",
          cwd: binding.cwd,
          ...modelForRole(binding.assignment.role),
          extensionProtocol: 2 as const,
        },
      }),
      send: async () => {
        throw new Error("Unexpected send");
      },
      deliverUserAnswer: async () => {
        throw new Error("Unexpected answer");
      },
      onEvent: () => () => {},
      close: async () => {},
    });
    const runtimeDependencies = {
      ...w.dependencies,
      readHostReachabilityReadOnly: async () => "reachable" as const,
      probeBindingSession: async (binding: Binding) =>
        binding.id === child.id ? { state: "absent" as const } : { state: "open" as const },
      attachBinding: async (binding: Binding) => {
        if (binding.id === child.id) throw new NativeSessionAbsentError();
        return healthySession(binding);
      },
      prompt: async (binding: Binding, text: string) => {
        prompts.push({ bindingId: binding.id, text });
      },
    };
    const orchestrator = new Orchestrator(w.root, "/fake/herdr", runtimeDependencies);

    for (let attempt = 0; attempt < 2; attempt++) {
      const inspected = await orchestrator.statusWithRuntimeHealth();
      expect(inspected.ok).toBe(true);
      if (!inspected.ok) throw new Error(inspected.error.message);
      expect(
        inspected.value.find((binding) => binding.id === child.id)?.runtimeState,
      ).toBeUndefined();
    }
    expect(prompts).toHaveLength(0);
    expect(value(w.registry.operationalNotices({}))).toHaveLength(0);
    expect(
      await runCli(
        ["--root", w.root, "--herdr-socket", "/fake/herdr", "status", "--project", "p", "--json"],
        runtimeDependencies,
      ),
    ).toBe(0);
    expect(prompts).toHaveLength(0);
    expect(value(w.registry.operationalNotices({}))).toHaveLength(0);
    for (let attempt = 0; attempt < 2; attempt++) {
      const reconciled = await orchestrator.reconcile({ projectId: "p" });
      expect(reconciled).toMatchObject({
        ok: false,
        error: {
          code: "reconciliation_uncertain",
          details: {
            bindings: expect.arrayContaining([
              expect.objectContaining({ id: child.id, runtimeState: "local_only" }),
            ]),
          },
        },
      });
    }
    expect(await orchestrator.statusWithRuntimeHealth({ projectId: "p" })).toMatchObject({
      ok: true,
      value: expect.arrayContaining([
        expect.objectContaining({
          id: child.id,
          launchState: "uncertain",
          runtimeState: "local_only",
        }),
      ]),
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.bindingId).toBe(w.parent.id);
    expect(value(w.registry.operationalNotices({}))).toHaveLength(1);
    expect(value(w.registry.operationalNotices({}))[0]).toMatchObject({
      state: "accepted",
      envelope: {
        kind: "operational_notice",
        operational: { failure: { source: "host_loss" } },
      },
    });
  } finally {
    w.cleanup();
  }
});

test("read-only runtime health does not probe exact sessions or notify", async () => {
  const w = await world();
  try {
    const starting = w.ready(w.reserve("starting", "direct"), "starting-ws", "starting-ws:p");
    const unknown = w.parent;
    const prompts: string[] = [];
    const orchestrator = new Orchestrator(w.root, "/fake/herdr", {
      ...w.dependencies,
      readHostReachabilityReadOnly: async () => "reachable" as const,
      probeBindingSession: async () => {
        throw new Error("Read-only status must not list native sessions");
      },
      prompt: async (_binding, text) => {
        prompts.push(text);
      },
    });
    const inspected = await orchestrator.statusWithRuntimeHealth();
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) throw new Error(inspected.error.message);
    expect(
      inspected.value.find((binding) => binding.id === starting.id)?.runtimeState,
    ).toBeUndefined();
    expect(
      inspected.value.find((binding) => binding.id === unknown.id)?.runtimeState,
    ).toBeUndefined();
    expect(prompts).toEqual([]);
    expect(value(w.registry.operationalNotices({}))).toEqual([]);
  } finally {
    w.cleanup();
  }
});

test("project reconciliation checks an affected manager outside display scope and posts locally", async () => {
  const w = await world();
  try {
    const managerScope: ScopeSnapshot = {
      version: 1,
      source: "linear-export",
      initiative: null,
      projects: [],
      decisionRefs: [],
    };
    const digest = value(w.registry.importScope(managerScope)).digest;
    const manager = value(
      w.registry.reserve({
        bindingId: "manager",
        durableSessionId: "s-manager",
        designation: {
          id: "manager-designation",
          snapshotDigest: digest,
          designatedBy: "user",
          designatedAt: "now",
          create: true,
          execute: true,
          contact: true,
        },
        snapshot: managerScope,
        assignment: { role: "manager" },
        cwd: w.root,
        checkout: null,
        herdrSocket: "/fake/herdr",
        omoSocket: "/fake/omo",
      }),
    );
    w.ready(manager, "manager-ws", "manager-ws:p");
    value(w.registry.setOwner(w.parent.id, manager.id));
    const prompts: string[] = [];
    const orchestrator = new Orchestrator(w.root, "/fake/herdr", {
      ...w.dependencies,
      readHostReachabilityReadOnly: async () => "reachable" as const,
      probeBindingSession: async () => ({ state: "absent" as const }),
      attachBinding: async () => {
        throw new NativeSessionAbsentError();
      },
      prompt: async (_binding, text) => {
        prompts.push(text);
      },
    });
    await orchestrator.reconcile({ projectId: "p" });
    expect(prompts).toEqual([]);
    expect(value(w.registry.operationalNotices({}))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: "posted",
          envelope: expect.objectContaining({ fromBindingId: w.parent.id, toBindingId: null }),
        }),
      ]),
    );
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
