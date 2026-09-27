import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@code-yeongyu/senpi";
import { runCli } from "../src/cli";
import type {
  Binding,
  Checkout,
  Result,
  RuntimeIdentity,
  ScopeSnapshot,
} from "../src/core/contracts";
import { modelForRole } from "../src/core/policy";
import { openRegistry } from "../src/core/store";
import type { HerdrClient, Snapshot, Workspace } from "../src/herdr";
import { HostHandoffBusyError } from "../src/host-handoff-lock";
import {
  HostProfileMismatchError,
  HostSessionsPresentError,
  runtimeCacheEnvironment,
} from "../src/host-profile";
import { Orchestrator, type OrchestratorDependencies } from "../src/orchestrator";
import { publishReadiness } from "../src/readiness";
import type { NativeSession } from "../src/transport";
import { fixtureTip, mappedScope } from "./fixtures/mapped-scope";

const roots: string[] = [];
let previousSocket: string | undefined;
beforeEach(() => {
  previousSocket = process.env["HERDR_SOCKET_PATH"];
  process.env["HERDR_SOCKET_PATH"] = "/fixture/herdr.sock";
});
afterEach(async () => {
  if (previousSocket === undefined) delete process.env["HERDR_SOCKET_PATH"];
  else process.env["HERDR_SOCKET_PATH"] = previousSocket;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

interface RunCall {
  readonly paneId: string;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

async function world(agent = "omo") {
  const root = await mkdtemp(join(tmpdir(), "olw-manage-"));
  roots.push(root);
  await mkdir(join(root, ".omo/state"), { recursive: true });
  const settingsPath = join(root, "settings.json");
  await Bun.write(
    settingsPath,
    JSON.stringify({
      defaultProvider: "fixture-provider",
      defaultModel: "fixture-model",
      defaultThinkingLevel: "high",
    }),
  );
  const workspaces = new Map<string, Workspace>();
  const panes = new Map<string, { workspaceId: string; agent?: string; sessionPath?: string }>();
  const hooks: {
    failRun: boolean;
    hostCheck: (() => void) | undefined;
    hostStatus: OrchestratorDependencies["readHostStatus"];
    hostSessions: OrchestratorDependencies["observeEmptyHostSessions"];
    hostHandoffs: number;
    now: string;
    /** Awaited at createTab entry, before any tab exists. */
    beforeTab: (() => Promise<void>) | undefined;
    /** Awaited when a manager's native session is attached for verification. */
    beforeAttach: (() => Promise<void>) | undefined;
    updateTimer: OrchestratorDependencies["updateTimer"];
    hangingUpdateCheck: boolean;
    updateCheck: OrchestratorDependencies["updateCheck"];
  } = {
    failRun: false,
    hostCheck: undefined,
    hostStatus: undefined,
    hostSessions: async () => {},
    hostHandoffs: 0,
    now: "2026-09-26T00:00:00.000Z",
    beforeTab: undefined,
    beforeAttach: undefined,
    updateTimer: undefined,
    hangingUpdateCheck: false,
    updateCheck: undefined,
  };
  const identities = new Map<string, RuntimeIdentity>();
  const prompts = new Map<string, Set<string>>();
  const runs: RunCall[] = [];
  const created: Array<{ readonly cwd: string; readonly label: string }> = [];
  const tabs: Array<{
    readonly workspaceId: string;
    readonly cwd: string;
    readonly label: string;
  }> = [];
  const focused: string[] = [];
  let sequence = 0;
  const readRegistry = <T>(operation: (registry: ReturnType<typeof openRegistry>) => T): T => {
    const registry = openRegistry(join(root, ".omo/state/registry.sqlite"));
    try {
      return operation(registry);
    } finally {
      registry.close();
    }
  };
  const herdr: HerdrClient = {
    async subscribe() {
      return () => {};
    },
    async createWorkspace(cwd, label) {
      created.push({ cwd, label });
      const id = `ws-${++sequence}`;
      const workspace = {
        workspaceId: id,
        rootPaneId: `${id}:p1`,
        rootTabId: `${id}:t1`,
        cwd,
        label,
      };
      workspaces.set(id, workspace);
      panes.set(workspace.rootPaneId, { workspaceId: id });
      return workspace;
    },
    async createWorktree(checkout: Checkout, label) {
      return this.createWorkspace(checkout.path, label);
    },
    async createTab(workspaceId, cwd, label) {
      await hooks.beforeTab?.();
      tabs.push({ workspaceId, cwd, label });
      const n = tabs.length;
      const tab = { tabId: `${workspaceId}:tab${n}`, rootPaneId: `${workspaceId}:tp${n}` };
      panes.set(tab.rootPaneId, { workspaceId });
      return tab;
    },
    async renameTab() {},
    async sendKeys() {},
    async focusWorkspace(workspaceId) {
      focused.push(workspaceId);
    },
    async paneContainsProcess() {
      return true;
    },
    async focusPane(paneId) {
      focused.push(paneId);
    },
    async run(paneId, argv, env) {
      if (hooks.failRun) throw new Error("injected send_input failure before launching TUI");
      runs.push({ paneId, argv, env });
      const path = argv[argv.indexOf("--session") + 1];
      if (path === undefined) throw new Error("Missing --session");
      const sessionId = SessionManager.open(path).getSessionId();
      const binding = readRegistry((registry) => value(registry.bySession(sessionId)));
      const pane = panes.get(paneId);
      if (pane === undefined) throw new Error("No such pane");
      panes.set(paneId, { ...pane, agent });
      identities.set(binding.id, {
        durableSessionId: binding.durableSessionId,
        sessionPath: path,
        cwd: binding.cwd,
        ...(binding.assignment.role === "manager"
          ? { provider: "user-switched", modelId: "whatever", thinking: "medium" as const }
          : modelForRole(binding.assignment.role)),
        extensionProtocol: 2,
      });
      await publishReadiness(root, {
        bindingId: binding.id,
        durableSessionId: binding.durableSessionId,
        sessionPath: path,
        cwd: binding.cwd,
        paneId,
      });
    },
    async snapshot(): Promise<Snapshot> {
      return {
        focusedWorkspaceId: null,
        focusedTabId: null,
        focusedPaneId: null,
        workspaces: [...workspaces.values()],
        panes: [...panes.entries()].map(([paneId, pane]) => ({
          paneId,
          revision: 1,
          sessionPath: null,
          ...pane,
        })),
      };
    },
    async closeWorkspace(id) {
      workspaces.delete(id);
      for (const [paneId, pane] of panes) if (pane.workspaceId === id) panes.delete(paneId);
    },
    async removeWorktree() {},
    close() {},
  };
  const deps: OrchestratorDependencies = {
    openRegistry,
    createHerdrClient: () => herdr,
    resolveHerdrArtifact: async () => ({ artifactDir: join(root, ".managed-herdr") }),
    ensureHost: async () => {},
    launchHere: (argv, _cwd, env) => ({
      exited: herdr.run(process.env["HERDR_PANE_ID"] ?? "", argv, env).then(() => 0),
      kill() {},
    }),
    checkHostProfile: async () => hooks.hostCheck?.(),
    readHostStatus: async (...args) => {
      if (hooks.hostStatus === undefined) throw new Error("injected unreadable host status");
      return hooks.hostStatus(...args);
    },
    observeEmptyHostSessions: async (...args) => {
      if (hooks.hostSessions === undefined) throw new Error("injected unreadable session list");
      return hooks.hostSessions(...args);
    },
    handoffHost: async () => {
      hooks.hostHandoffs += 1;
      hooks.hostCheck = undefined;
    },
    verifyHostAfterHandoff: async (_root, status) => {
      if (!status.reachable || status.launchProfile === null)
        throw new Error("injected successor profile unavailable");
    },
    gitTip: (cwd, ref) => fixtureTip(root, "base-commit", cwd, ref),
    now: () => hooks.now,
    uuid: () => `id-${++sequence}`,
    managerSettingsPath: settingsPath,
    updateTimer: {
      now: () => hooks.updateTimer?.now() ?? Date.now(),
      setTimeout: (callback, delay) =>
        hooks.updateTimer?.setTimeout(callback, delay) ?? setTimeout(callback, delay),
      clearTimeout: (timer) => hooks.updateTimer?.clearTimeout(timer) ?? clearTimeout(timer),
    },
    updateCheck: async () => {
      if (hooks.updateCheck !== undefined) return hooks.updateCheck();
      if (hooks.hangingUpdateCheck)
        return new Promise<import("../src/update/check").UpdateCheck>(() => {});
      return {
        checkedAt: "2026-09-26T00:00:00.000Z",
        state: "current",
        packages: {
          "omo-ai": { state: "current", pinned: "1.0.0", available: "1.0.0", tag: "beta" },
          "@code-yeongyu/senpi": {
            state: "current",
            pinned: "1.0.0",
            available: "1.0.0",
            tag: "latest",
          },
        },
        globalOmo: "1.0.0",
      };
    },
    terminateBinding: async (binding) => {
      identities.delete(binding.id);
    },
    prompt: async (binding, text) => {
      const history = prompts.get(binding.id) ?? new Set<string>();
      history.add(text);
      prompts.set(binding.id, history);
    },
    attachBinding: async (binding): Promise<NativeSession> => {
      if (binding.assignment.role === "manager") await hooks.beforeAttach?.();
      const identity = identities.get(binding.id);
      if (identity === undefined) throw new Error("Exact native session absent");
      return {
        configure: async () => {},
        describe: async () => ({ ok: true, value: identity }),
        hasUserMessage: async (text) => prompts.get(binding.id)?.has(text) ?? false,
        deliverUserAnswer: async () => ({
          ok: false as const,
          error: { code: "route_denied", message: "User answers use the dedicated RPC" },
        }),
        send: async (envelope) => ({
          ok: true,
          value: {
            envelope,
            state: "accepted",
            receipt: {
              kind: "ok",
              thread_id: "target",
              message_seq: 1,
              deduplicated: false,
              delivery: { kind: "started", turn_id: "turn" },
            },
          },
        }),
        onEvent: () => () => {},
        close: async () => {},
      };
    },
  };
  const orchestrator = new Orchestrator(root, "/fixture/herdr.sock", deps);
  const projectScope: ScopeSnapshot = {
    version: 1,
    source: "fixture",
    initiative: null,
    projects: [
      { project: { id: "project", url: "linear://project", revision: "r1" }, issues: [] },
      { project: { id: "second", url: "linear://second", revision: "r1" }, issues: [] },
    ],
    decisionRefs: [],
  };
  const mapped = await mappedScope(root, projectScope);
  const digest = readRegistry((registry) => value(registry.importScope(mapped)).digest);
  const createParent = (projectId: string, noManager?: boolean) =>
    orchestrator.createParent({
      scopeDigest: digest,
      designationId: "project-approval",
      projectId,
      execute: true,
      fixture: true,
      ...(noManager === undefined ? {} : { noManager }),
    });
  return {
    root,
    settingsPath,
    orchestrator,
    readRegistry,
    createParent,
    workspaces,
    panes,
    runs,
    created,
    tabs,
    focused,
    deps,
    prompts,
    hooks,
  };
}

function managers(bindings: readonly Binding[]): Binding[] {
  return bindings.filter((binding) => binding.assignment.role === "manager");
}

test("bare entry cannot displace a live reattachment owner after its lease expires", async () => {
  const w = await world();
  const first = value(await w.orchestrator.manage()).binding;
  const claim = w.readRegistry((r) =>
    value(r.beginReattach(first.id, first.paneId, w.hooks.now, "2020-01-01")),
  );
  if (!claim.claimed) throw new Error("No claim");
  const afterLease = "2026-09-26T00:03:00.000Z";
  expect(
    w.readRegistry((r) =>
      value(r.beginReattach(first.id, first.paneId, afterLease, "2026-09-26T00:01:00.000Z", true)),
    ),
  ).toMatchObject({ claimed: false });
  expect(w.readRegistry((r) => value(r.ownsReattach(first.id, claim.token)))).toBe(true);
});

test("plain manage cannot displace a live bare-entry owner beyond the lease", async () => {
  const w = await world();
  const first = value(await w.orchestrator.manage()).binding;
  w.panes.set(first.paneId ?? "", { workspaceId: first.workspaceId ?? "" });
  const old = { HERDR_ENV: process.env["HERDR_ENV"], HERDR_PANE_ID: process.env["HERDR_PANE_ID"] };
  process.env["HERDR_ENV"] = "1";
  process.env["HERDR_PANE_ID"] = first.paneId ?? "";
  const atVerification = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const exit = Promise.withResolvers<number>();
  const deadline = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => deadline.reject(new Error("Mixed-entry verification deadline")),
    3000,
  );
  let kills = 0;
  w.hooks.beforeAttach = async () => {
    w.hooks.beforeAttach = undefined;
    atVerification.resolve();
    await release.promise;
  };
  const owner = new Orchestrator(w.root, "/fixture/herdr.sock", {
    ...w.deps,
    launchHere: (argv, cwd, env) => {
      const launch = w.deps.launchHere?.(argv, cwd, env);
      if (!launch) throw new Error("Missing fixture launcher");
      return {
        exited: launch.exited.then(() => exit.promise),
        kill() {
          kills++;
          exit.resolve(143);
        },
      };
    },
  });
  const attaching = owner.manage({ here: true });
  try {
    await Promise.race([atVerification.promise, deadline.promise]);
    w.hooks.now = "2026-09-26T00:03:00.000Z";
    expect(await w.orchestrator.manage({ here: true })).toMatchObject({
      ok: false,
      error: { code: "manager_busy" },
    });
    expect(value(await w.orchestrator.manage()).action).toBe("reattaching");
    expect(w.readRegistry((r) => value(r.reattachPending(first.id)))).toBe(true);
    release.resolve();
    expect(value(await Promise.race([attaching, deadline.promise])).action).toBe("reattached");
    expect(kills).toBe(0);
    expect(w.runs).toHaveLength(2);
  } finally {
    clearTimeout(timer);
    release.resolve();
    exit.resolve(0);
    await attaching;
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("displaced foreground entry never kills the manager TUI after verification", async () => {
  const w = await world();
  const first = value(await w.orchestrator.manage()).binding;
  w.panes.set(first.paneId ?? "", { workspaceId: first.workspaceId ?? "" });
  const old = { HERDR_ENV: process.env["HERDR_ENV"], HERDR_PANE_ID: process.env["HERDR_PANE_ID"] };
  process.env["HERDR_ENV"] = "1";
  process.env["HERDR_PANE_ID"] = first.paneId ?? "";
  const exit = Promise.withResolvers<number>();
  let kills = 0;
  w.hooks.beforeAttach = async () => {
    const db = new Database(join(w.root, ".omo/state/registry.sqlite"));
    try {
      db.query("UPDATE manager_reattach SET owner = 'successor-token'").run();
    } finally {
      db.close();
    }
  };
  const entry = new Orchestrator(w.root, "/fixture/herdr.sock", {
    ...w.deps,
    launchHere: (argv, cwd, env) => {
      void w.deps.launchHere?.(argv, cwd, env);
      return {
        exited: exit.promise,
        kill() {
          kills++;
          exit.resolve(143);
        },
      };
    },
  });
  try {
    expect(await entry.manage({ here: true })).toMatchObject({
      ok: false,
      error: { details: { reason: "lease_lost" } },
    });
    expect(kills).toBe(0);
  } finally {
    exit.resolve(0);
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)(
  "%s during ensureHost settles the unstarted reservation before retry",
  async (signal) => {
    const w = await world();
    const old = {
      HERDR_ENV: process.env["HERDR_ENV"],
      HERDR_PANE_ID: process.env["HERDR_PANE_ID"],
    };
    process.env["HERDR_ENV"] = "1";
    process.env["HERDR_PANE_ID"] = "caller:p1";
    w.workspaces.set("caller", { workspaceId: "caller", rootPaneId: "caller:p1", cwd: w.root });
    w.panes.set("caller:p1", { workspaceId: "caller" });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const noop = () => {};
    process.on(signal, noop);
    const interrupted = new Orchestrator(w.root, "/fixture/herdr.sock", {
      ...w.deps,
      ensureHost: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    const entry = interrupted.manage({ here: true });
    const deadline = Promise.withResolvers<never>();
    const timer = setTimeout(
      () => deadline.reject(new Error("Startup interruption not settled")),
      2000,
    );
    try {
      await Promise.race([entered.promise, deadline.promise]);
      expect(managers(value(w.orchestrator.status()))[0]?.launchState).toBe("reserved");
      process.emit(signal, signal);
      expect(await Promise.race([entry, deadline.promise])).toMatchObject({
        ok: false,
        error: { code: "manager_interrupted" },
      });
      expect(managers(value(w.orchestrator.status()))[0]?.launchState).toBe("closed");
      expect(w.runs).toHaveLength(0);
      release.resolve();
      await entry;
      expect(value(await w.orchestrator.manage({ here: true })).action).toBe("created");
      expect(w.runs).toHaveLength(1);
    } finally {
      clearTimeout(timer);
      release.resolve();
      await entry;
      process.off(signal, noop);
      for (const [key, value] of Object.entries(old)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  },
);

test.each(["SIGINT", "SIGTERM", "SIGHUP", "none"] as const)(
  "%s followed by rejecting a pre-launch subscription closes the never-launched manager",
  async (signal) => {
    const w = await world();
    const old = {
      HERDR_ENV: process.env["HERDR_ENV"],
      HERDR_PANE_ID: process.env["HERDR_PANE_ID"],
    };
    process.env["HERDR_ENV"] = "1";
    process.env["HERDR_PANE_ID"] = "caller:p1";
    w.workspaces.set("caller", { workspaceId: "caller", rootPaneId: "caller:p1", cwd: w.root });
    w.panes.set("caller:p1", { workspaceId: "caller" });
    const entered = Promise.withResolvers<void>();
    const subscription = Promise.withResolvers<() => void>();
    const deadline = Promise.withResolvers<never>();
    const timer = setTimeout(
      () => deadline.reject(new Error("Rejected startup settlement deadline")),
      3000,
    );
    const herdr = w.deps.createHerdrClient("/fixture/herdr.sock");
    const subscribe = herdr.subscribe;
    herdr.subscribe = () => {
      entered.resolve();
      return subscription.promise;
    };
    const pending = w.orchestrator.manage({ here: true });
    try {
      await Promise.race([entered.promise, deadline.promise]);
      const reserved = managers(value(w.orchestrator.status()))[0];
      if (!reserved) throw new Error("No startup reservation");
      if (signal !== "none") process.emit(signal, signal);
      subscription.reject(new Error("Herdr connection closed during subscription"));
      expect(await Promise.race([pending, deadline.promise])).toMatchObject({
        ok: false,
        error: { code: signal === "none" ? "runtime_unavailable" : "manager_interrupted" },
      });
      expect(w.runs).toHaveLength(0);
      expect(w.readRegistry((r) => value(r.get(reserved.id)))).toMatchObject({
        launchState: "closed",
        paneId: null,
        initialization: { state: "pending" },
      });
      expect(w.readRegistry((r) => value(r.reattachPending(reserved.id)))).toBe(false);
      herdr.subscribe = subscribe;
      expect(value(await w.orchestrator.manage({ here: true })).action).toBe("created");
      expect(w.runs).toHaveLength(1);
    } finally {
      clearTimeout(timer);
      subscription.resolve(() => {});
      await pending;
      herdr.subscribe = subscribe;
      for (const [key, value] of Object.entries(old)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  },
);

test.each(["reserved", "provisioning"] as const)(
  "bare entry reclaims a dead %s launch owner through a new fenced token",
  async (state) => {
    const w = await world();
    const first = value(await w.orchestrator.manage()).binding;
    const db = new Database(join(w.root, ".omo/state/registry.sqlite"));
    const child = Bun.spawn([process.execPath, "--eval", "process.exit(0)"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await child.exited;
    const claim = w.readRegistry((r) =>
      value(r.beginReattach(first.id, first.paneId, w.hooks.now, "2020-01-01")),
    );
    if (!claim.claimed) throw new Error("No claim");
    const unstarted = {
      ...first,
      launchState: state,
      sessionPath: null,
      initialization: { state: "pending", text: null },
    };
    db.query("UPDATE bindings SET launch_state = ?, json = ? WHERE id = ?").run(
      state,
      JSON.stringify(unstarted),
      first.id,
    );
    db.query("UPDATE manager_reattach SET owner_pid = ?").run(child.pid);
    db.close();
    w.panes.set(first.paneId ?? "", { workspaceId: first.workspaceId ?? "" });
    const old = {
      HERDR_ENV: process.env["HERDR_ENV"],
      HERDR_PANE_ID: process.env["HERDR_PANE_ID"],
    };
    process.env["HERDR_ENV"] = "1";
    process.env["HERDR_PANE_ID"] = first.paneId ?? "";
    w.workspaces.set("recovery", {
      workspaceId: "recovery",
      rootPaneId: "recovery:p1",
      cwd: w.root,
    });
    w.panes.set("recovery:p1", { workspaceId: "recovery" });
    process.env["HERDR_PANE_ID"] = "recovery:p1";
    try {
      expect(value(await w.orchestrator.manage({ here: true })).action).toBe("created");
      expect(w.readRegistry((r) => value(r.get(first.id))).launchState).toBe("closed");
      expect(w.readRegistry((r) => value(r.ownsReattach(first.id, claim.token)))).toBe(false);
    } finally {
      for (const [key, value] of Object.entries(old)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  },
);

test.each(["snapshot", "attach", "detach", "workspace-close"] as const)(
  "SIGTERM interrupts dead-owner recovery during %s and releases its token before the operation settles",
  async (phase) => {
    const w = await world();
    const first = value(await w.orchestrator.manage()).binding;
    const dead = Bun.spawn([process.execPath, "--eval", "process.exit(0)"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await dead.exited;
    const claim = w.readRegistry((r) =>
      value(r.beginReattach(first.id, first.paneId, w.hooks.now, "2020-01-01")),
    );
    if (!claim.claimed) throw new Error("Missing abandoned claim");
    const abandoned: Binding = {
      ...first,
      launchState: "provisioning",
      sessionPath: phase === "attach" || phase === "detach" ? first.sessionPath : null,
      initialization: { state: "pending", text: null },
    };
    const db = new Database(join(w.root, ".omo/state/registry.sqlite"));
    db.query("UPDATE bindings SET launch_state = 'provisioning', json = ? WHERE id = ?").run(
      JSON.stringify(abandoned),
      first.id,
    );
    db.query("UPDATE manager_reattach SET owner_pid = ? WHERE binding_id = ?").run(
      dead.pid,
      first.id,
    );
    w.panes.set(first.paneId ?? "", { workspaceId: first.workspaceId ?? "" });
    w.workspaces.set("recovery", {
      workspaceId: "recovery",
      rootPaneId: "recovery:p1",
      cwd: w.root,
    });
    w.panes.set("recovery:p1", { workspaceId: "recovery" });
    const old = {
      HERDR_ENV: process.env["HERDR_ENV"],
      HERDR_PANE_ID: process.env["HERDR_PANE_ID"],
    };
    process.env["HERDR_ENV"] = "1";
    process.env["HERDR_PANE_ID"] = "recovery:p1";
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const completed = Promise.withResolvers<void>();
    const deadline = Promise.withResolvers<never>();
    const timer = setTimeout(() => deadline.reject(new Error(`Recovery ${phase} deadline`)), 2000);
    const hold = async () => {
      entered.resolve();
      await release.promise;
    };
    const herdr = w.deps.createHerdrClient("/fixture/herdr.sock");
    const snapshot = herdr.snapshot.bind(herdr);
    const closeWorkspace = herdr.closeWorkspace.bind(herdr);
    let snapshots = 0;
    let workspaceCloses = 0;
    let nativeCloses = 0;
    herdr.snapshot = async () => {
      if (phase === "snapshot" && ++snapshots === 2) {
        await hold();
        completed.resolve();
      }
      return snapshot();
    };
    herdr.closeWorkspace = async (id) => {
      workspaceCloses++;
      if (phase === "workspace-close") await hold();
      await closeWorkspace(id);
      if (phase === "workspace-close") completed.resolve();
    };
    const deps: OrchestratorDependencies = {
      ...w.deps,
      attachBinding: async (binding) => {
        if (phase === "attach") await hold();
        const session = await w.deps.attachBinding(binding);
        return {
          ...session,
          close: async () => {
            if (phase === "detach") await hold();
            nativeCloses++;
            await session.close();
            completed.resolve();
          },
        };
      },
    };
    const stdout = spyOn(process.stdout, "write").mockReturnValue(true);
    const pending = runCli(["--root", w.root], deps);
    try {
      await Promise.race([entered.promise, deadline.promise]);
      process.kill(process.pid, "SIGTERM");
      expect(await Promise.race([pending, deadline.promise])).toBe(143);
      expect(JSON.parse(String(stdout.mock.calls.at(-1)?.[0]))).toMatchObject({
        ok: false,
        error: { code: "manager_interrupted" },
      });
      expect(w.readRegistry((r) => value(r.get(first.id)))).toEqual(abandoned);
      expect(
        db
          .query<{ claimed_at: string }, [string]>(
            "SELECT claimed_at FROM manager_reattach WHERE binding_id = ?",
          )
          .get(first.id)?.claimed_at,
      ).toBe("");
      expect(w.runs).toHaveLength(1);
      expect(workspaceCloses).toBe(phase === "workspace-close" ? 1 : 0);
      release.resolve();
      await Promise.race([completed.promise, deadline.promise]);
      expect(nativeCloses).toBe(phase === "attach" || phase === "detach" ? 1 : 0);
      expect(w.readRegistry((r) => value(r.get(first.id)))).toEqual(abandoned);
      expect(w.workspaces.has("recovery")).toBe(true);
    } finally {
      release.resolve();
      try {
        await pending;
        await Promise.race([completed.promise, deadline.promise]);
      } finally {
        clearTimeout(timer);
        herdr.snapshot = snapshot;
        herdr.closeWorkspace = closeWorkspace;
        stdout.mockRestore();
        db.close();
        for (const [key, value] of Object.entries(old)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    }
  },
);

test("moving an owned manager to a user pane retains its owned workspace for close", async () => {
  const w = await world();
  const first = value(await w.orchestrator.manage()).binding;
  w.panes.set(first.paneId ?? "", { workspaceId: first.workspaceId ?? "" });
  w.workspaces.set("user", { workspaceId: "user", rootPaneId: "user:p1", cwd: "/user" });
  w.panes.set("user:p1", { workspaceId: "user" });
  const old = { HERDR_ENV: process.env["HERDR_ENV"], HERDR_PANE_ID: process.env["HERDR_PANE_ID"] };
  process.env["HERDR_ENV"] = "1";
  process.env["HERDR_PANE_ID"] = "user:p1";
  try {
    const moved = value(await w.orchestrator.manage({ here: true })).binding;
    expect(moved).toMatchObject({
      workspaceId: "user",
      workspaceOwned: false,
      ownedWorkspaceId: first.workspaceId,
    });
    value(await w.orchestrator.close(first.id));
    expect(w.workspaces.has(first.workspaceId ?? "")).toBe(false);
    expect(w.workspaces.has("user")).toBe(true);
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test.each([false, true])(
  "round-trip owned workspace cleanup closes M exactly once and preserves U (stored legacy flag=%s)",
  async (legacyFlag) => {
    const w = await world();
    const first = value(await w.orchestrator.manage()).binding;
    if (!first.paneId || !first.workspaceId) throw new Error("Manager workspace missing");
    w.panes.set(first.paneId, { workspaceId: first.workspaceId });
    w.workspaces.set("user", { workspaceId: "user", rootPaneId: "user:p1", cwd: "/user" });
    w.panes.set("user:p1", { workspaceId: "user" });
    const old = {
      HERDR_ENV: process.env["HERDR_ENV"],
      HERDR_PANE_ID: process.env["HERDR_PANE_ID"],
    };
    process.env["HERDR_ENV"] = "1";
    process.env["HERDR_PANE_ID"] = "user:p1";
    const herdr = w.deps.createHerdrClient("/fixture/herdr.sock");
    const closed = spyOn(herdr, "closeWorkspace");
    try {
      value(await w.orchestrator.manage({ here: true }));
      w.panes.set("user:p1", { workspaceId: "user" });
      process.env["HERDR_PANE_ID"] = first.paneId;
      const returned = value(await w.orchestrator.manage({ here: true })).binding;
      if (legacyFlag) {
        const db = new Database(join(w.root, ".omo/state/registry.sqlite"));
        try {
          db.query("UPDATE bindings SET json = ? WHERE id = ?").run(
            JSON.stringify({ ...returned, workspaceOwned: false }),
            first.id,
          );
        } finally {
          db.close();
        }
      } else
        expect(returned).toMatchObject({
          workspaceId: first.workspaceId,
          ownedWorkspaceId: first.workspaceId,
          workspaceOwned: true,
        });
      value(await w.orchestrator.close(first.id));
      value(await w.orchestrator.close(first.id));
      expect(closed.mock.calls).toEqual([[first.workspaceId]]);
      expect(w.workspaces.has(first.workspaceId)).toBe(false);
      expect(w.workspaces.has("user")).toBe(true);
      expect(w.panes.has("user:p1")).toBe(true);
    } finally {
      closed.mockRestore();
      for (const [key, value] of Object.entries(old)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  },
);

test("here entry rejects an owned manager workspace whose cwd changed", async () => {
  const w = await world();
  const first = value(await w.orchestrator.manage()).binding;
  const owned = w.workspaces.get(first.workspaceId ?? "");
  if (owned === undefined) throw new Error("missing owned workspace");
  w.workspaces.set(owned.workspaceId, { ...owned, cwd: "/elsewhere" });
  w.panes.set(first.paneId ?? "", { workspaceId: owned.workspaceId, agent: "pi" });
  w.workspaces.set("user", { workspaceId: "user", rootPaneId: "user:p1", cwd: "/user" });
  w.panes.set("user:p1", { workspaceId: "user" });
  const old = { HERDR_ENV: process.env["HERDR_ENV"], HERDR_PANE_ID: process.env["HERDR_PANE_ID"] };
  process.env["HERDR_ENV"] = "1";
  process.env["HERDR_PANE_ID"] = "user:p1";
  try {
    const focusedBefore = w.focused.length;
    expect(await w.orchestrator.manage({ here: true })).toMatchObject({
      ok: false,
      error: { code: "manager_unavailable" },
    });
    expect(w.focused.length).toBe(focusedBefore);
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("a live pane reporting another session is not focused as the manager", async () => {
  const w = await world();
  const first = value(await w.orchestrator.manage()).binding;
  w.panes.set(first.paneId ?? "", {
    workspaceId: first.workspaceId ?? "",
    agent: "pi",
    sessionPath: "/other/session.jsonl",
  });
  const result = await w.orchestrator.manage();
  if (result.ok) expect(result.value.action).not.toBe("focused");
  expect(w.focused).not.toContain(first.paneId);
});

test("here entry rejects a different server even when its pane ID matches", async () => {
  const w = await world();
  const old = { HERDR_ENV: process.env["HERDR_ENV"], HERDR_PANE_ID: process.env["HERDR_PANE_ID"] };
  process.env["HERDR_ENV"] = "1";
  process.env["HERDR_PANE_ID"] = "caller:p1";
  w.workspaces.set("caller", { workspaceId: "caller", rootPaneId: "caller:p1", cwd: w.root });
  w.panes.set("caller:p1", { workspaceId: "caller" });
  try {
    const other = new Orchestrator(w.root, "/other/herdr.sock", w.deps);
    expect(await other.manage({ here: true })).toMatchObject({
      ok: false,
      error: { code: "herdr_context_mismatch" },
    });
    expect(w.runs).toHaveLength(0);
    expect(managers(value(w.orchestrator.status()))).toHaveLength(0);
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test.each(["live", "exited"] as const)(
  "here entry on server B leaves a %s manager on server A unchanged, then focus and close stay on A",
  async (tui) => {
    const a = await world();
    const b = await world();
    const manager = value(await a.orchestrator.manage()).binding;
    if (!manager.paneId || !manager.workspaceId) throw new Error("Missing manager location");
    if (tui === "exited") a.panes.set(manager.paneId, { workspaceId: manager.workspaceId });
    // Public pane/workspace IDs can collide on independent servers.
    b.workspaces.set(manager.workspaceId, {
      workspaceId: manager.workspaceId,
      rootPaneId: manager.paneId,
      cwd: a.root,
    });
    b.panes.set(manager.paneId, { workspaceId: manager.workspaceId });
    const serverA = a.deps.createHerdrClient("/fixture/herdr.sock");
    const serverB = b.deps.createHerdrClient("/server-b/herdr.sock");
    const deps: OrchestratorDependencies = {
      ...a.deps,
      createHerdrClient: (socket) => {
        if (socket === "/fixture/herdr.sock") return serverA;
        if (socket === "/server-b/herdr.sock") return serverB;
        throw new Error(`Unexpected server ${socket}`);
      },
      launchHere: () => {
        throw new Error("Cross-server foreground launch attempted");
      },
    };
    const old = {
      HERDR_ENV: process.env["HERDR_ENV"],
      HERDR_PANE_ID: process.env["HERDR_PANE_ID"],
      HERDR_SOCKET_PATH: process.env["HERDR_SOCKET_PATH"],
    };
    process.env["HERDR_ENV"] = "1";
    process.env["HERDR_PANE_ID"] = manager.paneId;
    process.env["HERDR_SOCKET_PATH"] = "/server-b/herdr.sock";
    const stdout = spyOn(process.stdout, "write").mockReturnValue(true);
    const closeA = spyOn(serverA, "closeWorkspace");
    const closeB = spyOn(serverB, "closeWorkspace");
    const db = new Database(join(a.root, ".omo/state/registry.sqlite"));
    db.run("CREATE TABLE binding_writes (id TEXT)");
    db.run(
      "CREATE TRIGGER record_binding_write AFTER UPDATE ON bindings BEGIN INSERT INTO binding_writes VALUES (NEW.id); END",
    );
    try {
      expect(await runCli(["--root", a.root], deps)).toBe(2);
      expect(JSON.parse(String(stdout.mock.calls.at(-1)?.[0]))).toMatchObject({
        ok: false,
        error: {
          code: "herdr_server_mismatch",
          details: { managerSocket: "/fixture/herdr.sock", callerSocket: "/server-b/herdr.sock" },
        },
      });
      expect(
        db.query<{ count: number }, []>("SELECT count(*) AS count FROM binding_writes").get()
          ?.count,
      ).toBe(0);
      expect(a.readRegistry((r) => value(r.get(manager.id)))).toEqual(manager);
      expect(a.readRegistry((r) => value(r.reattachPending(manager.id)))).toBe(false);
      expect(a.focused).toEqual([]);
      expect(b.focused).toEqual([]);
      expect(a.runs).toHaveLength(1);
      expect(b.runs).toHaveLength(0);
      // The supported original-server entry and explicit close still resolve A, never B.
      process.env["HERDR_SOCKET_PATH"] = "/fixture/herdr.sock";
      expect(value(await a.orchestrator.manage({ here: true })).action).toBe(
        tui === "live" ? "focused" : "reattached",
      );
      expect(value(await a.orchestrator.manage({ here: true })).action).toBe("focused");
      const fromB = new Orchestrator(a.root, "/server-b/herdr.sock", deps);
      value(await fromB.close(manager.id));
      expect(closeA.mock.calls).toEqual([[manager.workspaceId]]);
      expect(closeB).not.toHaveBeenCalled();
      expect(b.workspaces.has(manager.workspaceId)).toBe(true);
      expect(b.panes.has(manager.paneId)).toBe(true);
    } finally {
      db.close();
      stdout.mockRestore();
      closeA.mockRestore();
      closeB.mockRestore();
      for (const [key, value] of Object.entries(old)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  },
);

test.each(["host", "snapshot", "verification"] as const)(
  "SIGTERM during existing-manager %s returns 143 without focus or launching a child",
  async (phase) => {
    const w = await world();
    const manager = value(await w.orchestrator.manage()).binding;
    if (phase === "verification") {
      const pending = w.readRegistry((r) =>
        value(r.beginReattach(manager.id, manager.paneId, w.hooks.now, "2020-01-01")),
      );
      if (!pending.claimed) throw new Error("Missing fixture reattachment claim");
      w.readRegistry((r) => value(r.releaseReattach(manager.id, pending.token)));
    }
    const old = {
      HERDR_ENV: process.env["HERDR_ENV"],
      HERDR_PANE_ID: process.env["HERDR_PANE_ID"],
    };
    process.env["HERDR_ENV"] = "1";
    process.env["HERDR_PANE_ID"] = manager.paneId ?? "";
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const deadline = Promise.withResolvers<never>();
    const timer = setTimeout(
      () => deadline.reject(new Error(`Interrupted ${phase} deadline`)),
      2000,
    );
    const hold = async () => {
      entered.resolve();
      await release.promise;
    };
    const herdr = w.deps.createHerdrClient("/fixture/herdr.sock");
    const snapshot = herdr.snapshot.bind(herdr);
    let snapshots = 0;
    herdr.snapshot = async () => {
      snapshots++;
      // First snapshot validates the caller; the second inspects the existing manager.
      if (phase === "snapshot" && snapshots === 2) await hold();
      return snapshot();
    };
    if (phase === "verification") w.hooks.beforeAttach = hold;
    let launches = 0;
    const deps: OrchestratorDependencies = {
      ...w.deps,
      ...(phase === "host" ? { checkHostProfile: hold } : {}),
      launchHere: () => {
        launches++;
        throw new Error("Focus-only entry launched a child");
      },
    };
    const stdout = spyOn(process.stdout, "write").mockReturnValue(true);
    const entry = runCli(["--root", w.root], deps);
    try {
      await Promise.race([entered.promise, deadline.promise]);
      process.kill(process.pid, "SIGTERM");
      expect(await Promise.race([entry, deadline.promise])).toBe(143);
      expect(JSON.parse(String(stdout.mock.calls.at(-1)?.[0]))).toMatchObject({
        ok: false,
        error: { code: "manager_interrupted", details: { exitCode: 143 } },
      });
      expect(w.focused).toEqual([]);
      expect(launches).toBe(0);
      expect(w.runs).toHaveLength(1);
      expect(w.readRegistry((r) => value(r.get(manager.id)))).toEqual(manager);
      release.resolve();
      w.hooks.beforeAttach = undefined;
      herdr.snapshot = snapshot;
      expect(value(await w.orchestrator.manage({ here: true })).action).toBe("focused");
    } finally {
      clearTimeout(timer);
      release.resolve();
      await entry;
      herdr.snapshot = snapshot;
      w.hooks.beforeAttach = undefined;
      stdout.mockRestore();
      for (const [key, value] of Object.entries(old)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  },
);

test("focus completion cannot report success after SIGTERM", async () => {
  const w = await world();
  const manager = value(await w.orchestrator.manage()).binding;
  const old = { HERDR_ENV: process.env["HERDR_ENV"], HERDR_PANE_ID: process.env["HERDR_PANE_ID"] };
  process.env["HERDR_ENV"] = "1";
  process.env["HERDR_PANE_ID"] = manager.paneId ?? "";
  const herdr = w.deps.createHerdrClient("/fixture/herdr.sock");
  const focus = herdr.focusPane;
  herdr.focusPane = async () => {
    process.emit("SIGTERM", "SIGTERM");
  };
  const stdout = spyOn(process.stdout, "write").mockReturnValue(true);
  try {
    expect(await runCli(["--root", w.root], w.deps)).toBe(143);
  } finally {
    herdr.focusPane = focus;
    stdout.mockRestore();
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("here entry rejects a pane whose terminal does not contain the caller process", async () => {
  const w = await world();
  const old = { HERDR_ENV: process.env["HERDR_ENV"], HERDR_PANE_ID: process.env["HERDR_PANE_ID"] };
  process.env["HERDR_ENV"] = "1";
  process.env["HERDR_PANE_ID"] = "caller:p1";
  w.workspaces.set("caller", { workspaceId: "caller", rootPaneId: "caller:p1", cwd: w.root });
  w.panes.set("caller:p1", { workspaceId: "caller" });
  const herdr = w.deps.createHerdrClient("/fixture/herdr.sock");
  Object.assign(herdr, { paneContainsProcess: async () => false });
  try {
    expect(await w.orchestrator.manage({ here: true })).toMatchObject({
      ok: false,
      error: { code: "herdr_context_mismatch" },
    });
    expect(w.runs).toHaveLength(0);
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("bare olw outside Herdr fails before creating state; help remains available", async () => {
  const root = await mkdtemp(join(tmpdir(), "olw-entry-cli-"));
  roots.push(root);
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "../src/cli.ts"), "--root", root],
    {
      env: { ...process.env, HERDR_ENV: undefined, HERDR_PANE_ID: undefined },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  expect(code).toBe(2);
  expect(JSON.parse(stdout)).toMatchObject({ ok: false, error: { code: "herdr_required" } });
  expect(await Bun.file(join(root, ".omo/state/registry.sqlite")).exists()).toBe(false);
});

test("bare olw launches in the caller pane, focuses it, then reattaches there without owning the workspace", async () => {
  const w = await world();
  const old = { HERDR_ENV: process.env["HERDR_ENV"], HERDR_PANE_ID: process.env["HERDR_PANE_ID"] };
  const stdout = spyOn(process.stdout, "write").mockReturnValue(true);
  w.workspaces.set("caller", {
    workspaceId: "caller",
    rootPaneId: "caller:p1",
    cwd: process.cwd(),
  });
  w.panes.set("caller:p1", { workspaceId: "caller" });
  w.workspaces.set("second", { workspaceId: "second", rootPaneId: "second:p1", cwd: "/other" });
  w.panes.set("second:p1", { workspaceId: "second" });
  try {
    process.env["HERDR_ENV"] = "1";
    process.env["HERDR_PANE_ID"] = "caller:p1";
    expect(await runCli(["--root", w.root], w.deps)).toBe(0);
    const first = managers(value(w.orchestrator.status()))[0];
    if (!first) throw new Error("No manager");
    expect(first).toMatchObject({
      paneId: "caller:p1",
      workspaceId: "caller",
      cwd: process.cwd(),
      workspaceOwned: false,
    });
    expect(w.created).toHaveLength(0);
    expect(w.tabs).toHaveLength(0);
    process.env["HERDR_PANE_ID"] = "second:p1";
    expect(await runCli(["--root", w.root], w.deps)).toBe(0);
    expect(w.runs).toHaveLength(1);
    expect(w.focused.at(-1)).toBe("caller:p1");
    w.panes.delete("caller:p1");
    w.workspaces.delete("caller");
    expect(await runCli(["--root", w.root], w.deps)).toBe(0);
    expect(managers(value(w.orchestrator.status()))[0]).toMatchObject({
      id: first.id,
      durableSessionId: first.durableSessionId,
      sessionPath: first.sessionPath,
      workspaceId: "second",
      paneId: "second:p1",
      workspaceOwned: false,
    });
    expect(w.runs).toHaveLength(2);
    expect(w.created).toHaveLength(0);
    expect(w.tabs).toHaveLength(0);
    value(await w.orchestrator.close(first.id));
    expect(w.workspaces.has("second")).toBe(true);
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    stdout.mockRestore();
  }
});

test("foreground exit before readiness returns its code and releases the singleton immediately", async () => {
  const w = await world();
  const old = { HERDR_ENV: process.env["HERDR_ENV"], HERDR_PANE_ID: process.env["HERDR_PANE_ID"] };
  const output = spyOn(process.stdout, "write").mockReturnValue(true);
  w.workspaces.set("caller", { workspaceId: "caller", rootPaneId: "caller:p1", cwd: w.root });
  w.panes.set("caller:p1", { workspaceId: "caller" });
  process.env["HERDR_ENV"] = "1";
  process.env["HERDR_PANE_ID"] = "caller:p1";
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const deadline = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => deadline.reject(new Error("Foreground exit was not observed")),
    3000,
  );
  try {
    const code = await Promise.race([
      runCli(["--root", w.root], {
        ...w.deps,
        launchHere: () => {
          child = Bun.spawn([process.execPath, "--eval", "process.exit(37)"], {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
          });
          return child;
        },
      }),
      deadline.promise,
    ]);
    expect(code).toBe(37);
    expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toMatchObject({
      ok: false,
      error: { code: "manager_tui_exited", details: { exitCode: 37 } },
    });
    expect(managers(value(w.orchestrator.status()))[0]?.launchState).toBe("closed");
    expect(await runCli(["--root", w.root], w.deps)).toBe(0);
    expect(
      managers(value(w.orchestrator.status())).filter((b) => b.launchState === "ready"),
    ).toHaveLength(1);
  } finally {
    clearTimeout(timer);
    child?.kill();
    if (child) await child.exited;
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    output.mockRestore();
  }
});

test("foreground exit after readiness preserves the child status", async () => {
  const w = await world();
  const old = { HERDR_ENV: process.env["HERDR_ENV"], HERDR_PANE_ID: process.env["HERDR_PANE_ID"] };
  w.workspaces.set("caller", { workspaceId: "caller", rootPaneId: "caller:p1", cwd: w.root });
  w.panes.set("caller:p1", { workspaceId: "caller" });
  process.env["HERDR_ENV"] = "1";
  process.env["HERDR_PANE_ID"] = "caller:p1";
  const exit = Promise.withResolvers<number>();
  const initialized = Promise.withResolvers<void>();
  const running = runCli(["--root", w.root], {
    ...w.deps,
    launchHere: (argv, cwd, env) => {
      void w.deps.launchHere?.(argv, cwd, env);
      return { exited: exit.promise, kill() {} };
    },
    prompt: async (binding, text) => {
      await w.deps.prompt(binding, text);
      initialized.resolve();
    },
  });
  const timer = setTimeout(() => initialized.reject(new Error("Initialization deadline")), 3000);
  try {
    await initialized.promise;
    exit.resolve(37);
    expect(await running).toBe(37);
  } finally {
    clearTimeout(timer);
    exit.resolve(37);
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("bare entry takes over a dead reattach owner and reports a live owner as manager_busy", async () => {
  const w = await world();
  const first = value(await w.orchestrator.manage()).binding;
  const old = { HERDR_ENV: process.env["HERDR_ENV"], HERDR_PANE_ID: process.env["HERDR_PANE_ID"] };
  const output = spyOn(process.stdout, "write").mockReturnValue(true);
  process.env["HERDR_ENV"] = "1";
  process.env["HERDR_PANE_ID"] = first.paneId ?? "";
  const dead = Bun.spawn([process.execPath, "--eval", "process.exit(0)"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await dead.exited;
  w.readRegistry((r) => value(r.beginReattach(first.id, first.paneId, w.hooks.now, "2020-01-01")));
  const db = new Database(join(w.root, ".omo/state/registry.sqlite"));
  try {
    // Old registries have no PID column; the regression also covers the migration.
    const columns = db.query<{ name: string }, []>("PRAGMA table_info(manager_reattach)").all();
    if (!columns.some((c) => c.name === "owner_pid"))
      db.run("ALTER TABLE manager_reattach ADD COLUMN owner_pid INTEGER");
    db.query("UPDATE manager_reattach SET owner_pid = ?").run(process.pid);
    expect(await runCli(["--root", w.root], w.deps)).toBe(3);
    expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toMatchObject({
      ok: false,
      error: { code: "manager_busy" },
    });
    db.query("UPDATE manager_reattach SET owner_pid = ?").run(dead.pid);
    w.panes.set(first.paneId ?? "", { workspaceId: first.workspaceId ?? "" });
    expect(await runCli(["--root", w.root], w.deps)).toBe(0);
    expect(w.runs).toHaveLength(2);
    expect(w.readRegistry((r) => value(r.reattachPending(first.id)))).toBe(false);
  } finally {
    db.close();
    output.mockRestore();
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("bare entry takes over a recycled PID while the unrelated process stays alive and fences its old token", async () => {
  const w = await world();
  const first = value(await w.orchestrator.manage()).binding;
  w.panes.set(first.paneId ?? "", { workspaceId: first.workspaceId ?? "" });
  const old = { HERDR_ENV: process.env["HERDR_ENV"], HERDR_PANE_ID: process.env["HERDR_PANE_ID"] };
  const output = spyOn(process.stdout, "write").mockReturnValue(true);
  const child = Bun.spawn([process.execPath, "--eval", "process.stdin.resume();"], {
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore",
  });
  const db = new Database(join(w.root, ".omo/state/registry.sqlite"));
  try {
    const claim = w.readRegistry((r) =>
      value(r.beginReattach(first.id, first.paneId, w.hooks.now, "2020-01-01")),
    );
    if (!claim.claimed) throw new Error("Manager reattachment not claimed");
    const columns = db.query<{ name: string }, []>("PRAGMA table_info(manager_reattach)").all();
    expect(columns.some((column) => column.name === "owner_starttime")).toBe(true);
    const stat = await readFile(`/proc/${process.pid}/stat`, "utf8");
    const starttime = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19];
    if (starttime === undefined) throw new Error("Missing current process start time");
    expect(
      db
        .query<{ owner_pid: number; owner_starttime: string }, []>(
          "SELECT owner_pid, owner_starttime FROM manager_reattach",
        )
        .get(),
    ).toEqual({ owner_pid: process.pid, owner_starttime: starttime });
    const unrelatedStat = await readFile(`/proc/${child.pid}/stat`, "utf8");
    const unrelatedStart = unrelatedStat.slice(unrelatedStat.lastIndexOf(")") + 2).split(/\s+/)[19];
    if (unrelatedStart === undefined) throw new Error("Missing fixture process start time");
    db.query("UPDATE manager_reattach SET owner_pid = ?, owner_starttime = ?").run(
      child.pid,
      unrelatedStart,
    );
    process.env["HERDR_ENV"] = "1";
    process.env["HERDR_PANE_ID"] = first.paneId ?? "";
    // A matching generation remains a live owner, even before an agent appears.
    expect(await runCli(["--root", w.root], w.deps)).toBe(3);
    expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toMatchObject({
      ok: false,
      error: { code: "manager_busy" },
    });
    // Model the persisted identity of an older process at this now-recycled PID.
    db.query("UPDATE manager_reattach SET owner_starttime = ?").run(
      (BigInt(unrelatedStart) + 1n).toString(),
    );
    expect(await runCli(["--root", w.root], w.deps)).toBe(0);
    expect(child.exitCode).toBeNull();
    expect(w.runs).toHaveLength(2);
    expect(w.readRegistry((r) => value(r.ownsReattach(first.id, claim.token)))).toBe(false);
    expect(
      w.readRegistry((r) => r.recordReattachPane(first.id, claim.token, "stale:pane")),
    ).toMatchObject({ ok: false, error: { code: "lease_lost" } });
    expect(w.readRegistry((r) => value(r.finishReattach(first.id, claim.token)))).toBe(false);
  } finally {
    child.kill();
    await child.exited;
    db.close();
    output.mockRestore();
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("legacy reattachment rows migrate with unknown start time and retain PID-only liveness", async () => {
  const w = await world();
  const first = value(await w.orchestrator.manage()).binding;
  const held = w.readRegistry((r) =>
    value(r.beginReattach(first.id, first.paneId, w.hooks.now, "2020-01-01")),
  );
  if (!held.claimed) throw new Error("No fixture reattachment claim");
  const db = new Database(join(w.root, ".omo/state/registry.sqlite"));
  const child = Bun.spawn([process.execPath, "--eval", "process.stdin.resume();"], {
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    // Recreate the actual prior schema, rather than adding the new column in the test.
    db.run("ALTER TABLE manager_reattach RENAME TO saved_reattach");
    db.run(
      "CREATE TABLE manager_reattach (binding_id TEXT PRIMARY KEY REFERENCES bindings(id), claimed_at TEXT NOT NULL, owner TEXT NOT NULL, owner_pid INTEGER)",
    );
    db.run(
      "INSERT INTO manager_reattach SELECT binding_id, claimed_at, owner, owner_pid FROM saved_reattach",
    );
    db.run("DROP TABLE saved_reattach");
    db.query("UPDATE manager_reattach SET owner_pid = ?").run(child.pid);
    // Read-only inspection must not migrate a legacy registry.
    const readonly = openRegistry(join(w.root, ".omo/state/registry.sqlite"), { readonly: true });
    readonly.close();
    expect(
      db
        .query<{ name: string }, []>("PRAGMA table_info(manager_reattach)")
        .all()
        .some((c) => c.name === "owner_starttime"),
    ).toBe(false);
    const live = w.readRegistry((r) =>
      value(r.beginReattach(first.id, first.paneId, w.hooks.now, "2020-01-01", true)),
    );
    expect(live.claimed).toBe(false);
    expect(
      db
        .query<{ owner_starttime: string | null }, []>(
          "SELECT owner_starttime FROM manager_reattach",
        )
        .get()?.owner_starttime,
    ).toBeNull();
    child.kill();
    await child.exited;
    const reclaimed = w.readRegistry((r) =>
      value(r.beginReattach(first.id, first.paneId, w.hooks.now, "2020-01-01", true)),
    );
    expect(reclaimed.claimed).toBe(true);
    expect(w.readRegistry((r) => value(r.ownsReattach(first.id, held.token)))).toBe(false);
    expect(
      db
        .query<{ owner_pid: number; owner_starttime: string }, []>(
          "SELECT owner_pid, owner_starttime FROM manager_reattach",
        )
        .get(),
    ).toMatchObject({ owner_pid: process.pid, owner_starttime: expect.stringMatching(/^\d+$/) });
  } finally {
    child.kill();
    await child.exited;
    db.close();
  }
});

test.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)(
  "foreground %s releases unfinished reattachment and forwards to the child",
  async (signal) => {
    const w = await world();
    const first = value(await w.orchestrator.manage()).binding;
    w.panes.set(first.paneId ?? "", { workspaceId: first.workspaceId ?? "" });
    const old = {
      HERDR_ENV: process.env["HERDR_ENV"],
      HERDR_PANE_ID: process.env["HERDR_PANE_ID"],
    };
    process.env["HERDR_ENV"] = "1";
    process.env["HERDR_PANE_ID"] = first.paneId ?? "";
    const attached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    w.hooks.beforeAttach = async () => {
      attached.resolve();
      await release.promise;
    };
    let child: ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">> | undefined;
    const forwarded: NodeJS.Signals[] = [];
    // Keep the RED probe from terminating Bun when no production handler exists yet.
    const observeOnly = () => {};
    process.on(signal, observeOnly);
    let signalDeadline: ReturnType<typeof setTimeout> | undefined;
    const orchestrator = new Orchestrator(w.root, "/fixture/herdr.sock", {
      ...w.deps,
      launchHere: (argv, cwd, env) => {
        void w.deps.launchHere?.(argv, cwd, env);
        child = Bun.spawn(
          [
            process.execPath,
            "--eval",
            `process.on(${JSON.stringify(signal)}, () => process.exit(143)); process.stdout.write('ready'); process.stdin.resume();`,
          ],
          { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
        );
        const launched = child;
        return {
          exited: launched.exited,
          kill: (sig) => {
            if (sig) forwarded.push(sig);
            launched.kill(sig);
          },
        };
      },
    });
    const pending = orchestrator.manage({ here: true });
    const timer = setTimeout(
      () => attached.reject(new Error("Reattachment verification deadline")),
      3000,
    );
    try {
      await attached.promise;
      if (!child) throw new Error("Foreground child missing");
      const reader = child.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("ready");
      reader.releaseLock();
      expect(w.readRegistry((r) => value(r.reattachPending(first.id)))).toBe(true);
      process.emit(signal, signal);
      // Do not await held native verification: interruption must settle independently.
      const result = await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          signalDeadline = setTimeout(
            () => reject(new Error("Signal did not settle the entry")),
            1000,
          );
        }),
      ]);
      expect(result).toMatchObject({ ok: false, error: { code: "manager_interrupted" } });
      expect(forwarded).toEqual([signal]);
      w.hooks.beforeAttach = undefined;
      release.resolve();
      w.panes.set(first.paneId ?? "", { workspaceId: first.workspaceId ?? "" });
      expect(value(await w.orchestrator.manage()).action).toBe("reattached");
    } finally {
      clearTimeout(timer);
      clearTimeout(signalDeadline);
      process.off(signal, observeOnly);
      child?.kill();
      if (child) await child.exited;
      release.resolve();
      for (const [key, value] of Object.entries(old)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  },
);

test("a hanging injected update check cannot delay manager creation or focus", async () => {
  const w = await world();
  const timers: Array<{
    callback: () => void;
    cleared: boolean;
    handle: ReturnType<typeof setTimeout>;
  }> = [];
  let now = 0;
  let calls = 0;
  const checkEntered = Promise.withResolvers<void>();
  w.hooks.updateCheck = () => {
    calls += 1;
    checkEntered.resolve();
    return new Promise<import("../src/update/check").UpdateCheck>(() => {});
  };
  w.hooks.updateTimer = {
    now: () => now,
    setTimeout(callback) {
      const handle = setTimeout(() => {}, 2_147_483_647);
      handle.unref();
      timers.push({ callback, cleared: false, handle });
      return handle;
    },
    clearTimeout(handle) {
      clearTimeout(handle);
      const timer = timers.find((candidate) => candidate.handle === handle);
      if (timer !== undefined) timer.cleared = true;
    },
  };
  const firstPromise = w.orchestrator.manage();
  await checkEntered.promise;
  const firstTimer = timers[0];
  if (firstTimer === undefined) throw new Error("Manage deadline was not scheduled");
  now = 20_000;
  firstTimer.callback();
  const first = value(await firstPromise);
  expect(calls).toBe(1);
  expect(first.action).toBe("created");
  expect(first.updateCheck.state).toBe("unknown");
  expect(w.created).toHaveLength(1);
  w.hooks.updateCheck = async () => ({
    checkedAt: "2026-09-26T00:00:00.000Z",
    state: "current",
    packages: {
      "omo-ai": { state: "current", pinned: "1.0.0", available: "1.0.0", tag: "beta" },
      "@code-yeongyu/senpi": {
        state: "current",
        pinned: "1.0.0",
        available: "1.0.0",
        tag: "latest",
      },
    },
    globalOmo: "1.0.0",
  });
  const second = value(await w.orchestrator.manage());
  expect(second.action).toBe("focused");
});

test("manage reports the manager model source and rejects malformed settings before launch", async () => {
  const fallbackWorld = await world();
  await rm(fallbackWorld.settingsPath);
  const fallback = value(await fallbackWorld.orchestrator.manage());
  expect(fallback.modelSource).toBe("fallback_no_default");
  expect(fallbackWorld.created).toHaveLength(1);

  const invalidWorld = await world();
  await Bun.write(invalidWorld.settingsPath, "{invalid");
  const invalid = await invalidWorld.orchestrator.manage();
  expect(invalid).toMatchObject({
    ok: false,
    error: {
      code: "manager_settings_error",
      details: { settingsPath: invalidWorld.settingsPath },
    },
  });
  expect(invalidWorld.created).toHaveLength(0);
  expect(invalidWorld.runs).toHaveLength(0);
});

test("manager create passes real-shaped update versions once into its brief", async () => {
  const w = await world();
  w.hooks.updateCheck = async () => ({
    checkedAt: "2026-09-26T00:00:00.000Z",
    state: "available",
    packages: {
      "omo-ai": {
        state: "update_available",
        pinned: "5.0.0-beta.84",
        available: "5.0.0-beta.90",
        tag: "beta",
      },
      "@code-yeongyu/senpi": {
        state: "update_available",
        pinned: "2026.9.22-4",
        available: "2026.9.25-1",
        tag: "latest",
      },
    },
    globalOmo: "5.0.0-beta.84",
  });

  const first = value(await w.orchestrator.manage());
  const managerBrief = w.prompts.get(first.binding.id)?.values().next().value;
  if (managerBrief === undefined) throw new Error("Manager brief was not initialized");
  const updateLines = managerBrief.split("\n").filter((line) => line.startsWith("update_check: "));
  expect(updateLines).toHaveLength(1);
  expect(updateLines[0]).toContain("omo-ai pinned 5.0.0-beta.84, beta 5.0.0-beta.90");
  expect(updateLines[0]).toContain("@code-yeongyu/senpi pinned 2026.9.22-4, latest 2026.9.25-1");
  expect(updateLines[0]).not.toContain("undefined");
  expect(managerBrief.split("\n").filter((line) => line.startsWith("routing_advice: "))).toEqual([
    "routing_advice: none",
  ]);
});

test.each(["pi", "omo"])(
  "manage with %s creates one manager then focuses without relaunch",
  async (agent) => {
    const w = await world(agent);
    const first = value(await w.orchestrator.manage());
    expect(first.action).toBe("created");
    expect(first.updateCheck.state).toBe("current");
    expect(first.binding).toMatchObject({
      assignment: { role: "manager" },
      launchState: "ready",
      designationId: "manager",
      cwd: w.root,
    });
    expect(w.created).toEqual([{ cwd: w.root, label: "manager" }]);
    expect(w.runs).toHaveLength(1);
    const argv = w.runs[0]?.argv ?? [];
    expect(argv).toContain(`OLW_MANAGER_BINDING=${first.binding.id}`);
    expect(argv[argv.indexOf("--name") + 1]).toBe("manager");
    expect(argv[argv.indexOf("--model") + 1]).toBe("fixture-provider/fixture-model");
    expect(argv[argv.indexOf("--thinking") + 1]).toBe("high");
    expect(argv).not.toContain("--no-model-fallback");
    const managerBrief = w.prompts.get(first.binding.id)?.values().next().value;
    if (managerBrief === undefined) throw new Error("Manager brief was not initialized");
    const updateLines = managerBrief
      .split("\n")
      .filter((line) => line.startsWith("update_check: "));
    expect(updateLines).toHaveLength(1);
    expect(updateLines[0]).toContain("omo-ai pinned 1.0.0, beta 1.0.0");
    expect(updateLines[0]).toContain("@code-yeongyu/senpi pinned 1.0.0, latest 1.0.0");
    expect(updateLines[0]).not.toContain("undefined");
    expect(w.focused).toEqual([]);

    w.hooks.hangingUpdateCheck = false;
    const second = value(await w.orchestrator.manage());
    expect(second.action).toBe("focused");
    expect(second.updateCheck.state).toBe("current");
    expect(second.binding.id).toBe(first.binding.id);
    expect(w.runs).toHaveLength(1);
    expect(w.created).toHaveLength(1);
    expect(w.tabs).toEqual([]);
    expect(w.focused).toEqual([first.binding.workspaceId ?? "missing-workspace"]);
    expect(managers(value(w.orchestrator.status()))).toHaveLength(1);
  },
);

test.each(["pi", "omo"])("manage reattaches %s in a new tab with the same env", async (agent) => {
  const w = await world(agent);
  const first = value(await w.orchestrator.manage());
  const launch = w.runs[0];
  if (launch === undefined || first.binding.paneId === null) throw new Error("No launch");
  w.panes.delete(first.binding.paneId);

  const reattached = value(await w.orchestrator.manage());

  expect(reattached.action).toBe("reattached");
  expect(reattached.binding.id).toBe(first.binding.id);
  const workspaceId = first.binding.workspaceId ?? "";
  expect(w.tabs).toEqual([{ workspaceId, cwd: w.root, label: "manager" }]);
  expect(w.runs).toHaveLength(2);
  const rerun = w.runs[1];
  expect(rerun?.paneId).toBe(`${workspaceId}:tp1`);
  expect(rerun?.env).toEqual(launch.env);
  expect(rerun?.env).toEqual({
    PATH: expect.stringContaining(join(w.root, ".managed-herdr")),
    ...runtimeCacheEnvironment(w.root),
  });
  const rerunArgv = rerun?.argv ?? [];
  expect(rerunArgv[rerunArgv.indexOf("--session") + 1]).toBe(first.binding.sessionPath ?? "");
  const envPrefix = (argv: readonly string[]): string[] => [
    ...argv.slice(0, argv.indexOf("-e") - 1),
  ];
  expect(envPrefix(rerunArgv)).toEqual(envPrefix(launch.argv));
  expect(rerunArgv).toContain(`OLW_MANAGER_BINDING=${first.binding.id}`);
  expect(reattached.binding.paneId).toBe(`${workspaceId}:tp1`);
  expect(w.focused).toEqual([workspaceId]);
  expect(w.created).toHaveLength(1);
  expect(managers(value(w.orchestrator.status()))).toHaveLength(1);

  const again = value(await w.orchestrator.manage());
  expect(again.action).toBe("focused");
  expect(w.runs).toHaveLength(2);
});

test("a failed Herdr republish does not fail reattach or kill the new manager TUI", async () => {
  const w = await world();
  const first = value(await w.orchestrator.manage());
  w.panes.delete(first.binding.paneId ?? "");
  let kills = 0;
  const orchestrator = new Orchestrator(w.root, "/fixture/herdr.sock", {
    ...w.deps,
    launchHere: (argv, cwd, env) => {
      void w.deps.launchHere?.(argv, cwd, env);
      return { exited: new Promise<number>(() => {}), kill: () => void kills++ };
    },
    republishHerdrState: async () => {
      throw new Error("republish unavailable");
    },
  });

  const result = await orchestrator.manage();

  expect(value(result).action).toBe("reattached");
  expect(kills).toBe(0);
  expect(w.runs).toHaveLength(2);
});

test("manage relaunches when the recorded pane survives but its TUI exited", async () => {
  const w = await world();
  const first = value(await w.orchestrator.manage());
  const paneId = first.binding.paneId ?? "";
  const pane = w.panes.get(paneId);
  if (pane === undefined) throw new Error("No manager pane");
  w.panes.set(paneId, { workspaceId: pane.workspaceId });

  const result = value(await w.orchestrator.manage());

  expect(result.action).toBe("reattached");
  expect(w.tabs).toHaveLength(1);
  expect(w.runs).toHaveLength(2);
});

test("manage resolves a missing managed Herdr artifact as runtime_unavailable", async () => {
  const w = await world();
  value(await w.orchestrator.manage());
  const orchestrator = new Orchestrator(w.root, "/fixture/herdr.sock", {
    ...w.deps,
    resolveHerdrArtifact: async () => {
      throw new Error("managed Herdr artifact missing");
    },
  });
  await expect(orchestrator.manage()).resolves.toMatchObject({
    ok: false,
    error: { code: "runtime_unavailable", details: "managed Herdr artifact missing" },
  });
});

test("manage refuses an incompatible host before focusing or reattaching", async () => {
  const w = await world();
  const first = value(await w.orchestrator.manage());
  let checks = 0;
  w.hooks.hostCheck = () => {
    checks += 1;
    throw new HostProfileMismatchError({
      missingExtensions: [],
      missingCapabilities: ["olw_extension_protocol_2"],
      generation: 1,
      sessions: {
        total: 1,
        interactive: 1,
        worker: 0,
        retained: 0,
        foreign_attached: 0,
        foreign_retained: 0,
      },
      actualProfile: null,
      recovery: { automatic: false, argv: ["omo", "host", "handoff"], env: {} },
    });
  };
  const mismatch = {
    ok: false,
    error: {
      code: "runtime_unavailable",
      details: {
        reason: "host_profile_mismatch",
        recovery: { automatic: false, argv: ["omo", "host", "handoff"] },
      },
    },
  };

  expect(await w.orchestrator.manage()).toMatchObject(mismatch);
  w.panes.delete(first.binding.paneId ?? "");
  expect(await w.orchestrator.manage()).toMatchObject(mismatch);

  expect(checks).toBe(4);
  expect(w.focused).toEqual([]);
  expect(w.tabs).toEqual([]);
  expect(w.runs).toHaveLength(1);
  expect(value(w.orchestrator.status())[0]?.paneId).toBe(first.binding.paneId);
});

test.each(["sessions", "unreadable"] as const)(
  "bare entry keeps a mismatched host with %s and uses human TTY output unless --json is passed",
  async (condition) => {
    const w = await world();
    const first = value(await w.orchestrator.manage()).binding;
    const output = spyOn(process.stdout, "write").mockReturnValue(true);
    const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    w.hooks.hostCheck = () => {
      throw new HostProfileMismatchError({
        missingExtensions: [],
        missingCapabilities: ["olw_extension_protocol_2"],
        generation: 1,
        sessions: {
          total: 1,
          interactive: 1,
          worker: 0,
          retained: 0,
          foreign_attached: 0,
          foreign_retained: 0,
        },
        actualProfile: null,
        recovery: {
          automatic: false,
          argv: ["/fixture/omo", "host", "handoff", "--socket", "/fixture/socket"],
          env: { XDG_CACHE_HOME: "/fixture/cache" },
        },
      });
    };
    w.hooks.hostStatus =
      condition === "unreadable"
        ? undefined
        : async () => ({
            reachable: true,
            socket: "/fixture/socket",
            generation: 1,
            launchProfile: null,
            sessions: {
              total: 1,
              interactive: 1,
              worker: 0,
              retained: 0,
              foreign_attached: 0,
              foreign_retained: 0,
            },
            env_keys: [],
          });
    try {
      expect(await runCli(["--root", w.root, "manage"], w.deps)).toBe(3);
      expect(w.hooks.hostHandoffs).toBe(0);
      const human = String(output.mock.calls.at(-1)?.[0]);
      expect(() => JSON.parse(human)).toThrow();
      expect(human).toContain(condition === "sessions" ? "1 session" : "could not be read");
      expect(human).toContain("/fixture/omo host handoff --socket /fixture/socket");
      output.mockClear();
      expect(await runCli(["--root", w.root, "manage", "--json"], w.deps)).toBe(3);
      expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toMatchObject({
        ok: false,
        error: {
          code: "runtime_unavailable",
          details: { reason: "host_profile_mismatch" },
        },
      });
      expect(
        value(w.orchestrator.status()).find((binding) => binding.id === first.id),
      ).toBeDefined();
    } finally {
      if (tty === undefined) delete (process.stdout as { isTTY?: boolean }).isTTY;
      else Object.defineProperty(process.stdout, "isTTY", tty);
      output.mockRestore();
    }
  },
);

test.each(["first", "existing"] as const)(
  "%s manager entry preserves an unreadable summary status in JSON",
  async (entry) => {
    const w = await world();
    if (entry === "existing") value(await w.orchestrator.manage());
    w.hooks.hostCheck = () => {
      throw new HostProfileMismatchError({
        missingExtensions: ["old-extension"],
        missingCapabilities: [],
        generation: 1,
        sessions: {
          total: 0,
          interactive: 0,
          worker: 0,
          retained: 0,
          foreign_attached: 0,
          foreign_retained: 0,
        },
        actualProfile: null,
        recovery: { automatic: true, argv: ["omo", "host", "handoff"], env: {} },
      });
    };
    w.hooks.hostStatus = async () => {
      throw new Error("injected summary status failure");
    };
    const result = await w.orchestrator.manage();
    expect(result).toMatchObject({
      ok: false,
      error: {
        details: {
          recoveryPhase: "status_unreadable",
          statusError: "injected summary status failure",
        },
      },
    });
    expect(w.hooks.hostHandoffs).toBe(0);
  },
);

test("first manager entry preserves an unreadable session-list failure in TTY and JSON output", async () => {
  const w = await world();
  const old = { HERDR_ENV: process.env["HERDR_ENV"], HERDR_PANE_ID: process.env["HERDR_PANE_ID"] };
  const output = spyOn(process.stdout, "write").mockReturnValue(true);
  const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  w.workspaces.set("caller", { workspaceId: "caller", rootPaneId: "caller:p1", cwd: w.root });
  w.panes.set("caller:p1", { workspaceId: "caller" });
  w.hooks.hostCheck = () => {
    throw new HostProfileMismatchError({
      missingExtensions: ["old-extension"],
      missingCapabilities: [],
      generation: 1,
      sessions: {
        total: 0,
        interactive: 0,
        worker: 0,
        retained: 0,
        foreign_attached: 0,
        foreign_retained: 0,
      },
      actualProfile: null,
      recovery: { automatic: true, argv: ["omo", "host", "handoff"], env: {} },
    });
  };
  w.hooks.hostStatus = async () => ({
    reachable: true,
    socket: "/fixture/socket",
    generation: 1,
    launchProfile: null,
    sessions: {
      total: 0,
      interactive: 0,
      worker: 0,
      retained: 0,
      foreign_attached: 0,
      foreign_retained: 0,
    },
    env_keys: [],
  });
  w.hooks.hostSessions = undefined;
  try {
    process.env["HERDR_ENV"] = "1";
    process.env["HERDR_PANE_ID"] = "caller:p1";
    expect(await runCli(["--root", w.root], w.deps)).toBe(3);
    expect(String(output.mock.calls.at(-1)?.[0])).toContain("session status could not be read");
    output.mockClear();
    expect(await runCli(["--root", w.root, "--json"], w.deps)).toBe(3);
    expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toMatchObject({
      error: { details: { recoveryPhase: "status_unreadable", statusError: expect.any(String) } },
    });
    expect(w.hooks.hostHandoffs).toBe(0);
  } finally {
    if (tty === undefined) delete (process.stdout as { isTTY?: boolean }).isTTY;
    else Object.defineProperty(process.stdout, "isTTY", tty);
    output.mockRestore();
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("a nonempty raw session list replaces a stale zero summary in the refusal", async () => {
  const w = await world();
  value(await w.orchestrator.manage());
  w.hooks.hostCheck = () => {
    throw new HostProfileMismatchError({
      missingExtensions: ["old-extension"],
      missingCapabilities: [],
      generation: 1,
      sessions: {
        total: 0,
        interactive: 0,
        worker: 0,
        retained: 0,
        foreign_attached: 0,
        foreign_retained: 0,
      },
      actualProfile: null,
      recovery: { automatic: true, argv: ["omo", "host", "handoff"], env: {} },
    });
  };
  w.hooks.hostStatus = async () => ({
    reachable: true,
    socket: "/fixture/socket",
    generation: 1,
    launchProfile: null,
    sessions: {
      total: 0,
      interactive: 0,
      worker: 0,
      retained: 0,
      foreign_attached: 0,
      foreign_retained: 0,
    },
    env_keys: [],
  });
  w.hooks.hostSessions = async () => {
    throw new HostSessionsPresentError(1);
  };
  const result = await w.orchestrator.manage();
  expect(result).toMatchObject({
    ok: false,
    error: {
      details: {
        recoveryPhase: "refused",
        sessions: { total: 1, interactive: 1, foreign_attached: 1 },
        recovery: { automatic: false },
      },
    },
  });
  expect(w.hooks.hostHandoffs).toBe(0);
});

test("bare entry hands off an idle mismatched host once and continues", async () => {
  const w = await world();
  const old = { HERDR_ENV: process.env["HERDR_ENV"], HERDR_PANE_ID: process.env["HERDR_PANE_ID"] };
  const output = spyOn(process.stdout, "write").mockReturnValue(true);
  w.workspaces.set("caller", { workspaceId: "caller", rootPaneId: "caller:p1", cwd: w.root });
  w.panes.set("caller:p1", { workspaceId: "caller" });
  w.hooks.hostCheck = () => {
    throw new HostProfileMismatchError({
      missingExtensions: ["old-extension"],
      missingCapabilities: [],
      generation: 1,
      sessions: {
        total: 0,
        interactive: 0,
        worker: 0,
        retained: 0,
        foreign_attached: 0,
        foreign_retained: 0,
      },
      actualProfile: null,
      recovery: { automatic: false, argv: ["omo", "host", "handoff"], env: {} },
    });
  };
  w.hooks.hostStatus = async () => ({
    reachable: true,
    socket: join(w.root, ".omo/state/omo.sock"),
    generation: 1,
    launchProfile: {
      core: { session_runtime: "in-process", multi_session: true, extensions: [] },
    },
    sessions: {
      total: 0,
      interactive: 0,
      worker: 0,
      retained: 0,
      foreign_attached: 0,
      foreign_retained: 0,
    },
    env_keys: [],
  });
  try {
    process.env["HERDR_ENV"] = "1";
    process.env["HERDR_PANE_ID"] = "caller:p1";
    expect(await runCli(["--root", w.root], w.deps)).toBe(0);
    expect(w.hooks.hostHandoffs).toBe(1);
    expect(w.runs).toHaveLength(1);
  } finally {
    output.mockRestore();
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test.each(["handoff_failed", "verification_failed"] as const)(
  "manager entry reports the typed %s recovery phase after handoff admission",
  async (failurePhase) => {
    const w = await world();
    const first = value(await w.orchestrator.manage()).binding;
    let mismatched = true;
    w.hooks.hostCheck = () => {
      if (!mismatched) return;
      throw new HostProfileMismatchError({
        missingExtensions: ["old-extension"],
        missingCapabilities: [],
        generation: 1,
        sessions: {
          total: 0,
          interactive: 0,
          worker: 0,
          retained: 0,
          foreign_attached: 0,
          foreign_retained: 0,
        },
        actualProfile: null,
        recovery: { automatic: true, argv: ["omo", "host", "handoff"], env: {} },
      });
    };
    w.hooks.hostStatus = async () => ({
      reachable: failurePhase !== "verification_failed",
      socket: "/fixture/socket",
      generation: 1,
      launchProfile:
        failurePhase === "verification_failed"
          ? null
          : {
              core: { session_runtime: "in-process", multi_session: true, extensions: [] },
            },
      sessions: {
        total: 0,
        interactive: 0,
        worker: 0,
        retained: 0,
        foreign_attached: 0,
        foreign_retained: 0,
      },
      env_keys: [],
    });
    const orchestrator = new Orchestrator(w.root, "/fixture/herdr.sock", {
      ...w.deps,
      handoffHost: async () => {
        w.hooks.hostHandoffs += 1;
        if (failurePhase === "handoff_failed") throw new Error("injected handoff failure");
        mismatched = false;
      },
    });
    const result = await orchestrator.manage();
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "runtime_unavailable",
        details: { recoveryPhase: failurePhase },
      },
    });
    expect(w.hooks.hostHandoffs).toBe(1);
    expect(value(w.orchestrator.status()).find((binding) => binding.id === first.id)).toBeDefined();
  },
);

test("host handoff lock timeout returns exit 3 and a readable TTY message", async () => {
  const w = await world();
  value(await w.orchestrator.manage());
  const output = spyOn(process.stdout, "write").mockReturnValue(true);
  const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  w.hooks.hostCheck = () => {
    throw new HostProfileMismatchError({
      missingExtensions: ["old-extension"],
      missingCapabilities: [],
      generation: 1,
      sessions: {
        total: 0,
        interactive: 0,
        worker: 0,
        retained: 0,
        foreign_attached: 0,
        foreign_retained: 0,
      },
      actualProfile: null,
      recovery: { automatic: true, argv: ["omo", "host", "handoff"], env: {} },
    });
  };
  try {
    const code = await runCli(["--root", w.root, "manage"], {
      ...w.deps,
      withHostHandoffLock: async () => {
        throw new HostHandoffBusyError(50_000);
      },
    });
    expect(code).toBe(3);
    expect(String(output.mock.calls.at(-1)?.[0])).toContain("Another OLW entry");
  } finally {
    if (tty === undefined) delete (process.stdout as { isTTY?: boolean }).isTTY;
    else Object.defineProperty(process.stdout, "isTTY", tty);
    output.mockRestore();
  }
});

test("concurrent manage calls perform exactly one idle-host handoff", async () => {
  const w = await world();
  const first = value(await w.orchestrator.manage()).binding;
  w.panes.delete(first.paneId ?? "");
  let mismatched = true;
  w.hooks.hostCheck = () => {
    if (!mismatched) return;
    throw new HostProfileMismatchError({
      missingExtensions: ["old-extension"],
      missingCapabilities: [],
      generation: 1,
      sessions: {
        total: 0,
        interactive: 0,
        worker: 0,
        retained: 0,
        foreign_attached: 0,
        foreign_retained: 0,
      },
      actualProfile: null,
      recovery: { automatic: false, argv: ["omo", "host", "handoff"], env: {} },
    });
  };
  w.hooks.hostStatus = async () => ({
    reachable: true,
    socket: "/fixture/socket",
    generation: 1,
    launchProfile: {
      core: { session_runtime: "in-process", multi_session: true, extensions: [] },
    },
    sessions: {
      total: 0,
      interactive: 0,
      worker: 0,
      retained: 0,
      foreign_attached: 0,
      foreign_retained: 0,
    },
    env_keys: [],
  });
  const orchestrator = new Orchestrator(w.root, "/fixture/herdr.sock", {
    ...w.deps,
    handoffHost: async () => {
      w.hooks.hostHandoffs += 1;
      mismatched = false;
    },
  });
  const results = await Promise.all([orchestrator.manage(), orchestrator.manage()]);
  expect(results.every((result) => result.ok)).toBe(true);
  expect(w.hooks.hostHandoffs).toBe(1);
});

test("concurrent manage calls reattach a missing TUI exactly once", async () => {
  const w = await world();
  const first = value(await w.orchestrator.manage());
  w.panes.delete(first.binding.paneId ?? "");

  const results = await Promise.all([w.orchestrator.manage(), w.orchestrator.manage()]);

  expect(results.map((result) => value(result).action).sort()).toEqual([
    "reattached",
    "reattaching",
  ]);
  expect(w.tabs).toHaveLength(1);
  expect(w.runs).toHaveLength(2);
  expect(value(await w.orchestrator.manage()).action).toBe("focused");
  expect(w.runs).toHaveLength(2);
});

test("an expired reattach owner resumes without launching or clearing the new owner's claim", async () => {
  const w = await world();
  const first = value(await w.orchestrator.manage());
  w.panes.delete(first.binding.paneId ?? "");
  const pending = () =>
    w.readRegistry((registry) => value(registry.reattachPending(first.binding.id)));

  // A claims at t0 and is suspended at createTab entry.
  const aAtTab = Promise.withResolvers<void>();
  const resumeA = Promise.withResolvers<void>();
  w.hooks.beforeTab = async () => {
    w.hooks.beforeTab = undefined;
    aAtTab.resolve();
    await resumeA.promise;
  };
  const a = w.orchestrator.manage();
  await aAtTab.promise;

  // Model a legacy unknown owner: known live processes no longer expire for any caller.
  const db = new Database(join(w.root, ".omo/state/registry.sqlite"));
  try {
    db.query(
      "UPDATE manager_reattach SET owner_pid = NULL, owner_starttime = NULL WHERE binding_id = ?",
    ).run(first.binding.id);
  } finally {
    db.close();
  }
  // Past the 120 s lease, B reclaims, launches, sees readiness and is held at verification.
  w.hooks.now = "2026-09-26T00:02:00.001Z";
  const bAtVerify = Promise.withResolvers<void>();
  const resumeB = Promise.withResolvers<void>();
  w.hooks.beforeAttach = async () => {
    w.hooks.beforeAttach = undefined;
    bAtVerify.resolve();
    await resumeB.promise;
  };
  const b = w.orchestrator.manage();
  await bAtVerify.promise;
  expect(w.runs).toHaveLength(2);

  resumeA.resolve();
  expect(await a).toMatchObject({
    ok: false,
    error: { code: "runtime_unavailable", details: { reason: "lease_lost" } },
  });
  expect(pending()).toBe(true);
  expect(w.runs).toHaveLength(2);

  resumeB.resolve();
  const bResult = value(await b);
  expect(bResult.action).toBe("reattached");
  expect(pending()).toBe(false);
  // A was suspended inside createTab, so its tab exists, but it stays a plain shell: no TUI.
  expect(w.tabs).toHaveLength(2);
  const orphan = [...w.panes.entries()].filter(
    ([paneId]) => paneId !== bResult.binding.paneId && paneId !== first.binding.paneId,
  );
  expect(orphan.map(([, pane]) => pane.agent)).toEqual([undefined]);
  // One replacement launch in total (plus the original manager launch).
  expect(w.runs.map((run) => run.paneId)).toEqual([
    first.binding.paneId ?? "",
    bResult.binding.paneId ?? "missing",
  ]);
  expect(value(w.orchestrator.status())[0]?.paneId).toBe(bResult.binding.paneId);
});

test("an interrupted reattachment is completed by the next manage, never reported focused", async () => {
  const w = await world();
  const first = value(await w.orchestrator.manage());
  w.panes.delete(first.binding.paneId ?? "");
  w.hooks.failRun = true;

  expect(await w.orchestrator.manage()).toMatchObject({
    ok: false,
    error: { code: "runtime_unavailable" },
  });
  expect(w.runs).toHaveLength(1);
  w.hooks.failRun = false;

  const retried = value(await w.orchestrator.manage());

  expect(retried.action).toBe("reattached");
  expect(w.runs).toHaveLength(2);
  // The retry launches into the replacement pane the interrupted attempt created.
  expect(w.tabs).toHaveLength(1);
  const replacement = `${first.binding.workspaceId ?? ""}:tp1`;
  expect(w.runs[1]?.paneId).toBe(replacement);
  expect(retried.binding.paneId).toBe(replacement);
  expect(w.panes.get(retried.binding.paneId ?? "")?.agent).toBe("omo");
  expect(value(await w.orchestrator.manage()).action).toBe("focused");
  expect(w.runs).toHaveLength(2);
});

test("manage refuses an uncertain manager and creates nothing", async () => {
  const w = await world();
  const first = value(await w.orchestrator.manage());
  w.readRegistry((registry) => value(registry.setLaunchState(first.binding.id, "uncertain")));

  const result = await w.orchestrator.manage();

  expect(result).toMatchObject({
    ok: false,
    error: {
      code: "manager_uncertain",
      message: expect.stringContaining(`olw close --binding ${first.binding.id}`),
    },
  });
  expect(w.runs).toHaveLength(1);
  expect(w.created).toHaveLength(1);
  expect(w.tabs).toEqual([]);
  expect(w.focused).toEqual([]);
  expect(managers(value(w.orchestrator.status()))).toHaveLength(1);
});

test("manage after closing the manager creates a fresh one under the same designation", async () => {
  const w = await world();
  const first = value(await w.orchestrator.manage());
  expect(value(await w.orchestrator.close(first.binding.id)).launchState).toBe("closed");
  const second = value(await w.orchestrator.manage());
  expect(second.action).toBe("created");
  expect(second.binding.id).not.toBe(first.binding.id);
  expect(second.binding.designationId).toBe("manager");
});

test("standalone parent create links to the ready manager", async () => {
  const w = await world();
  const manager = value(await w.orchestrator.manage()).binding;
  const parent = value(await w.createParent("project"));
  expect(parent.binding.assignment).toMatchObject({ role: "parent", ownerBindingId: manager.id });
  expect(parent.managerLink).toEqual({ bindingId: manager.id, reason: "linked" });
});

test("standalone parent create stays unlinked with --no-manager, a paused or a closed manager", async () => {
  const w = await world();
  const none = value(await w.createParent("project"));
  expect(none.binding.assignment).toMatchObject({ ownerBindingId: null });
  expect(none.managerLink).toEqual({ bindingId: null, reason: "no_manager" });
  value(await w.orchestrator.close(none.binding.id));

  const manager = value(await w.orchestrator.manage()).binding;
  const optedOut = value(await w.createParent("project", true));
  expect(optedOut.binding.assignment).toMatchObject({ ownerBindingId: null });
  expect(optedOut.managerLink).toEqual({ bindingId: null, reason: "opted_out" });
  value(await w.orchestrator.close(optedOut.binding.id));

  value(w.orchestrator.setPaused(manager.id, true));
  const paused = value(await w.createParent("project"));
  expect(paused.binding.assignment).toMatchObject({ ownerBindingId: null });
  expect(paused.managerLink).toEqual({ bindingId: null, reason: "manager_paused" });

  value(w.orchestrator.setPaused(manager.id, false));
  value(await w.orchestrator.close(manager.id));
  const closed = value(await w.createParent("second"));
  expect(closed.binding.assignment).toMatchObject({ ownerBindingId: null });
  expect(closed.managerLink).toEqual({ bindingId: null, reason: "manager_closed" });
});

test("CLI manage and parent create --no-manager reach the orchestrator", async () => {
  const root = await mkdtemp(join(tmpdir(), "olw-manage-cli-"));
  roots.push(root);
  const stdout = spyOn(process.stdout, "write").mockReturnValue(true);
  const manage = spyOn(Orchestrator.prototype, "manage").mockResolvedValue({
    ok: false,
    error: { code: "fixture_stop", message: "No real roles" },
  });
  const create = spyOn(Orchestrator.prototype, "createParent").mockResolvedValue({
    ok: false,
    error: { code: "fixture_stop", message: "No real roles" },
  });
  try {
    expect(await runCli(["--root", root, "manage", "--json"])).toBe(2);
    expect(manage).toHaveBeenCalledTimes(1);
    expect(
      await runCli([
        "--root",
        root,
        "parent",
        "create",
        "--project",
        "p",
        "--repo",
        "/fixture",
        "--base",
        "main",
        "--scope-digest",
        "digest",
        "--designation",
        "d",
        "--execute",
        "--no-manager",
        "--json",
      ]),
    ).toBe(2);
    expect(create).toHaveBeenCalledWith({
      projectId: "p",
      repo: "/fixture",
      base: "main",
      scopeDigest: "digest",
      designationId: "d",
      execute: true,
      fixture: false,
      noManager: true,
    });
    expect(
      await runCli([
        "--root",
        root,
        "parent",
        "create",
        "--project",
        "p",
        "--repo",
        "/fixture",
        "--base",
        "main",
        "--supervisor",
        "s",
        "--no-manager",
        "--json",
      ]),
    ).toBe(2);
    expect(create).toHaveBeenCalledTimes(1);
    expect(await runCli(["help", "--json"])).toBe(0);
    const help: unknown = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
    expect(help).toMatchObject({
      ok: true,
      value: {
        commands: expect.arrayContaining(["manage"]),
        options: {
          manage: expect.stringContaining("--here"),
          "parent create": expect.stringContaining("--no-manager"),
        },
      },
    });
  } finally {
    manage.mockRestore();
    create.mockRestore();
    stdout.mockRestore();
  }
});
