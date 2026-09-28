import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@code-yeongyu/senpi";
import { runCli } from "../../src/cli";
import type {
  Binding,
  Registry,
  Result,
  RuntimeIdentity,
  ScopeSnapshot,
} from "../../src/core/contracts";
import { modelForLaunch, modelForRole } from "../../src/core/policy";
import { openRegistry } from "../../src/core/store";
import type { HerdrClient, Snapshot } from "../../src/herdr";
import { HostCapacityError } from "../../src/host-profile";
import { Orchestrator, type OrchestratorDependencies } from "../../src/orchestrator";
import { publishReadiness } from "../../src/readiness";
import { type NativeSession, NativeSessionAbsentError } from "../../src/transport";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

async function world(
  options: {
    executeInitialized?: boolean;
    closeAwareHerdr?: boolean;
    unprovisioned?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "olw-successor-recovery-"));
  roots.push(root);
  await mkdir(join(root, ".omo/state"), { recursive: true });
  const dbPath = join(root, ".omo/state/registry.sqlite");
  const registry = openRegistry(dbPath);
  const snapshot: ScopeSnapshot = {
    version: 1,
    source: "fixture",
    initiative: null,
    projects: [
      {
        project: { id: "project", url: "linear://project", revision: "1" },
        issues: [{ id: "issue", key: "QA-1", url: "linear://issue", revision: "1" }],
      },
    ],
    decisionRefs: [],
  };
  const digest = value(registry.importScope(snapshot)).digest;
  const designation = {
    id: "designation",
    snapshotDigest: digest,
    designatedBy: "test",
    designatedAt: "2026-09-27T00:00:00.000Z",
    create: true,
    execute: true,
    contact: true,
  };
  const checkout = {
    kind: "owned-clone" as const,
    remote: "file:///fixture",
    receiptPath: join(root, "receipt.json"),
    originalRepoRoot: root,
    path: root,
    branch: "issue",
    baseBranch: "main",
    baseCommit: "head",
  };
  const base = {
    snapshot,
    designation,
    cwd: root,
    checkout,
    herdrSocket: "/herdr",
    omoSocket: "/omo",
  };
  const parent = value(
    registry.reserve({
      ...base,
      bindingId: "parent",
      durableSessionId: "session-parent",
      assignment: {
        role: "parent",
        initiativeId: null,
        projectId: "project",
        ownerBindingId: null,
      },
    }),
  );
  const assignment = {
    role: "child" as const,
    initiativeId: null,
    projectId: "project",
    issueId: "issue",
    ownerBindingId: parent.id,
  };
  const plan = value(
    registry.reserve({ ...base, bindingId: "plan", durableSessionId: "session-plan", assignment }),
  );
  const identities = new Map<string, RuntimeIdentity>();
  async function ready(binding: Binding, execute = false): Promise<Binding> {
    const model = execute
      ? modelForLaunch("child", "execute")
      : modelForRole(binding.assignment.role);
    const manager = SessionManager.create(root, join(root, ".omo/state/sessions"), {
      id: binding.durableSessionId,
    });
    manager.appendModelChange(model.provider, model.modelId);
    manager.appendThinkingLevelChange(model.thinking);
    const sessionPath = manager.getSessionFile();
    const header = manager.getHeader();
    if (sessionPath === undefined || header === null) throw new Error("missing session seed");
    await mkdir(join(root, ".omo/state/sessions"), { recursive: true });
    await writeFile(
      sessionPath,
      `${[header, ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
    value(registry.provision(binding.id, "workspace", `pane-${binding.id}`));
    value(registry.observeSession(binding.id, sessionPath));
    const identity = {
      durableSessionId: binding.durableSessionId,
      sessionPath,
      cwd: root,
      ...model,
      extensionProtocol: 2 as const,
    };
    identities.set(binding.durableSessionId, identity);
    value(registry.activate(binding.id, identity));
    value(registry.beginInitialization(binding.id, "brief"));
    value(registry.finishInitialization(binding.id, "accepted"));
    return value(registry.get(binding.id));
  }
  await ready(parent);
  await ready(plan);
  value(registry.recordStage(plan.id, "issue", "plan", 0, null));
  value(
    registry.recordHandoff(plan.id, {
      planPath: join(root, "plan.md"),
      planSha256: "a".repeat(64),
      head: "head",
      completedAt: "2026-09-27T00:00:00.000Z",
    }),
  );
  const executeReservation = value(
    registry.successorReservation(
      plan.id,
      { ...base, bindingId: "execute", durableSessionId: "session-execute", assignment },
      "execute",
    ),
  );
  const execute = options.unprovisioned
    ? executeReservation
    : options.executeInitialized === false
      ? await (async () => {
          const model = modelForLaunch("child", "execute");
          const manager = SessionManager.create(root, join(root, ".omo/state/sessions"), {
            id: executeReservation.durableSessionId,
          });
          manager.appendModelChange(model.provider, model.modelId);
          manager.appendThinkingLevelChange(model.thinking);
          const sessionPath = manager.getSessionFile();
          const header = manager.getHeader();
          if (sessionPath === undefined || header === null) throw new Error("missing session seed");
          await mkdir(join(root, ".omo/state/sessions"), { recursive: true });
          await writeFile(
            sessionPath,
            `${[header, ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
          );
          value(registry.provision(executeReservation.id, "workspace", "pane-execute"));
          value(registry.observeSession(executeReservation.id, sessionPath));
          const identity = {
            durableSessionId: executeReservation.durableSessionId,
            sessionPath,
            cwd: root,
            ...model,
            extensionProtocol: 2 as const,
          };
          identities.set(executeReservation.durableSessionId, identity);
          value(registry.activate(executeReservation.id, identity));
          return value(registry.get(executeReservation.id));
        })()
      : await ready(executeReservation, true);
  registry.close();

  let elapsed = 0;
  let native = false;
  let paneLive = false;
  let quits = 0;
  let launches = 0;
  let absenceHook: ((count: number) => Promise<void>) | undefined;
  let sendState: "accepted" | "rejected" = "accepted";
  let runHook: ((count: number) => Promise<void>) | undefined;
  let describeHook: ((count: number) => Promise<void>) | undefined;
  let absences = 0;
  let descriptions = 0;
  let sends = 0;
  let createTabHook: HerdrClient["createTab"] | undefined;
  let paneSessionPath: string | null | undefined;
  let beforePaneExit: (() => Promise<void>) | undefined;
  const listeners = new Set<(event: unknown) => void>();
  const pane = (): Snapshot["panes"][number] => ({
    paneId: "pane-execute",
    workspaceId: "workspace",
    revision: 1,
    sessionPath: paneLive ? (paneSessionPath ?? execute.sessionPath) : null,
    ...(paneLive ? { agent: "pi" } : {}),
  });
  const herdr: HerdrClient = {
    createWorkspace: async () => {
      throw new Error("unexpected createWorkspace");
    },
    createWorktree: async () => {
      throw new Error("unexpected createWorktree");
    },
    createTab: async (workspaceId, cwd, label) => {
      if (createTabHook) return createTabHook(workspaceId, cwd, label);
      throw new Error("unexpected createTab");
    },
    renameTab: async () => {},
    closeTab: async () => {
      throw new Error("unexpected closeTab");
    },
    focusWorkspace: async () => {},
    focusPane: async () => {},
    paneContainsProcess: async () => true,
    sendKeys: async (paneId, text, keys) => {
      expect([paneId, text, keys]).toEqual(["pane-execute", "/quit", ["Enter"]]);
      quits += 1;
      await beforePaneExit?.();
      paneLive = false;
      for (const listener of listeners)
        listener({ event: "pane.exited", data: { pane_id: paneId } });
    },
    closeWorkspace: async () => {},
    removeWorktree: async () => {},
    snapshot: async () => ({
      focusedWorkspaceId: null,
      focusedTabId: null,
      focusedPaneId: null,
      workspaces: [{ workspaceId: "workspace", rootPaneId: "pane-execute", cwd: root }],
      panes: [
        pane(),
        { paneId: "pane-parent", workspaceId: "workspace", revision: 1, sessionPath: null },
        { paneId: "pane-plan", workspaceId: "workspace", revision: 1, sessionPath: null },
      ],
    }),
    subscribe: async (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    run: async () => {
      launches += 1;
      if (runHook) await runHook(launches);
      else await publish();
    },
    close: () => {},
  };
  async function publish() {
    native = true;
    paneLive = true;
    const current = withRegistry((opened) => {
      const listed = value(opened.list());
      return listed.find(
        (binding) =>
          binding.assignment.role === "child" &&
          value(opened.stageOf(binding.id))?.stage === "execute" &&
          binding.launchState !== "closed",
      );
    });
    if (current?.sessionPath === null || current === undefined)
      throw new Error("missing session path");
    identities.set(current.durableSessionId, {
      durableSessionId: current.durableSessionId,
      sessionPath: current.sessionPath,
      cwd: current.cwd,
      ...modelForLaunch("child", "execute"),
      extensionProtocol: 2,
    });
    await publishReadiness(root, {
      bindingId: current.id,
      durableSessionId: current.durableSessionId,
      sessionPath: current.sessionPath,
      cwd: root,
      paneId: current.paneId ?? "pane-execute",
    });
  }
  function session(identity: RuntimeIdentity): NativeSession {
    return {
      configure: async (model) => {
        identities.set(identity.durableSessionId, { ...identity, ...model });
      },
      hasUserMessage: async () => true,
      describe: async () => {
        if (identity.durableSessionId === execute.durableSessionId)
          await describeHook?.(++descriptions);
        return {
          ok: true,
          value: identities.get(identity.durableSessionId) ?? identity,
        };
      },
      send: async (envelope) => {
        sends += 1;
        return {
          ok: true,
          value: {
            envelope,
            state: sendState,
            receipt: {
              kind: "ok",
              thread_id: identity.durableSessionId,
              message_seq: sends,
              deduplicated: false,
              delivery: { kind: "started", turn_id: `turn-${sends}` },
            },
          },
        };
      },
      deliverUserAnswer: async () => {
        throw new Error("unexpected answer");
      },
      onEvent: () => () => {},
      close: async () => {},
    };
  }
  const createHerdrClient = (): HerdrClient => {
    if (!options.closeAwareHerdr) return herdr;
    let closed = false;
    return new Proxy(herdr, {
      get(target, property) {
        if (property === "close")
          return () => {
            closed = true;
          };
        const member = Reflect.get(target, property);
        if (typeof member !== "function") return member;
        return (...args: unknown[]) => {
          if (closed) throw new Error("Herdr client is closed");
          return Reflect.apply(member, target, args);
        };
      },
    });
  };
  const dependencies: OrchestratorDependencies = {
    openRegistry,
    createHerdrClient,
    resolveHerdrArtifact: async () => ({ artifactDir: join(root, "herdr") }),
    checkHostProfile: async () => {},
    ensureHost: async () => {},
    gitTip: async () => "head",
    now: () => new Date(Date.parse("2026-09-27T00:00:00.000Z") + elapsed).toISOString(),
    uuid: () => crypto.randomUUID(),
    terminateBinding: async () => {
      native = false;
      paneLive = false;
    },
    prompt: async () => {},
    attachBinding: async (binding) => {
      if (binding.id === execute.id && !native) {
        absences += 1;
        await absenceHook?.(absences);
        throw new NativeSessionAbsentError();
      }
      const identity = identities.get(binding.durableSessionId);
      if (identity === undefined) throw new Error("missing identity");
      return session(identity);
    },
  };
  const start = () =>
    new Orchestrator(root, "/herdr", dependencies).stageStart({
      fromId: plan.id,
      parentId: parent.id,
      stage: "execute",
      messageId: "start",
    });
  const withRegistry = <T>(operation: (opened: Registry) => T): T => {
    const opened = openRegistry(dbPath);
    try {
      return operation(opened);
    } finally {
      opened.close();
    }
  };
  return {
    root,
    dependencies,
    execute,
    start,
    publish,
    setVisibility: (present: boolean) => {
      native = present;
      paneLive = present;
    },
    setLocalFallback: () => {
      native = false;
      paneLive = true;
    },
    setCreateTab: (hook: HerdrClient["createTab"]) => {
      createTabHook = hook;
    },
    setPaneSessionPath: (path: string) => {
      paneSessionPath = path;
    },
    setBeforePaneExit: (hook: () => Promise<void>) => {
      beforePaneExit = hook;
    },
    disconnect: () => {
      for (const listener of listeners)
        listener({ event: "connection.error", data: { code: "closed", message: "disconnected" } });
    },
    setClock: (milliseconds: number) => {
      elapsed = milliseconds;
    },
    setAbsenceHook: (hook: (count: number) => Promise<void>) => {
      absenceHook = hook;
    },
    setRunHook: (hook: (count: number) => Promise<void>) => {
      runHook = hook;
    },
    setSendState: (state: "accepted" | "rejected") => {
      sendState = state;
    },
    setDescribeHook: (hook: ((count: number) => Promise<void>) | undefined) => {
      describeHook = hook;
    },
    launches: () => launches,
    sends: () => sends,
    quits: () => quits,
    orchestrator: () => new Orchestrator(root, "/herdr", dependencies),
    absences: () => absences,
    registry: withRegistry,
  };
}

test("successor capacity race retires only its unstarted attempt before TUI dispatch", async () => {
  const w = await world({ executeInitialized: false });
  w.setVisibility(false);
  Object.assign(w.dependencies, {
    acquireLaunchSession: async () => {
      throw new HostCapacityError(20);
    },
  });
  expect(await w.start()).toMatchObject({ ok: false, error: { code: "host_session_capacity" } });
  expect(w.launches()).toBe(0);
  expect(w.sends()).toBe(0);
  expect(w.registry((registry) => value(registry.get(w.execute.id)))).toMatchObject({
    launchState: "closed",
    initialization: { state: "pending" },
  });
  expect(w.registry((registry) => value(registry.stageOf(w.execute.id)))).toBeNull();
});

test.each([true, false])(
  "successor capacity closes only its newly created tab: new=%s",
  async (unprovisioned) => {
    const w = await world({ executeInitialized: false, unprovisioned });
    const closed: string[] = [];
    w.setCreateTab(async () => ({ tabId: "workspace:new-tab", rootPaneId: "workspace:new-pane" }));
    Object.assign(w.dependencies.createHerdrClient("/herdr"), {
      closeTab: async (tabId: string) => {
        expect(w.registry((registry) => value(registry.get(w.execute.id))).launchState).not.toBe(
          "closed",
        );
        closed.push(tabId);
      },
    });
    Object.assign(w.dependencies, {
      acquireLaunchSession: async () => {
        throw new HostCapacityError(20);
      },
    });
    expect(await w.start()).toMatchObject({ ok: false, error: { code: "host_session_capacity" } });
    expect(closed).toEqual(unprovisioned ? ["workspace:new-tab"] : []);
    expect(w.launches()).toBe(0);
  },
);

test("capacity during initialized successor reattachment preserves accepted work and typed refusal", async () => {
  const w = await world();
  w.setVisibility(false);
  Object.assign(w.dependencies, {
    acquireLaunchSession: async () => {
      throw new HostCapacityError(20);
    },
  });
  expect(await w.start()).toMatchObject({ ok: false, error: { code: "host_session_capacity" } });
  expect(w.launches()).toBe(0);
  expect(w.registry((registry) => value(registry.get(w.execute.id)))).toMatchObject({
    initialization: { state: "accepted" },
  });
  expect(w.registry((registry) => value(registry.stageOf(w.execute.id)))).not.toBeNull();
});

test("stage start refuses an uncertain local-only successor without changing it", async () => {
  const w = await world({ executeInitialized: false, closeAwareHerdr: true });
  w.setRunHook(async () => {
    w.setLocalFallback();
    w.disconnect();
  });
  expect(await w.start()).toMatchObject({ ok: false });
  const before = w.registry((registry) => value(registry.get("execute")));
  const intent = w.registry((registry) => value(registry.successorLaunchIntent("execute")));

  expect(await w.start()).toMatchObject({
    ok: false,
    error: {
      code: "successor_abandon_required",
      details: {
        bindingId: "execute",
        recovery: "inspect_then_close_and_restart_stage",
      },
    },
  });
  expect(w.registry((registry) => value(registry.get("execute")))).toEqual(before);
  expect(w.registry((registry) => value(registry.successorLaunchIntent("execute")))).toEqual(
    intent,
  );
  expect(w.quits()).toBe(0);
  expect(w.launches()).toBe(1);
  expect(w.sends()).toBe(0);
});

test("close then stage start creates a fresh successor and preserves old attempt history", async () => {
  const w = await world({ executeInitialized: false });
  w.setRunHook(async () => {
    w.setLocalFallback();
    w.disconnect();
  });
  expect(await w.start()).toMatchObject({ ok: false });
  const oldIntent = w.registry((registry) => value(registry.successorLaunchIntent("execute")));
  if (oldIntent === null) throw new Error("Missing uncertain attempt");

  expect(await w.orchestrator().close("execute", false, true)).toMatchObject({ ok: true });
  expect(w.registry((registry) => value(registry.get("plan")))).toMatchObject({
    launchState: "closed",
    contactState: "cancelled",
  });
  expect(await w.orchestrator().reconcile({ projectId: "project" })).toMatchObject({ ok: true });
  const sendsBeforePlanContact = w.sends();
  expect(
    await w.orchestrator().send({
      fromId: "parent",
      toId: "plan",
      kind: "instruction",
      text: "are you there?",
      messageId: "contact-retired-plan",
    }),
  ).toMatchObject({ ok: false, error: { code: "not_ready" } });
  expect(w.sends()).toBe(sendsBeforePlanContact);
  await Bun.write(join(w.root, "plan.md"), "plan");
  const planSha = new Bun.CryptoHasher("sha256").update("plan").digest("hex");
  const deliveryDb = new Database(join(w.root, ".omo/state/registry.sqlite"));
  try {
    deliveryDb
      .query(
        "UPDATE stage_lineage SET handoff_json = json_set(handoff_json, '$.completionReportId', 'plan-report', '$.planSha256', ?) WHERE binding_id = 'plan'",
      )
      .run(planSha);
    deliveryDb
      .query(
        "INSERT INTO deliveries (message_id, envelope_json, state, receipt_json) VALUES (?, ?, 'accepted', ?)",
      )
      .run(
        "plan-report",
        JSON.stringify({
          version: 1,
          id: "plan-report",
          fromBindingId: "plan",
          toBindingId: "parent",
          designationId: "designation",
          snapshotDigest: value(w.registry((registry) => registry.designation("designation")))
            .snapshotDigest,
          kind: "report",
          text: "done",
          outcome: "completed",
          evidence: [join(w.root, "plan.md")],
        }),
        JSON.stringify({
          kind: "ok",
          thread_id: "session-parent",
          message_seq: 1,
          deduplicated: false,
          delivery: { kind: "started", turn_id: "plan" },
        }),
      );
  } finally {
    deliveryDb.close();
  }
  let nextPane = 2;
  w.setCreateTab(async () => ({
    tabId: `fresh:t${nextPane}`,
    rootPaneId: `pane-fresh-${nextPane++}`,
  }));
  w.setRunHook(async () => w.publish());
  const fresh = await w.start();
  expect(fresh).toMatchObject({ ok: true, value: { stage: "execute" } });
  if (!fresh.ok) throw new Error(fresh.error.message);
  expect(fresh.value.binding.id).not.toBe("execute");
  expect(w.registry((registry) => value(registry.stageOf(fresh.value.binding.id)))).toMatchObject({
    ordinal: 2,
    previousBindingId: "plan",
  });
  const history = new Database(join(w.root, ".omo/state/registry.sqlite"), { readonly: true });
  try {
    expect(
      history
        .query<{ owner: string; state: string }, []>(
          "SELECT owner, state FROM successor_launch_attempts WHERE binding_id = 'execute' ORDER BY attempt_number",
        )
        .all(),
    ).toContainEqual({ owner: oldIntent.attemptId, state: "uncertain" });
  } finally {
    history.close();
  }
});

test("reconcile reports an uncertain local-only successor for manual abandonment", async () => {
  const w = await world({ executeInitialized: false });
  w.setRunHook(async () => {
    w.setLocalFallback();
    w.disconnect();
  });
  expect(await w.start()).toMatchObject({ ok: false });
  const before = w.registry((registry) => value(registry.get("execute")));

  expect(await w.orchestrator().reconcile({ projectId: "project" })).toMatchObject({
    ok: false,
    error: {
      code: "reconciliation_uncertain",
      details: {
        issues: [{ bindingId: "execute", code: "successor_abandon_required" }],
      },
    },
  });
  expect(w.registry((registry) => value(registry.get("execute")))).toMatchObject({
    id: before.id,
    launchState: "uncertain",
    initialization: before.initialization,
  });
  expect(w.quits()).toBe(0);
  expect(w.launches()).toBe(1);
  expect(w.sends()).toBe(0);
});

test("a stale absence observation revalidates after the owner succeeds", async () => {
  const w = await world();
  const secondObserved = Promise.withResolvers<void>();
  const releaseSecond = Promise.withResolvers<void>();
  w.setAbsenceHook(async (count) => {
    if (count === 1) await secondObserved.promise;
    else if (count === 2) {
      secondObserved.resolve();
      await releaseSecond.promise;
    }
  });
  const first = w.start();
  const second = w.start();
  expect(await first).toMatchObject({ ok: true, value: { binding: { id: "execute" } } });
  releaseSecond.resolve();
  expect(await second).toMatchObject({ ok: true, value: { binding: { id: "execute" } } });
  expect(w.launches()).toBe(1);
});

test("a caller seeing the native session during another dispatch gets the in-progress attempt", async () => {
  const w = await world();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  w.setRunHook(async () => {
    await w.publish();
    entered.resolve();
    await release.promise;
  });
  const first = w.start();
  await entered.promise;
  const second = await w.start();
  expect(second).toMatchObject({
    ok: true,
    value: { binding: { id: "execute" }, readiness: "launching" },
  });
  expect(w.launches()).toBe(1);
  release.resolve();
  expect(await first).toMatchObject({ ok: true, value: { readiness: "ready" } });
  expect(w.launches()).toBe(1);
});

test("dispatching is never taken over when the claim clock expires", async () => {
  const w = await world();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  w.setRunHook(async () => {
    entered.resolve();
    await release.promise;
    await w.publish();
  });
  const first = w.start();
  await entered.promise;
  w.setClock(120_001);
  const second = await w.start();
  expect(second).toMatchObject({ ok: true, value: { readiness: "launching" } });
  expect(w.launches()).toBe(1);
  release.resolve();
  expect(await first).toMatchObject({ ok: true, value: { readiness: "ready" } });
});

test("a stale token cannot mutate a newer claimed attempt", async () => {
  const w = await world();
  const first = value(
    w.registry((registry) =>
      registry.beginSuccessorLaunch(
        "execute",
        "pane-execute",
        "2026-09-27T00:00:00.000Z",
        "2026-09-26T23:58:00.000Z",
      ),
    ),
  );
  if (!first.claimed) throw new Error("first claim missing");
  const second = value(
    w.registry((registry) =>
      registry.beginSuccessorLaunch(
        "execute",
        "pane-execute",
        "2026-09-27T00:02:00.001Z",
        "2026-09-27T00:00:00.001Z",
      ),
    ),
  );
  if (!second.claimed) throw new Error("second claim missing");
  const before = w.registry((registry) => value(registry.get("execute")));
  expect(
    w.registry((registry) => registry.prepareSuccessorLaunch("execute", first.token)),
  ).toMatchObject({
    ok: false,
    error: { code: "lease_lost" },
  });
  expect(w.registry((registry) => value(registry.get("execute")))).toEqual(before);
  expect(
    w.registry((registry) => value(registry.ownsSuccessorLaunch("execute", second.token))),
  ).toBe(true);
  const attempts = new Database(join(w.root, ".omo/state/registry.sqlite"), { readonly: true });
  try {
    expect(
      attempts
        .query<{ owner: string; state: string }, []>(
          "SELECT owner, state FROM successor_launch_attempts WHERE binding_id = 'execute' ORDER BY attempt_number",
        )
        .all(),
    ).toEqual([
      { owner: first.token, state: "superseded" },
      { owner: second.token, state: "claimed" },
    ]);
  } finally {
    attempts.close();
  }
});

test("reconcile marks an expired dispatch from a dead owner uncertain without retrying", async () => {
  const w = await world();
  const claim = value(
    w.registry((registry) =>
      registry.beginSuccessorLaunch(
        "execute",
        "pane-execute",
        "2026-09-27T00:00:00.000Z",
        "2026-09-26T23:58:00.000Z",
      ),
    ),
  );
  if (!claim.claimed) throw new Error("claim missing");
  value(w.registry((registry) => registry.prepareSuccessorLaunch("execute", claim.token)));
  value(w.registry((registry) => registry.dispatchSuccessorLaunch("execute", claim.token)));
  const db = new Database(join(w.root, ".omo/state/registry.sqlite"));
  try {
    db.query(
      "UPDATE successor_launch SET owner_pid = 2147483647, owner_starttime = '1' WHERE binding_id = 'execute'",
    ).run();
  } finally {
    db.close();
  }
  w.setClock(120_001);

  expect(await w.orchestrator().reconcile({ projectId: "project" })).toMatchObject({
    ok: false,
    error: {
      code: "reconciliation_uncertain",
      details: { issues: [{ bindingId: "execute", code: "successor_abandon_required" }] },
    },
  });
  expect(w.registry((registry) => value(registry.successorLaunchIntent("execute")))).toEqual({
    attemptId: claim.token,
    state: "uncertain",
  });
  expect(w.registry((registry) => value(registry.get("execute")).launchState)).toBe("uncertain");
  expect(w.launches()).toBe(0);
});

test("an accepted dispatch with lost observation becomes uncertain and is never resent", async () => {
  const w = await world();
  w.setRunHook(async () => w.disconnect());
  expect(await w.start()).toMatchObject({ ok: false, error: { code: "runtime_unavailable" } });
  expect(w.launches()).toBe(1);
  expect(await w.start()).toMatchObject({
    ok: false,
    error: { code: "successor_abandon_required" },
  });
  expect(w.launches()).toBe(1);
  expect(w.registry((registry) => value(registry.get("execute")).launchState)).toBe("uncertain");
});

test("stale native adoption cannot settle a newer claimed attempt", async () => {
  const w = await world();
  const described = Promise.withResolvers<void>();
  const releaseDescription = Promise.withResolvers<void>();
  w.setAbsenceHook(async () => w.setVisibility(true));
  w.setDescribeHook(async () => {
    described.resolve();
    await releaseDescription.promise;
  });
  const stale = w.start();
  await described.promise;
  const oldIntent = w.registry((registry) => value(registry.successorLaunchIntent("execute")));
  if (oldIntent === null) throw new Error("old attempt missing");
  w.setVisibility(false);
  w.setClock(120_001);
  const newer = value(
    w.registry((registry) =>
      registry.beginSuccessorLaunch(
        "execute",
        "pane-execute",
        "2026-09-27T00:02:00.001Z",
        "2026-09-27T00:00:00.001Z",
      ),
    ),
  );
  if (!newer.claimed) throw new Error("new attempt missing");
  releaseDescription.resolve();
  expect(await stale).toMatchObject({ ok: false, error: { code: "lease_lost" } });
  const current = w.registry((registry) => value(registry.successorLaunchIntent("execute")));
  expect(current).toEqual({ attemptId: newer.token, state: "claimed" });
  if (current === null) throw new Error("current attempt missing");
  expect(current.attemptId).not.toBe(oldIntent.attemptId);
  expect(w.registry((registry) => value(registry.get("execute")).launchState)).toBe("ready");
  expect(w.launches()).toBe(0);
});

test("stage-start settlement uses the intent captured before native observation", async () => {
  const w = await world();
  w.setRunHook(async () => w.disconnect());
  expect(await w.start()).toMatchObject({ ok: false, error: { code: "runtime_unavailable" } });
  const first = w.registry((registry) => value(registry.successorLaunchIntent("execute")));
  if (first === null) throw new Error("first uncertain attempt missing");
  await w.publish();
  const described = Promise.withResolvers<void>();
  const releaseDescription = Promise.withResolvers<void>();
  w.setDescribeHook(async (count) => {
    if (count === 2) {
      described.resolve();
      await releaseDescription.promise;
    }
  });
  const stale = w.start();
  await described.promise;
  const settled = await runCli(
    ["--root", w.root, "--herdr-socket", "/herdr", "reconcile", "--project", "project", "--json"],
    w.dependencies,
  );
  expect(settled).toBe(0);
  w.setVisibility(false);
  expect(await w.start()).toMatchObject({ ok: false, error: { code: "runtime_unavailable" } });
  const second = w.registry((registry) => value(registry.successorLaunchIntent("execute")));
  if (second === null) throw new Error("second uncertain attempt missing");
  expect(second.attemptId).not.toBe(first.attemptId);
  releaseDescription.resolve();
  expect(await stale).toMatchObject({ ok: false, error: { code: "lease_lost" } });
  expect(w.registry((registry) => value(registry.successorLaunchIntent("execute")))).toEqual(
    second,
  );
  expect(w.launches()).toBe(2);
  expect(await w.start()).toMatchObject({
    ok: false,
    error: { code: "successor_abandon_required" },
  });
  expect(w.launches()).toBe(2);
});

test("closing during dispatch remains terminal after delayed launch failure", async () => {
  const w = await world();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  w.setRunHook(async () => {
    entered.resolve();
    await release.promise;
    throw new Error("pending run failed after closure");
  });
  const starting = w.start();
  await entered.promise;
  expect(await w.orchestrator().close("execute", false, true)).toMatchObject({ ok: true });
  expect(w.registry((registry) => value(registry.get("execute")).launchState)).toBe("closed");
  release.resolve();
  expect(await starting).toMatchObject({ ok: false, error: { code: "runtime_unavailable" } });
  const closed = w.registry((registry) => value(registry.get("execute")));
  expect(closed.launchState).toBe("closed");
  expect(closed.contactState).toBe("cancelled");
});

test("owner-held native adoption initializes before reporting brief acceptance", async () => {
  const w = await world({ executeInitialized: false });
  w.setAbsenceHook(async () => w.setVisibility(true));
  const adopted = await w.start();
  expect(adopted).toMatchObject({
    ok: true,
    value: {
      readiness: "ready",
      execution: "brief_accepted",
      binding: { launchState: "ready", initialization: { state: "accepted" } },
    },
  });
  const persisted = w.registry((registry) => value(registry.get("execute")));
  expect(persisted.launchState).toBe("ready");
  expect(persisted.initialization.state).toBe("accepted");
  expect(persisted.initialization.text).not.toBeNull();
  expect(w.launches()).toBe(0);
  expect(w.sends()).toBe(1);
});

test("owner-held native adoption surfaces a rejected initialization", async () => {
  const w = await world({ executeInitialized: false });
  w.setAbsenceHook(async () => w.setVisibility(true));
  w.setSendState("rejected");
  const adopted = await w.start();
  expect(adopted).toMatchObject({ ok: false, error: { code: "brief_rejected" } });
  const persisted = w.registry((registry) => value(registry.get("execute")));
  expect(persisted.initialization.state).toBe("rejected");
  expect(w.launches()).toBe(0);
  expect(w.sends()).toBe(1);
});

test("CLI reconcile settles the same uncertain attempt ready", async () => {
  const w = await world();
  w.setRunHook(async () => w.disconnect());
  expect(await w.start()).toMatchObject({ ok: false, error: { code: "runtime_unavailable" } });
  const uncertain = w.registry((registry) => value(registry.successorLaunchIntent("execute")));
  if (uncertain === null) throw new Error("uncertain attempt missing");
  expect(uncertain.state).toBe("uncertain");
  await w.publish();
  const exit = await runCli(
    ["--root", w.root, "--herdr-socket", "/herdr", "reconcile", "--project", "project", "--json"],
    w.dependencies,
  );
  expect(exit).toBe(0);
  expect(w.registry((registry) => value(registry.successorLaunchIntent("execute")))).toEqual({
    attemptId: uncertain.attemptId,
    state: "ready",
  });
  expect(w.registry((registry) => value(registry.get("execute")).launchState)).toBe("ready");
  expect(w.launches()).toBe(1);
  w.setVisibility(false);
  w.setRunHook(async () => w.publish());
  expect(await w.start()).toMatchObject({ ok: true, value: { readiness: "ready" } });
  expect(w.launches()).toBe(2);
});
