import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
import { HostProfileMismatchError, runtimeCacheEnvironment } from "../src/host-profile";
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

interface RunCall {
  readonly paneId: string;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

async function world() {
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
  const panes = new Map<string, { workspaceId: string; agent?: string }>();
  const hooks: {
    failRun: boolean;
    hostCheck: (() => void) | undefined;
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
    async run(paneId, argv, env) {
      if (hooks.failRun) throw new Error("injected send_input failure before launching TUI");
      runs.push({ paneId, argv, env });
      const path = argv[argv.indexOf("--session") + 1];
      if (path === undefined) throw new Error("Missing --session");
      const sessionId = SessionManager.open(path).getSessionId();
      const binding = readRegistry((registry) => value(registry.bySession(sessionId)));
      const pane = panes.get(paneId);
      if (pane === undefined) throw new Error("No such pane");
      panes.set(paneId, { ...pane, agent: "omo" });
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
    async reportSession() {},
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
    checkHostProfile: async () => hooks.hostCheck?.(),
    gitTip: async () => "base-commit",
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
  const digest = readRegistry((registry) => value(registry.importScope(projectScope)).digest);
  const createParent = (projectId: string, noManager?: boolean) =>
    orchestrator.createParent({
      scopeDigest: digest,
      designationId: "project-approval",
      projectId,
      repo: root,
      base: "main",
      execute: true,
      fixture: true,
      ...(noManager === undefined ? {} : { noManager }),
    });
  return {
    root,
    orchestrator,
    readRegistry,
    createParent,
    workspaces,
    panes,
    runs,
    created,
    tabs,
    focused,
    prompts,
    hooks,
  };
}

function managers(bindings: readonly Binding[]): Binding[] {
  return bindings.filter((binding) => binding.assignment.role === "manager");
}

test("a hanging injected update check cannot delay manager creation or focus", async () => {
  const w = await world();
  const timers: Array<{ callback: () => void; cleared: boolean }> = [];
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
      const timer = { callback, cleared: false };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout(id) {
      (id as unknown as { cleared: boolean }).cleared = true;
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

test("first manage creates one manager labeled manager; second focuses it and launches nothing", async () => {
  const w = await world();
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
  const updateLines = managerBrief.split("\n").filter((line) => line.startsWith("update_check: "));
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
});

test("manage reattaches in a new tab with the same env when the TUI pane is gone", async () => {
  const w = await world();
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
      sessions: { total: 1, worker: 0 },
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

  expect(checks).toBe(2);
  expect(w.focused).toEqual([]);
  expect(w.tabs).toEqual([]);
  expect(w.runs).toHaveLength(1);
  expect(value(w.orchestrator.status())[0]?.paneId).toBe(first.binding.paneId);
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
          manage: "[--json]",
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
