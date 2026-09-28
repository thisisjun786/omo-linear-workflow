import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@code-yeongyu/senpi";
import type {
  Binding,
  Checkout,
  DeliveryRecord,
  Envelope,
  Result,
  RuntimeIdentity,
  ScopeSnapshot,
} from "../../src/core/contracts";
import { modelForLaunch, modelForRole } from "../../src/core/policy";
import { openRegistry } from "../../src/core/store";
import type { HerdrClient, Snapshot, Workspace } from "../../src/herdr";
import { createHostProfile, HostCapacityError, RUNTIME_CACHE_MARKER } from "../../src/host-profile";
import { roleLabel } from "../../src/linear";
import {
  Orchestrator,
  type OrchestratorDependencies,
  planPaneExited,
  planPathForIssueKey,
} from "../../src/orchestrator";
import { publishReadiness } from "../../src/readiness";
import { checkoutGit } from "../../src/repo/checkout";
import {
  attachBindingWithClient,
  type NativeSession,
  NativeSessionAbsentError,
  type RpcPort,
} from "../../src/transport/client";

import { fixtureTip, mappedScope } from "../fixtures/mapped-scope";

const ownedRoots: string[] = [];
afterEach(async () => {
  for (const root of ownedRoots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function ownedRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  ownedRoots.push(root);
  return root;
}

test("CLI help exits successfully without creating runtime state", async () => {
  const root = await ownedRoot("oi-help-");
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "../../src/cli.ts"),
      "--root",
      root,
      "--help",
      "--json",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  const output: unknown = JSON.parse(stdout);
  expect(output).toMatchObject({
    ok: true,
    value: {
      commands: expect.arrayContaining([
        "repo list",
        "repo fetch",
        "supervisor create",
        "parent create",
        "child create",
        "stage complete",
        "stage start",
        "reconcile",
      ]),
    },
  });
  expect(await Bun.file(join(root, ".omo/state/registry.sqlite")).exists()).toBe(false);
});

describe("host profile", () => {
  test("writes a contained mode-0600 native host profile", async () => {
    const root = await ownedRoot("omo-cli-profile-");
    await Bun.write(join(root, "node_modules/omo-ai/plugin/extensions/omo-member.js"), "");
    await Bun.write(join(root, "dist/extension/index.js"), "");
    await chmod(join(root, "node_modules/omo-ai/plugin"), 0o755);

    const path = await createHostProfile(root);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      spec_version: 1,
      core: {
        session_runtime: "worker",
        multi_session: true,
        extensions: [
          "./node_modules/omo-ai/plugin",
          "./node_modules/omo-ai/plugin/extensions/omo-member.js",
          "./dist/extension/index.js",
        ],
      },
      tunables: { coldStart: "persistent" },
      env: {
        OMO_NATIVE: "1",
        OMO_INITIATIVE_HOST: "1",
        OMO_INITIATIVE_EXTENSION_PROTOCOL_2: "1",
        OMO_INITIATIVE_WORKER_ADMISSION_2: "1",
        OMO_INITIATIVE_ROOT: root,
        OMO_RPC_SOCKET: join(root, ".omo/state/omo.sock"),
        [RUNTIME_CACHE_MARKER]: "1",
      },
    });
    await rm(root, { recursive: true, force: true });
  });
});

test("real Herdr exit variants identify only the plan pane", () => {
  const updated = { event: "pane.updated", data: { type: "pane_updated", pane: { pane_id: "p" } } };
  const exited = {
    event: "pane.exited",
    data: { type: "pane_exited", pane_id: "p", workspace_id: "w" },
  };
  expect(planPaneExited(updated, "p")).toBe(true);
  expect(planPaneExited(exited, "p")).toBe(true);
  expect(planPaneExited(updated, "other")).toBe(false);
  expect(planPaneExited(exited, "other")).toBe(false);
  expect(
    planPaneExited(
      {
        event: "pane.updated",
        data: { pane: { pane_id: "p", agent_session: { kind: "path", value: "/s" } } },
      },
      "p",
    ),
  ).toBe(false);
});

class FakeHerdr implements HerdrClient {
  readonly events: string[];
  protocol: 1 | 2 = 2;
  readonly emittedEvent: unknown;
  readonly tabCalls: unknown[] = [];
  readonly extraPanes: Snapshot["panes"][number][] = [];
  exitFrame: "updated" | "exited" = "updated";
  lastArgv: readonly string[] = [];
  listener: ((event: unknown) => void) | undefined;
  verifyIdentity = false;
  holdSnapshot = false;
  snapshots = 0;
  cwd = "";
  root = "";
  readonly workspaces = new Map<string, Workspace>();
  readonly nativeIdentities = new Map<string, RuntimeIdentity>();
  readonly paneSessions = new Map<string, string>();
  nextWorkspace = 0;
  constructor(
    events: string[],
    emittedEvent: unknown = { paneId: "pane", sessionPath: "/sessions/s.jsonl" },
  ) {
    this.events = events;
    this.emittedEvent = emittedEvent;
  }
  async subscribe(listener: (event: unknown) => void): Promise<() => void> {
    this.events.push("subscribe");
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }
  async createWorkspace(cwd: string, _label: string): Promise<Workspace> {
    this.events.push("create");
    if (this.root === "") this.root = cwd;
    if (cwd !== this.root) {
      return this.createWorktree(
        {
          originalRepoRoot: cwd,
          path: cwd,
          branch: "fixture",
          baseBranch: "main",
          baseCommit: "commit",
        },
        _label,
      );
    }
    this.cwd = cwd;
    const workspace = {
      workspaceId: "ws",
      rootPaneId: "pane",
      rootTabId: "ws:t1",
      cwd,
      label: _label,
    };
    this.workspaces.set(workspace.workspaceId, workspace);
    return workspace;
  }
  async createTab(
    workspaceId: string,
    _cwd: string,
    label: string,
  ): Promise<{ tabId: string; rootPaneId: string }> {
    const call = { tabId: `${workspaceId}:t2`, rootPaneId: `${workspaceId}:p2` };
    this.tabCalls.push({ method: "createTab", workspaceId, cwd: _cwd, label, ...call });
    this.extraPanes.push({ paneId: call.rootPaneId, workspaceId, revision: 1, sessionPath: null });
    return call;
  }
  async renameTab(tabId: string, label: string): Promise<void> {
    this.tabCalls.push({ method: "renameTab", tabId, label });
  }
  async closeTab(tabId: string): Promise<void> {
    this.tabCalls.push({ method: "closeTab", tabId });
  }
  async sendKeys(paneId: string, text: string, keys: readonly string[]): Promise<void> {
    this.tabCalls.push({ method: "sendKeys", paneId, text, keys });
    this.events.push(`sendKeys:${paneId}`);
    this.paneSessions.delete(paneId);
    this.listener?.(
      this.exitFrame === "updated"
        ? { event: "pane.updated", data: { type: "pane_updated", pane: { pane_id: paneId } } }
        : {
            event: "pane.exited",
            data: { type: "pane_exited", pane_id: paneId, workspace_id: "worktree-2" },
          },
    );
  }
  async focusWorkspace(): Promise<void> {}
  async focusPane(): Promise<void> {}
  async paneContainsProcess(): Promise<boolean> {
    return true;
  }
  rootTabFromCreate = true;
  async createWorktree(checkout: Checkout, label: string): Promise<Workspace> {
    if (checkout.originalRepoRoot !== checkout.path)
      await checkoutGit(checkout.originalRepoRoot, [
        "worktree",
        "add",
        "-b",
        checkout.branch,
        checkout.path,
        checkout.baseBranch,
      ]);
    this.cwd = checkout.path;
    const id = `worktree-${++this.nextWorkspace}`;
    const workspace = {
      workspaceId: id,
      rootPaneId: `${id}:p1`,
      ...(this.rootTabFromCreate ? { rootTabId: `${id}:root` } : {}),
      cwd: checkout.path,
      label,
    };
    this.workspaces.set(id, workspace);
    return workspace;
  }
  async run(
    _pane: string,
    argv: readonly string[],
    env: Readonly<Record<string, string>>,
  ): Promise<void> {
    this.events.push("run");
    this.lastArgv = argv;
    const separator = process.platform === "win32" ? ";" : ":";
    expect(env).toEqual({
      PATH: `${join(this.root, ".managed-herdr")}${separator}${process.env["PATH"] ?? ""}`,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: expect.stringMatching(
        new RegExp(`^${RegExp.escape(join(this.root, ".omo/cache"))}/[^/]+/cli$`),
      ),
      XDG_CACHE_HOME: expect.stringMatching(
        new RegExp(`^${RegExp.escape(join(this.root, ".omo/cache"))}/[^/]+/host$`),
      ),
    });
    expect(argv).toContain(join(this.root, "node_modules/.bin/omo"));
    expect(argv).not.toContain("omo");
    expect(argv).toContain(join(this.root, "dist/extension/herdr-olw-owner.js"));
    expect(argv).toContain(join(this.root, "dist/extension/index.js"));
    expect(argv).not.toContain(join(this.root, "dist/proxy/index.js"));
    if (this.verifyIdentity) {
      const fileIndex = argv.indexOf("--session");
      const idIndex = argv.indexOf("--session-id");
      const requestedId = idIndex < 0 ? "session" : argv[idIndex + 1];
      if (!requestedId) throw new Error("No requested session identity");
      const file =
        fileIndex < 0
          ? SessionManager.create(this.cwd, join(this.cwd, "sessions"), {
              id: requestedId,
            }).getSessionFile()
          : argv[fileIndex + 1];
      if (!file) throw new Error("No native session file");
      const restored = SessionManager.open(file, join(this.cwd, "sessions"), this.cwd);
      expect(restored.getSessionId()).toBe(requestedId);
      expect(restored.buildSessionContext().model).toEqual({
        provider: modelForRole("supervisor").provider,
        modelId: modelForRole("supervisor").modelId,
      });
      expect(restored.buildSessionContext().thinkingLevel).toBe("high");
    }
    expect(argv.join(" ")).not.toContain("qa_standby");
    if (this.holdSnapshot) this.listener?.({ event: "pane.updated", data: {} });
    this.listener?.(this.emittedEvent);
    const path = argv[argv.indexOf("--session") + 1];
    if (!path) throw new Error("Native session path is required");
    this.paneSessions.set(_pane, path);
    const manager = SessionManager.open(path, join(this.cwd, "sessions"), this.cwd);
    const registry = openRegistry(join(this.root, ".omo/state/registry.sqlite"));
    try {
      const listed = registry.list();
      if (!listed.ok) throw new Error(listed.error.message);
      const binding = listed.value.find(
        (candidate) => candidate.durableSessionId === manager.getSessionId(),
      );
      if (!binding?.paneId) throw new Error("No provisioned binding");
      this.nativeIdentities.set(binding.durableSessionId, {
        durableSessionId: binding.durableSessionId,
        sessionPath: path,
        cwd: this.cwd,
        provider: "chatgpt-subscription",
        modelId: "gpt-5.6-sol",
        thinking: "medium",
        extensionProtocol: this.protocol,
      });
      await publishReadiness(this.root, {
        bindingId: binding.id,
        durableSessionId: manager.getSessionId(),
        sessionPath: path,
        cwd: this.cwd,
        paneId: binding.paneId,
      });
    } finally {
      registry.close();
    }
  }
  async snapshot(): Promise<Snapshot> {
    this.snapshots += 1;
    if (this.holdSnapshot) throw new Error("Stale snapshot unavailable");
    const workspaces = [...this.workspaces.values()].map((workspace) => {
      const withTab = {
        ...workspace,
        rootTabId: workspace.rootTabId ?? `${workspace.workspaceId}:root`,
      };
      this.workspaces.set(workspace.workspaceId, withTab);
      return withTab;
    });
    return {
      focusedWorkspaceId: null,
      focusedTabId: null,
      focusedPaneId: null,
      workspaces,
      panes: [...this.workspaces.values()]
        .map((workspace): Snapshot["panes"][number] => ({
          paneId: workspace.rootPaneId,
          workspaceId: workspace.workspaceId,
          revision: 1,
          sessionPath: this.paneSessions.get(workspace.rootPaneId) ?? null,
        }))
        .concat(
          this.extraPanes.map((pane) => ({
            ...pane,
            sessionPath: this.paneSessions.get(pane.paneId) ?? null,
          })),
        ),
    };
  }
  async closeWorkspace(id: string): Promise<void> {
    this.events.push(`close-workspace:${id}`);
    this.workspaces.delete(id);
  }
  async removeWorktree(): Promise<void> {}
  close(): void {
    this.events.push("close-herdr");
  }
}

class FakeNative implements NativeSession {
  identity: RuntimeIdentity;
  deliveryState: DeliveryRecord["state"] = "accepted";
  readonly events: string[];
  readonly messages: ReadonlySet<string>;
  onConfigure: ((identity: RuntimeIdentity) => void) | undefined;
  constructor(
    identity: RuntimeIdentity,
    events: string[] = [],
    messages: ReadonlySet<string> = new Set(),
  ) {
    this.identity = identity;
    this.events = events;
    this.messages = messages;
  }
  async hasUserMessage(text: string): Promise<boolean> {
    return this.messages.has(text);
  }
  async configure(
    model: Pick<RuntimeIdentity, "provider" | "modelId" | "thinking">,
  ): Promise<void> {
    this.identity = { ...this.identity, ...model };
    this.onConfigure?.(this.identity);
    this.events.push("configure");
  }
  async describe(): Promise<Result<RuntimeIdentity>> {
    return { ok: true, value: this.identity };
  }
  async deliverUserAnswer(): Promise<Result<DeliveryRecord>> {
    return {
      ok: false,
      error: { code: "route_denied", message: "User answers use the dedicated RPC" },
    };
  }
  async send(envelope: Envelope): Promise<Result<DeliveryRecord>> {
    return {
      ok: true,
      value: {
        envelope,
        state: this.deliveryState,
        receipt:
          this.deliveryState === "uncertain"
            ? null
            : this.deliveryState === "rejected"
              ? {
                  kind: "error",
                  error: { code: "denied", message: "Denied", next_action: "inspect" },
                }
              : {
                  kind: "ok",
                  thread_id: "target",
                  message_seq: 1,
                  deduplicated: false,
                  delivery: { kind: "started", turn_id: "turn" },
                },
      },
    };
  }
  onEvent(): () => void {
    return () => {};
  }
  async close(): Promise<void> {}
}

describe("orchestrator startup", () => {
  test.each([
    [false, false],
    [true, false],
    [true, true],
  ])(
    "preserves native handoff identity (%s) without relying on Herdr metadata (%s)",
    async (verifyIdentity, pendingSnapshot) => {
      const root = await ownedRoot("omo-orchestrator-");
      const events: string[] = [];
      const prompts = new Map<string, Set<string>>();
      let promptFailure: "before" | "after" | null = null;
      const herdr = new FakeHerdr(events);
      herdr.verifyIdentity = verifyIdentity;
      herdr.holdSnapshot = pendingSnapshot;
      let nextId = 0;
      let clock = "2026-09-22T00:00:00.000Z";
      const dependencies: OrchestratorDependencies = {
        openRegistry,
        createHerdrClient: () => herdr,
        resolveHerdrArtifact: async (controlRoot) => ({
          artifactDir: join(controlRoot, ".managed-herdr"),
        }),
        ensureHost: async (controlRoot, _socket, env) => {
          const separator = process.platform === "win32" ? ";" : ":";
          expect(env["PATH"]).toBe(
            `${join(controlRoot, ".managed-herdr")}${separator}${process.env["PATH"] ?? ""}`,
          );
          expect(env["BUN_RUNTIME_TRANSPILER_CACHE_PATH"]).toMatch(
            new RegExp(`^${RegExp.escape(join(controlRoot, ".omo/cache"))}/[^/]+/cli$`),
          );
          expect(env["XDG_CACHE_HOME"]).toMatch(
            new RegExp(`^${RegExp.escape(join(controlRoot, ".omo/cache"))}/[^/]+/host$`),
          );
          events.push("host");
        },
        gitTip: (cwd, ref) => fixtureTip(root, "commit", cwd, ref),
        now: () => clock,
        uuid: () => ["binding", "session", "message", "temp"][nextId++] ?? `id-${nextId}`,
        attachBinding: async (binding: Binding) => {
          events.push("attach");
          const identity = herdr.nativeIdentities.get(binding.durableSessionId);
          if (identity === undefined) throw new Error("Exact native session is not open");
          let messages = prompts.get(binding.durableSessionId);
          if (messages === undefined) {
            messages = new Set();
            prompts.set(binding.durableSessionId, messages);
          }
          const session = new FakeNative(identity, events, messages);
          session.onConfigure = (current) =>
            herdr.nativeIdentities.set(binding.durableSessionId, current);
          return session;
        },
        terminateBinding: async (binding) => {
          events.push(`terminate:${binding.id}`);
          herdr.nativeIdentities.delete(binding.durableSessionId);
        },
        prompt: async (binding, brief) => {
          expect(brief).toContain("source: fixture");
          events.push("prompt");
          if (promptFailure === "before") throw new Error("Disconnected before acceptance");
          const messages = prompts.get(binding.durableSessionId);
          if (messages === undefined) throw new Error("No exact native session");
          messages.add(brief);
          if (promptFailure === "after") throw new Error("Acknowledgement was lost");
        },
      };
      const scope: ScopeSnapshot = {
        version: 1,
        source: "fixture",
        initiative: { id: "initiative", url: "https://linear.test/i", revision: "r1" },
        projects: [
          { project: { id: "project", url: "https://linear.test/p", revision: "r1" }, issues: [] },
          {
            project: { id: "rejected", url: "https://linear.test/p2", revision: "r1" },
            issues: [],
          },
          {
            project: { id: "uncertain", url: "https://linear.test/p3", revision: "r1" },
            issues: [],
          },
        ],
        decisionRefs: [],
      };
      const scopeFile = join(root, "scope.json");
      await Bun.write(scopeFile, JSON.stringify(await mappedScope(root, scope)));
      const orchestrator = new Orchestrator(root, "/fake/herdr.sock", dependencies);
      const imported = await orchestrator.importScope(scopeFile, true);
      expect(imported.ok).toBe(true);
      if (!imported.ok) throw new Error(imported.error.message);
      const created = await orchestrator.createSupervisor({
        initiativeId: "initiative",
        scopeDigest: imported.value.digest,
        designationId: "designation",
        execute: true,
        fixture: true,
      });
      expect(created).toMatchObject({ ok: true });
      expect(herdr.snapshots).toBe(0);
      expect(events).toEqual([
        "host",
        "subscribe",
        "create",
        "run",
        "attach",
        "configure",
        "prompt",
        "close-herdr",
      ]);
      if (created.ok) expect(created.value.binding.launchState).toBe("ready");
      if (!verifyIdentity && !pendingSnapshot) {
        await rm(join(root, ".omo/state/orchestrator.json"), { force: true });
        const restarted = new Orchestrator(root, "/fake/herdr.sock", dependencies);
        const parent = await restarted.createParent({
          supervisorId: "binding",
          projectId: "project",
        });
        expect(parent).toMatchObject({ ok: true });
        const registry = openRegistry(join(root, ".omo/state/registry.sqlite"));
        try {
          expect(registry.setLaunchState("binding", "uncertain").ok).toBe(true);
        } finally {
          registry.close();
        }
        const reconciled = await restarted.reconcile("initiative");
        expect(reconciled).toMatchObject({ ok: true, value: { observed: 1 } });
        for (const state of ["rejected", "uncertain"] as const) {
          const rejecting = new Orchestrator(root, "/fake/herdr.sock", {
            ...dependencies,
            attachBinding: async (binding) => {
              const session = await dependencies.attachBinding(binding);
              if (!(session instanceof FakeNative)) throw new Error("Unexpected fixture session");
              session.deliveryState = state;
              return session;
            },
          });
          const rejected = await rejecting.createParent({
            supervisorId: "binding",
            projectId: state,
          });
          expect(rejected).toMatchObject({ ok: false });
        }
        // Management closure no longer requires parents to close first.
        expect(await restarted.close("binding")).toMatchObject({
          ok: true,
          value: { launchState: "closed" },
        });
        const listed = restarted.status();
        if (!listed.ok) throw new Error(listed.error.message);
        for (const binding of listed.value.filter((entry) => entry.assignment.role === "parent")) {
          expect(await restarted.close(binding.id)).toMatchObject({
            ok: true,
            value: { launchState: "closed", contactState: "cancelled" },
          });
          expect(herdr.workspaces.has(binding.workspaceId ?? "")).toBe(false);
          expect(events).toContain(`terminate:${binding.id}`);
          if (binding.checkout)
            expect((await stat(binding.checkout.path)).isDirectory()).toBe(true);
        }
        expect(await restarted.close("binding")).toMatchObject({
          ok: true,
          value: { launchState: "closed" },
        });
        clock = "2026-09-22T01:00:00.000Z";
        const replacement = await restarted.createSupervisor({
          initiativeId: "initiative",
          scopeDigest: imported.value.digest,
          designationId: "designation",
          execute: true,
          fixture: true,
        });
        expect(replacement).toMatchObject({ ok: true });
        if (!replacement.ok) throw new Error(replacement.error.message);
        expect((await restarted.close(replacement.value.binding.id)).ok).toBe(true);
        for (const failure of ["after", "before"] as const) {
          promptFailure = failure;
          const promptCount = events.filter((event) => event === "prompt").length;
          const interrupted = await restarted.createSupervisor({
            initiativeId: "initiative",
            scopeDigest: imported.value.digest,
            designationId: "designation",
            execute: true,
            fixture: true,
          });
          expect(interrupted).toMatchObject({ ok: false, error: { code: "brief_uncertain" } });
          const recovered = await new Orchestrator(
            root,
            "/fake/herdr.sock",
            dependencies,
          ).reconcile("initiative");
          expect(recovered.ok).toBe(failure === "after");
          expect(events.filter((event) => event === "prompt")).toHaveLength(promptCount + 1);
          const current = restarted.status();
          if (!current.ok) throw new Error(current.error.message);
          const active = current.value.find((binding) => binding.launchState !== "closed");
          if (active === undefined) throw new Error("Missing interrupted role");
          expect(active.launchState).toBe(failure === "after" ? "ready" : "initializing");
          expect((await restarted.close(active.id)).ok).toBe(true);
        }
        promptFailure = null;
        const alive = await restarted.createSupervisor({
          initiativeId: "initiative",
          scopeDigest: imported.value.digest,
          designationId: "designation",
          execute: true,
          fixture: true,
        });
        if (!alive.ok) throw new Error(alive.error.message);
        const aliveParent = await restarted.createParent({
          supervisorId: alive.value.binding.id,
          projectId: "project",
        });
        if (!aliveParent.ok) throw new Error(aliveParent.error.message);
        const launches = events.filter((event) => event === "run").length;
        herdr.nativeIdentities.delete(alive.value.binding.durableSessionId);
        herdr.nativeIdentities.delete(aliveParent.value.binding.durableSessionId);
        expect((await restarted.reconcile("initiative")).ok).toBe(false);
        const lost = restarted.status();
        if (!lost.ok) throw new Error(lost.error.message);
        expect(
          lost.value
            .filter((binding) => binding.launchState !== "closed")
            .map((binding) => binding.launchState),
        ).toEqual(["uncertain", "uncertain"]);
        expect(events.filter((event) => event === "run")).toHaveLength(launches);
        expect((await restarted.close(aliveParent.value.binding.id)).ok).toBe(true);
        expect((await restarted.close(alive.value.binding.id)).ok).toBe(true);
      }
      await rm(root, { recursive: true, force: true });
    },
  );

  test("does not initialize a new role when native protocol 1 is reported", async () => {
    const root = await ownedRoot("omo-orchestrator-protocol-1-");
    const events: string[] = [];
    const herdr = new FakeHerdr(events);
    herdr.protocol = 1;
    let nextId = 0;
    const dependencies: OrchestratorDependencies = {
      openRegistry,
      createHerdrClient: () => herdr,
      resolveHerdrArtifact: async (controlRoot) => ({
        artifactDir: join(controlRoot, ".managed-herdr"),
      }),
      ensureHost: async () => {
        events.push("host");
      },
      checkHostProfile: async () => {},
      gitTip: (cwd, ref) => fixtureTip(root, "commit", cwd, ref),
      now: () => "2026-09-22T00:00:00.000Z",
      uuid: () => ["binding", "session"][nextId++] ?? `id-${nextId}`,
      attachBinding: async (binding) => {
        const identity = herdr.nativeIdentities.get(binding.durableSessionId);
        if (!identity) throw new Error("Exact native session is not open");
        return new FakeNative(identity, events);
      },
      terminateBinding: async () => {},
      prompt: async () => {
        events.push("prompt");
      },
    };
    const scope: ScopeSnapshot = {
      version: 1,
      source: "fixture",
      initiative: { id: "initiative", url: "https://linear.test/i", revision: "r1" },
      projects: [],
      decisionRefs: [],
    };
    const scopeFile = join(root, "scope.json");
    await Bun.write(scopeFile, JSON.stringify(await mappedScope(root, scope)));
    const orchestrator = new Orchestrator(root, "/fake/herdr.sock", dependencies);
    const imported = await orchestrator.importScope(scopeFile, true);
    if (!imported.ok) throw new Error(imported.error.message);

    const result = await orchestrator.createSupervisor({
      initiativeId: "initiative",
      scopeDigest: imported.value.digest,
      designationId: "designation",
      execute: true,
      fixture: true,
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "runtime_unavailable", details: { reason: "host_profile_mismatch" } },
    });
    expect(events).not.toContain("prompt");
    expect(orchestrator.status()).toMatchObject({
      ok: true,
      value: [{ launchState: "uncertain", initialization: { state: "pending" } }],
    });
  });

  test("capacity refusal is actionable before a role pane is launched", async () => {
    const root = await ownedRoot("olw-capacity-launch-");
    const events: string[] = [];
    const herdr = new FakeHerdr(events);
    const dependencies: OrchestratorDependencies = {
      openRegistry,
      createHerdrClient: () => herdr,
      resolveHerdrArtifact: async () => ({ artifactDir: "/fixture-herdr" }),
      ensureHost: async () => {},
      checkHostProfile: async () => {},
      gitTip: (cwd, ref) => fixtureTip(root, "commit", cwd, ref),
      now: () => "2026-09-28T00:00:00.000Z",
      uuid: () => crypto.randomUUID(),
      attachBinding: async () => {
        throw new Error("Capacity must fail before attach");
      },
      terminateBinding: async () => {},
      prompt: async () => {
        throw new Error("Capacity must fail before prompt");
      },
    };
    Object.assign(dependencies, {
      assertHostCapacity: async () => {
        throw new HostCapacityError(20);
      },
    });
    const scope: ScopeSnapshot = {
      version: 1,
      source: "fixture",
      initiative: { id: "initiative", url: "https://linear.test/i", revision: "r1" },
      projects: [],
      decisionRefs: [],
    };
    const scopeFile = join(root, "scope.json");
    await Bun.write(scopeFile, JSON.stringify(await mappedScope(root, scope)));
    const orchestrator = new Orchestrator(root, "/fake/herdr.sock", dependencies);
    const imported = await orchestrator.importScope(scopeFile, true);
    if (!imported.ok) throw new Error(imported.error.message);
    const result = await orchestrator.createSupervisor({
      initiativeId: "initiative",
      scopeDigest: imported.value.digest,
      designationId: "designation",
      execute: true,
      fixture: true,
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "host_session_capacity",
        details: { count: 20, limit: 20, action: "close_an_existing_role" },
      },
    });
    expect(events).not.toContain("run");
  });

  test("capacity race after a passing guard closes the unstarted role without a local TUI", async () => {
    const root = await ownedRoot("olw-capacity-race-");
    const events: string[] = [];
    const herdr = new FakeHerdr(events);
    let checks = 0;
    const dependencies: OrchestratorDependencies = {
      openRegistry,
      createHerdrClient: () => herdr,
      resolveHerdrArtifact: async () => ({ artifactDir: join(root, ".managed-herdr") }),
      ensureHost: async () => {},
      checkHostProfile: async () => {},
      assertHostCapacity: async () => {
        checks++;
        events.push("capacity-available");
      },
      gitTip: (cwd, ref) => fixtureTip(root, "commit", cwd, ref),
      now: () => "2026-09-28T00:00:00.000Z",
      uuid: () => crypto.randomUUID(),
      attachBinding: async () => {
        throw new Error("Native session absent after local fallback");
      },
      terminateBinding: async () => {},
      prompt: async () => {
        throw new Error("An unstarted role must never be prompted");
      },
    };
    Object.assign(dependencies, {
      acquireLaunchSession: async () => {
        expect(checks).toBe(1);
        events.push("native-open-refused");
        throw new HostCapacityError(20);
      },
    });
    const scope: ScopeSnapshot = {
      version: 1,
      source: "fixture",
      initiative: { id: "initiative", url: "https://linear.test/i", revision: "r1" },
      projects: [],
      decisionRefs: [],
    };
    const scopeFile = join(root, "scope.json");
    await Bun.write(scopeFile, JSON.stringify(await mappedScope(root, scope)));
    const orchestrator = new Orchestrator(root, "/fake/herdr.sock", dependencies);
    const imported = await orchestrator.importScope(scopeFile, true);
    if (!imported.ok) throw new Error(imported.error.message);
    const result = await orchestrator.createSupervisor({
      initiativeId: "initiative",
      scopeDigest: imported.value.digest,
      designationId: "designation",
      execute: true,
      fixture: true,
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "host_session_capacity",
        details: { count: 20, limit: 20, action: "close_an_existing_role" },
      },
    });
    expect(events).toContain("native-open-refused");
    expect(events).not.toContain("run");
    expect(events).toContain("close-workspace:ws");
    expect(orchestrator.status()).toMatchObject({
      ok: true,
      value: [{ launchState: "closed", initialization: { state: "pending" } }],
    });
  });

  test("fails role startup before reservation when the managed Herdr artifact is unavailable", async () => {
    const root = await ownedRoot("omo-orchestrator-managed-herdr-");
    const events: string[] = [];
    const herdr = new FakeHerdr(events);
    const dependencies: OrchestratorDependencies = {
      openRegistry,
      createHerdrClient: () => herdr,
      resolveHerdrArtifact: async () => {
        throw new Error("Managed Herdr executable is missing; run bun run herdr:build");
      },
      ensureHost: async () => {
        events.push("host");
      },
      gitTip: (cwd, ref) => fixtureTip(root, "commit", cwd, ref),
      now: () => "2026-09-23T00:00:00.000Z",
      uuid: () => "must-not-reserve",
      attachBinding: async () => {
        throw new Error("must not attach");
      },
      terminateBinding: async () => {},
      prompt: async () => {
        throw new Error("must not prompt");
      },
    };
    const scope: ScopeSnapshot = {
      version: 1,
      source: "fixture",
      initiative: { id: "initiative", url: "https://linear.test/i", revision: "r1" },
      projects: [],
      decisionRefs: [],
    };
    const scopeFile = join(root, "scope.json");
    await Bun.write(scopeFile, JSON.stringify(await mappedScope(root, scope)));
    const orchestrator = new Orchestrator(root, "/fake/herdr.sock", dependencies);
    const imported = await orchestrator.importScope(scopeFile, true);
    if (!imported.ok) throw new Error(imported.error.message);

    expect(
      await orchestrator.createSupervisor({
        initiativeId: "initiative",
        scopeDigest: imported.value.digest,
        designationId: "designation",
        execute: true,
        fixture: true,
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "runtime_unavailable",
        message: "Managed Herdr runtime is unavailable",
        details: "Managed Herdr executable is missing; run bun run herdr:build",
      },
    });
    expect(events).toEqual([]);
    expect(orchestrator.status()).toEqual({ ok: true, value: [] });
  });

  test.each([false, true])(
    "handles startup failure without confusing definite and uncertain outcomes (%s)",
    async (hostFailure) => {
      const root = await ownedRoot("omo-orchestrator-disconnect-");
      const events: string[] = [];
      const herdr = new FakeHerdr(events, {
        event: "connection.error",
        data: { code: "connection_closed", message: "fixture disconnected" },
      });
      let nextId = 0;
      const dependencies: OrchestratorDependencies = {
        openRegistry,
        createHerdrClient: () => herdr,
        resolveHerdrArtifact: async (controlRoot) => ({
          artifactDir: join(controlRoot, ".managed-herdr"),
        }),
        ensureHost: async () => {
          if (hostFailure) throw new Error("Host failed before any role was launched");
        },
        gitTip: (cwd, ref) => fixtureTip(root, "commit", cwd, ref),
        now: () => "2026-09-22T00:00:00.000Z",
        uuid: () =>
          ["binding-disconnect", "session-disconnect", "temp-disconnect"][nextId++] ??
          `id-${nextId}`,
        attachBinding: async () => {
          throw new Error("must not attach after subscription disconnect");
        },
        terminateBinding: async () => {},
        prompt: async () => {
          throw new Error("must not prompt after subscription disconnect");
        },
      };
      const scope: ScopeSnapshot = {
        version: 1,
        source: "fixture",
        initiative: {
          id: "initiative-disconnect",
          url: "https://linear.test/disconnect",
          revision: "r1",
        },
        projects: [],
        decisionRefs: [],
      };
      const scopeFile = join(root, "scope.json");
      await Bun.write(scopeFile, JSON.stringify(await mappedScope(root, scope)));
      const orchestrator = new Orchestrator(root, "/fake/herdr.sock", dependencies);
      const imported = await orchestrator.importScope(scopeFile, true);
      if (!imported.ok) throw new Error(imported.error.message);

      if (scope.initiative === null) throw new Error("Expected initiative fixture");
      const created = await orchestrator.createSupervisor({
        initiativeId: scope.initiative.id,
        scopeDigest: imported.value.digest,
        designationId: "designation-disconnect",
        execute: true,
        fixture: true,
      });

      if (hostFailure) {
        expect(created).toMatchObject({ ok: false, error: { code: "runtime_unavailable" } });
        const status = orchestrator.status();
        expect(status).toMatchObject({ ok: true, value: [{ launchState: "closed" }] });
        const retry = await orchestrator.createSupervisor({
          initiativeId: scope.initiative.id,
          scopeDigest: imported.value.digest,
          designationId: "designation-disconnect",
          execute: true,
          fixture: true,
        });
        expect(retry).toMatchObject({ ok: false, error: { code: "runtime_unavailable" } });
        return;
      }
      expect(created).toEqual({
        ok: false,
        error: {
          code: "runtime_unavailable",
          message: "Role creation became uncertain; reconcile before retrying",
          details: "Herdr subscription connection_closed: fixture disconnected",
        },
      });
      expect(events).not.toContain("attach");
      await rm(root, { recursive: true, force: true });
    },
  );

  test("plan handoff stops the TUI and atomically succeeds it in the same checkout", async () => {
    const root = await ownedRoot("omo-stage-handoff-");
    const events: string[] = [];
    const herdr = new FakeHerdr(events);
    const prompts = new Map<string, Set<string>>();
    let nextId = 0;
    let tip = "commit";
    const dependencies: OrchestratorDependencies = {
      openRegistry,
      createHerdrClient: () => herdr,
      resolveHerdrArtifact: async (controlRoot) => ({
        artifactDir: join(controlRoot, ".managed-herdr"),
      }),
      ensureHost: async () => {},
      gitTip: (cwd, ref) => fixtureTip(root, tip, cwd, ref),
      now: () => "2026-09-26T00:00:00.000Z",
      uuid: () => `stage-id-${++nextId}`,
      attachBinding: async (binding) => {
        const identity = herdr.nativeIdentities.get(binding.durableSessionId);
        if (!identity) throw new NativeSessionAbsentError();
        const messages = prompts.get(binding.durableSessionId) ?? new Set<string>();
        prompts.set(binding.durableSessionId, messages);
        const session = new FakeNative(identity, events, messages);
        session.onConfigure = (current) =>
          herdr.nativeIdentities.set(binding.durableSessionId, current);
        session.send = async (envelope) => {
          const registry = openRegistry(join(root, ".omo/state/registry.sqlite"));
          try {
            const claim = registry.claim(binding.durableSessionId, envelope);
            if (!claim.ok) return claim;
            return registry.finish(
              envelope.id,
              {
                kind: "ok",
                thread_id: claim.value.target?.durableSessionId ?? "",
                message_seq: 1,
                deduplicated: false,
                delivery: { kind: "started", turn_id: "turn" },
              },
              claim.value.nativeKey,
            );
          } finally {
            registry.close();
          }
        };
        return session;
      },
      terminateBinding: async (binding) => {
        events.push(`terminate:${binding.id}`);
        herdr.nativeIdentities.delete(binding.durableSessionId);
      },
      prompt: async (binding, brief) => {
        const messages = prompts.get(binding.durableSessionId);
        if (!messages) throw new Error("Missing prompt target");
        messages.add(brief);
      },
    };
    const scope: ScopeSnapshot = {
      version: 1,
      source: "fixture",
      initiative: { id: "initiative", url: "https://linear.test/i", revision: "r1" },
      projects: [
        {
          project: { id: "project", url: "https://linear.test/p", revision: "r1" },
          issues: [
            { id: "issue", key: "JUN-274", url: "https://linear.test/issue", revision: "r1" },
          ],
        },
      ],
      decisionRefs: [],
    };
    const scopeFile = join(root, "scope.json");
    await Bun.write(scopeFile, JSON.stringify(await mappedScope(root, scope)));
    const orchestrator = new Orchestrator(root, "/fake/herdr.sock", dependencies);
    const imported = await orchestrator.importScope(scopeFile, true);
    if (!imported.ok) throw new Error(imported.error.message);
    const supervisor = await orchestrator.createSupervisor({
      initiativeId: "initiative",
      scopeDigest: imported.value.digest,
      designationId: "designation",
      execute: true,
      fixture: true,
    });
    if (!supervisor.ok) throw new Error(supervisor.error.message);
    const parent = await orchestrator.createParent({
      supervisorId: supervisor.value.binding.id,
      projectId: "project",
    });
    if (!parent.ok) throw new Error(parent.error.message);
    const plan = await orchestrator.createChild({
      parentId: parent.value.binding.id,
      issueId: "issue",
      mode: "planned",
    });
    if (!plan.ok || plan.value.binding.checkout === null) throw new Error("Missing plan checkout");
    const binding = plan.value.binding;
    const checkout = binding.checkout;
    if (checkout === null) throw new Error("Missing plan checkout");
    const live = () => {
      const status = orchestrator.status({ projectId: "project" });
      if (!status.ok) throw new Error(status.error.message);
      return status.value.filter(
        (item) => item.assignment.role === "child" && item.launchState !== "closed",
      );
    };
    expect(live().map((item) => item.id)).toEqual([binding.id]);
    const missing = await orchestrator.stageStart({
      fromId: binding.id,
      stage: "execute",
      parentId: parent.value.binding.id,
      messageId: "start",
    });
    expect(missing).toMatchObject({ ok: false, error: { code: "handoff_missing" } });
    expect(live().map((item) => item.id)).toEqual([binding.id]);
    const path = join(checkout.path, "plan.md");
    const linkedPath = join(checkout.path, "submitted-plan.md");
    await mkdir(checkout.path, { recursive: true });
    await Bun.write(path, "Plan content");
    await symlink(path, linkedPath);
    const wrong = await orchestrator.stageComplete({
      fromId: binding.id,
      planPath: linkedPath,
      head: "wrong",
      messageId: "report",
      text: "done",
    });
    expect(wrong).toMatchObject({ ok: false, error: { code: "head_mismatch" } });
    const completed = await orchestrator.stageComplete({
      fromId: binding.id,
      planPath: linkedPath,
      head: tip,
      messageId: "report",
      text: "done",
    });
    expect(completed).toMatchObject({
      ok: true,
      value: { state: "accepted", envelope: { evidence: [path] } },
    });
    const registry = openRegistry(join(root, ".omo/state/registry.sqlite"));
    try {
      expect(registry.stageOf(binding.id)).toMatchObject({
        ok: true,
        value: { handoff: { planPath: path, head: tip } },
      });
    } finally {
      registry.close();
    }
    expect(live().map((item) => item.id)).toEqual([binding.id]);
    const deliveries = new Database(join(root, ".omo/state/registry.sqlite"));
    const nativeHandoff = deliveries
      .query<{ handoff_json: string }, []>(
        "SELECT handoff_json FROM stage_lineage WHERE binding_id = 'stage-id-5'",
      )
      .get();
    if (nativeHandoff === null) throw new Error("Missing native handoff fixture");
    deliveries.run(
      "UPDATE stage_lineage SET handoff_json = json_remove(handoff_json, '$.completionReportId') WHERE binding_id = 'stage-id-5'",
    );
    const recoveredLegacy = await orchestrator.stageComplete({
      fromId: binding.id,
      planPath: path,
      head: tip,
      messageId: "report",
      text: "done",
    });
    expect(recoveredLegacy).toMatchObject({ ok: true, value: { state: "accepted" } });
    const recoveredStage = deliveries
      .query<{ handoff_json: string }, []>(
        "SELECT handoff_json FROM stage_lineage WHERE binding_id = 'stage-id-5'",
      )
      .get();
    expect(JSON.parse(recoveredStage?.handoff_json ?? "null")).toMatchObject({
      completedAt: "2026-09-26T00:00:00.000Z",
      completionReportId: "report",
    });
    expect(
      await orchestrator.stageComplete({
        fromId: binding.id,
        planPath: path,
        head: tip,
        messageId: "report",
        text: "done",
      }),
    ).toEqual(recoveredLegacy);
    expect(
      await orchestrator.stageComplete({
        fromId: binding.id,
        planPath: path,
        head: tip,
        messageId: "different-report",
        text: "done",
      }),
    ).toMatchObject({ ok: false, error: { code: "handoff_conflict" } });
    deliveries.run(
      "UPDATE stage_lineage SET handoff_json = json_remove(handoff_json, '$.completionReportId') WHERE binding_id = 'stage-id-5'",
    );
    const beforeLegacyStart = events.length;
    expect(
      await orchestrator.stageStart({
        fromId: binding.id,
        stage: "execute",
        parentId: parent.value.binding.id,
        messageId: "start",
      }),
    ).toMatchObject({
      ok: false,
      error: {
        code: "plan_report_not_accepted",
        message: expect.stringContaining("stage complete"),
      },
    });
    expect(events).toHaveLength(beforeLegacyStart);
    deliveries.run("UPDATE stage_lineage SET handoff_json = ? WHERE binding_id = 'stage-id-5'", [
      nativeHandoff.handoff_json,
    ]);
    deliveries.run("UPDATE deliveries SET state = 'uncertain' WHERE message_id = 'report'");
    deliveries.close();
    const beforeUnacceptedStart = events.length;
    expect(
      await orchestrator.stageStart({
        fromId: binding.id,
        stage: "execute",
        parentId: parent.value.binding.id,
        messageId: "start",
      }),
    ).toMatchObject({ ok: false, error: { code: "plan_report_not_accepted" } });
    expect(events).toHaveLength(beforeUnacceptedStart);
    expect(live().map((item) => item.id)).toEqual([binding.id]);
    const acceptedDeliveries = new Database(join(root, ".omo/state/registry.sqlite"));
    acceptedDeliveries.run("UPDATE deliveries SET state = 'accepted' WHERE message_id = 'report'");
    acceptedDeliveries.close();
    await Bun.write(path, "Changed plan content");
    const beforeChangedPlanStart = events.length;
    expect(
      await orchestrator.stageStart({
        fromId: binding.id,
        stage: "execute",
        parentId: parent.value.binding.id,
        messageId: "start",
      }),
    ).toMatchObject({ ok: false, error: { code: "plan_changed" } });
    expect(events).toHaveLength(beforeChangedPlanStart);
    expect(live().map((item) => item.id)).toEqual([binding.id]);
    await Bun.write(path, "Plan content");
    tip = "changed";
    expect(
      await orchestrator.stageStart({
        fromId: binding.id,
        stage: "execute",
        parentId: parent.value.binding.id,
        messageId: "start",
      }),
    ).toMatchObject({ ok: false, error: { code: "head_mismatch" } });
    tip = "commit";
    expect(live().map((item) => item.id)).toEqual([binding.id]);
    const fake = herdr.nativeIdentities.get(parent.value.binding.durableSessionId);
    if (!fake) throw new Error("Missing owner");
    herdr.nativeIdentities.set(parent.value.binding.durableSessionId, { ...fake, cwd: "/wrong" });
    expect(
      await orchestrator.stageStart({
        fromId: binding.id,
        stage: "execute",
        parentId: parent.value.binding.id,
        messageId: "start",
      }),
    ).toMatchObject({ ok: false, error: { code: "identity_mismatch" } });
    herdr.nativeIdentities.set(parent.value.binding.durableSessionId, fake);
    expect(live().map((item) => item.id)).toEqual([binding.id]);
    const wrongParent = await orchestrator.stageStart({
      fromId: binding.id,
      parentId: supervisor.value.binding.id,
      stage: "execute",
      messageId: "start",
    });
    expect(wrongParent).toMatchObject({ ok: false, error: { code: "owner_mismatch" } });
    expect(live().map((item) => item.id)).toEqual([binding.id]);
    const hostMismatch = new Orchestrator(root, "/fake/herdr.sock", {
      ...dependencies,
      checkHostProfile: async () => {
        throw new Error("host profile mismatch");
      },
    });
    expect(
      await hostMismatch.stageStart({
        fromId: binding.id,
        parentId: parent.value.binding.id,
        stage: "execute",
        messageId: "start",
      }),
    ).toMatchObject({ ok: false, error: { code: "runtime_unavailable" } });
    expect(live().map((item) => item.id)).toEqual([binding.id]);
    expect(
      herdr.tabCalls.filter(
        (call) =>
          typeof call === "object" &&
          call !== null &&
          "method" in call &&
          call.method === "sendKeys",
      ),
    ).toHaveLength(0);
    const beforeStart = events.length;
    const stopped = herdr.sendKeys.bind(herdr);
    herdr.sendKeys = async (paneId, text, keys) => {
      await stopped(paneId, text, keys);
      throw new Error("interrupted after quit");
    };
    expect(
      await orchestrator.stageStart({
        fromId: binding.id,
        parentId: parent.value.binding.id,
        stage: "execute",
        messageId: "start",
      }),
    ).toMatchObject({ ok: false, error: { code: "runtime_unavailable" } });
    herdr.sendKeys = stopped;
    expect(events.slice(beforeStart)).toContain(`sendKeys:${binding.paneId}`);
    expect(live().map((item) => item.id)).toEqual([binding.id]);
    expect(herdr.nativeIdentities.has(binding.durableSessionId)).toBe(true);
    const quitCount = herdr.tabCalls.filter(
      (call) =>
        typeof call === "object" && call !== null && "method" in call && call.method === "sendKeys",
    ).length;
    const originalTerminate = dependencies.terminateBinding;
    let stoppedOnce = false;
    const interruptedDependencies: OrchestratorDependencies = {
      ...dependencies,
      terminateBinding: async (child) => {
        await originalTerminate(child);
        if (!stoppedOnce) {
          stoppedOnce = true;
          throw new Error("interrupted after termination");
        }
      },
    };
    expect(
      await new Orchestrator(root, "/fake/herdr.sock", interruptedDependencies).stageStart({
        fromId: binding.id,
        parentId: parent.value.binding.id,
        stage: "execute",
        messageId: "start",
      }),
    ).toMatchObject({ ok: false, error: { code: "runtime_unavailable" } });
    expect(live().map((item) => item.id)).toEqual([binding.id]);
    expect(
      herdr.tabCalls.filter(
        (call) =>
          typeof call === "object" &&
          call !== null &&
          "method" in call &&
          call.method === "sendKeys",
      ),
    ).toHaveLength(quitCount);
    expect(herdr.nativeIdentities.has(binding.durableSessionId)).toBe(false);
    const editDuringStop = new Orchestrator(root, "/fake/herdr.sock", {
      ...dependencies,
      terminateBinding: async (child) => {
        await Bun.write(path, "Plan edited while predecessor exits");
        await originalTerminate(child);
      },
    });
    expect(
      await editDuringStop.stageStart({
        fromId: binding.id,
        parentId: parent.value.binding.id,
        stage: "execute",
        messageId: "start",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "plan_changed", message: expect.stringContaining("already stopped") },
    });
    expect(live().map((item) => item.id)).toEqual([binding.id]);
    await Bun.write(path, "Plan content");
    const originalTab = herdr.createTab.bind(herdr);
    let failedTab = false;
    herdr.createTab = async (workspaceId, cwd, label) => {
      if (!failedTab) {
        failedTab = true;
        throw new Error("interrupted after reservation");
      }
      return originalTab(workspaceId, cwd, label);
    };
    expect(
      await orchestrator.stageStart({
        fromId: binding.id,
        parentId: parent.value.binding.id,
        stage: "execute",
        messageId: "start",
      }),
    ).toMatchObject({ ok: false, error: { code: "runtime_unavailable" } });
    expect(live()).toHaveLength(1);
    expect(live()[0]?.id).not.toBe(binding.id);
    const originalRun = herdr.run.bind(herdr);
    let interruptedRun = false;
    herdr.run = async (paneId, argv, env) => {
      await originalRun(paneId, argv, env);
      if (!interruptedRun) {
        interruptedRun = true;
        throw new Error("interrupted after launch before init");
      }
    };
    expect(
      await orchestrator.stageStart({
        fromId: binding.id,
        parentId: parent.value.binding.id,
        stage: "execute",
        messageId: "start",
      }),
    ).toMatchObject({ ok: false, error: { code: "runtime_unavailable" } });
    expect(live()).toHaveLength(1);
    const worktreesBefore = herdr.nextWorkspace;
    const started = await orchestrator.stageStart({
      fromId: binding.id,
      stage: "execute",
      parentId: parent.value.binding.id,
      messageId: "start",
    });
    if (!started.ok) throw new Error(JSON.stringify(started.error));
    expect(live().map((item) => item.id)).toEqual([started.value.binding.id]);
    expect(started.value.binding.checkout?.path).toBe(checkout.path);
    expect(started.value.binding.checkout?.branch).toBe(checkout.branch);
    expect(herdr.nextWorkspace).toBe(worktreesBefore);
    expect(herdr.tabCalls).toContainEqual({
      method: "createTab",
      workspaceId: binding.workspaceId,
      cwd: checkout.path,
      label: "execute",
      tabId: `${binding.workspaceId}:t2`,
      rootPaneId: `${binding.workspaceId}:p2`,
    });
    expect(herdr.tabCalls).toContainEqual({
      method: "sendKeys",
      paneId: binding.paneId,
      text: "/quit",
      keys: ["Enter"],
    });
    expect(events.indexOf(`sendKeys:${binding.paneId}`)).toBeLessThan(
      events.indexOf(`terminate:${binding.id}`),
    );
    expect(events).not.toContain(`close-workspace:${binding.workspaceId}`);
    expect(herdr.lastArgv[herdr.lastArgv.indexOf("--model") + 1]).toBe(
      "opencodex/anthropic/claude-opus-5-5",
    );
    expect(herdr.lastArgv[herdr.lastArgv.indexOf("--thinking") + 1]).toBe("medium");
    expect(started.value.binding.initialization.text).toContain(path);
    expect(started.value.binding.initialization.text).toContain(tip);
    const sessionPath = herdr.lastArgv[herdr.lastArgv.indexOf("--session") + 1];
    if (!sessionPath) throw new Error("Missing session seed");
    const seed = SessionManager.open(sessionPath, join(root, ".omo/state/sessions"), checkout.path);
    expect(seed.buildSessionContext().thinkingLevel).toBe("medium");
    expect(seed.buildSessionContext().model?.modelId).toBe("anthropic/claude-opus-5-5");
    expect(await Bun.file(binding.sessionPath ?? "").exists()).toBe(true);
    const runsBeforeRecovery = events.filter((event) => event === "run").length;
    const observationFailure = new Orchestrator(root, "/fake/herdr.sock", {
      ...dependencies,
      attachBinding: async (candidate) => {
        if (candidate.id === started.value.binding.id)
          throw new Error("transient RPC transport failure");
        return dependencies.attachBinding(candidate);
      },
    });
    expect(
      await observationFailure.stageStart({
        fromId: binding.id,
        parentId: parent.value.binding.id,
        stage: "execute",
        messageId: "start",
      }),
    ).toMatchObject({
      ok: false,
      error: {
        code: "runtime_unavailable",
        details: "transient RPC transport failure",
      },
    });
    expect(events.filter((event) => event === "run")).toHaveLength(runsBeforeRecovery);

    for (const status of ["opening", "closing"] as const) {
      const presentButUnavailable = new Orchestrator(root, "/fake/herdr.sock", {
        ...dependencies,
        attachBinding: async (candidate) => {
          if (candidate.id !== started.value.binding.id)
            return dependencies.attachBinding(candidate);
          const rpc: RpcPort = {
            getMessages: async () => [],
            setModel: async () => {},
            setThinkingLevel: async () => {},
            start: async () => {},
            stop: async () => {},
            closeSession: async () => {},
            listSessions: async () => [
              {
                sessionId: "execute-native-row",
                durableSessionId: candidate.durableSessionId,
                ...(candidate.sessionPath === null ? {} : { sessionPath: candidate.sessionPath }),
                cwd: candidate.cwd,
                status,
              },
            ],
            openSession: async () => ({ sessionId: "execute-native-row", attached: true }),
            requestExtension: async () => {
              throw new Error("present non-open session must not be attached");
            },
            onEvent: () => () => {},
          };
          return attachBindingWithClient(candidate, rpc);
        },
      });
      expect(
        await presentButUnavailable.stageStart({
          fromId: binding.id,
          parentId: parent.value.binding.id,
          stage: "execute",
          messageId: "start",
        }),
      ).toMatchObject({
        ok: false,
        error: { code: "runtime_unavailable", details: expect.stringContaining(status) },
      });
      expect(events.filter((event) => event === "run")).toHaveLength(runsBeforeRecovery);
    }

    herdr.nativeIdentities.delete(started.value.binding.durableSessionId);
    expect(
      await orchestrator.stageStart({
        fromId: binding.id,
        parentId: parent.value.binding.id,
        stage: "execute",
        messageId: "start",
      }),
    ).toMatchObject({ ok: false, error: { code: "runtime_unavailable" } });
    expect(events.filter((event) => event === "run")).toHaveLength(runsBeforeRecovery);

    herdr.paneSessions.delete(started.value.binding.paneId ?? "");
    const recovered = await orchestrator.stageStart({
      fromId: binding.id,
      parentId: parent.value.binding.id,
      stage: "execute",
      messageId: "start",
    });
    expect(recovered).toMatchObject({
      ok: true,
      value: { binding: { id: started.value.binding.id } },
    });
    expect(events.filter((event) => event === "run")).toHaveLength(runsBeforeRecovery + 1);
    expect(live()).toHaveLength(1);
    expect(
      await orchestrator.stageStart({
        fromId: binding.id,
        stage: "execute",
        parentId: parent.value.binding.id,
        messageId: "start",
      }),
    ).toEqual(started);
    expect(live().map((item) => item.id)).toEqual([started.value.binding.id]);
  });

  test("reconcile restores execute brief path and head from durable handoff", async () => {
    const root = await ownedRoot("omo-orchestrator-execute-reconcile-");
    const events: string[] = [];
    const prompts = new Map<string, Set<string>>();
    const herdr = new FakeHerdr(events);
    let sequence = 0;
    let failExecuteRun = false;
    const dependencies: OrchestratorDependencies = {
      openRegistry,
      createHerdrClient: () => herdr,
      resolveHerdrArtifact: async (controlRoot) => ({
        artifactDir: join(controlRoot, ".managed-herdr"),
      }),
      ensureHost: async () => {},
      gitTip: (cwd, ref) => fixtureTip(root, "handoff-head-123", cwd, ref),
      now: () => "2026-09-26T00:00:00.000Z",
      uuid: () => `execute-reconcile-${++sequence}`,
      attachBinding: async (binding) => {
        const identity = herdr.nativeIdentities.get(binding.durableSessionId);
        if (identity === undefined) throw new Error("Exact native session is not open");
        let messages = prompts.get(binding.durableSessionId);
        if (messages === undefined) {
          messages = new Set();
          prompts.set(binding.durableSessionId, messages);
        }
        const session = new FakeNative(identity, events, messages);
        session.onConfigure = (current) =>
          herdr.nativeIdentities.set(binding.durableSessionId, current);
        session.send = async (envelope) => {
          const registry = openRegistry(join(root, ".omo/state/registry.sqlite"));
          try {
            const claim = registry.claim(binding.durableSessionId, envelope);
            if (!claim.ok) return claim;
            return registry.finish(
              envelope.id,
              {
                kind: "ok",
                thread_id: claim.value.target?.durableSessionId ?? "",
                message_seq: 1,
                deduplicated: false,
                delivery: { kind: "started", turn_id: "turn" },
              },
              claim.value.nativeKey,
            );
          } finally {
            registry.close();
          }
        };
        return session;
      },
      terminateBinding: async () => {},
      prompt: async (binding, text) => {
        prompts.get(binding.durableSessionId)?.add(text);
      },
    };
    const originalRun = herdr.run.bind(herdr);
    herdr.run = async (paneId, argv, env) => {
      await originalRun(paneId, argv, env);
      const sessionIndex = argv.indexOf("--session");
      const sessionPath = argv[sessionIndex + 1];
      if (!failExecuteRun || sessionPath === undefined) return;
      const registry = openRegistry(join(root, ".omo/state/registry.sqlite"));
      let stage: ReturnType<typeof registry.stageOf>;
      try {
        const listed = registry.list();
        if (!listed.ok) throw new Error(listed.error.message);
        const launched = listed.value.find((item) => item.sessionPath === sessionPath);
        if (launched === undefined) throw new Error("Missing launched execute binding");
        stage = registry.stageOf(launched.id);
      } finally {
        registry.close();
      }
      if (!stage?.ok || stage.value?.stage !== "execute") return;
      failExecuteRun = false;
      throw new Error("interrupted after execute readiness before initialization");
    };
    const scope: ScopeSnapshot = {
      version: 1,
      source: "fixture",
      initiative: { id: "initiative-execute", url: "https://linear.test/i", revision: "r1" },
      projects: [
        {
          project: { id: "project-execute", url: "https://linear.test/p", revision: "r1" },
          issues: [
            {
              id: "issue-uuid-123",
              key: "JUN-274",
              url: "https://linear.test/issue/JUN-274/title",
              revision: "r1",
            },
          ],
        },
      ],
      decisionRefs: [],
    };
    const scopeFile = join(root, "scope.json");
    await Bun.write(scopeFile, JSON.stringify(await mappedScope(root, scope)));
    const orchestrator = new Orchestrator(root, "/fake/herdr.sock", dependencies);
    const imported = await orchestrator.importScope(scopeFile, true);
    if (!imported.ok) throw new Error(imported.error.message);
    const supervisor = await orchestrator.createSupervisor({
      initiativeId: "initiative-execute",
      scopeDigest: imported.value.digest,
      designationId: "designation-execute",
      execute: true,
      fixture: true,
    });
    if (!supervisor.ok) throw new Error(supervisor.error.message);
    const parent = await orchestrator.createParent({
      supervisorId: supervisor.value.binding.id,
      projectId: "project-execute",
    });
    if (!parent.ok) throw new Error(parent.error.message);
    const plan = await orchestrator.createChild({
      parentId: parent.value.binding.id,
      issueId: "issue-uuid-123",
      mode: "planned",
    });
    if (!plan.ok || plan.value.binding.checkout === null) throw new Error("Missing plan child");
    const planBinding = plan.value.binding;
    const planCheckout = planBinding.checkout;
    if (planCheckout === null) throw new Error("Missing plan checkout");
    const alternatePath = join(planCheckout.path, "approved-alternate.md");
    await mkdir(planCheckout.path, { recursive: true });
    await Bun.write(alternatePath, "Approved alternate plan");
    const completed = await orchestrator.stageComplete({
      fromId: planBinding.id,
      planPath: alternatePath,
      head: "handoff-head-123",
      messageId: "complete-plan",
      text: "Plan approved for execution",
    });
    expect(completed).toMatchObject({ ok: true, value: { state: "accepted" } });
    failExecuteRun = true;
    const interrupted = await orchestrator.stageStart({
      fromId: planBinding.id,
      parentId: parent.value.binding.id,
      stage: "execute",
      messageId: "start-execute",
    });
    expect(interrupted).toMatchObject({ ok: false, error: { code: "runtime_unavailable" } });

    const restarted = new Orchestrator(root, "/fake/herdr.sock", dependencies);
    const reconciled = await restarted.reconcile({ projectId: "project-execute" });
    expect(reconciled.ok).toBe(true);
    if (!reconciled.ok) throw new Error(JSON.stringify(reconciled.error));
    const executeBinding = reconciled.value.bindings.find(
      (item) => item.assignment.role === "child" && item.id !== planBinding.id,
    );
    if (executeBinding === undefined) throw new Error("Reconcile omitted execute binding");
    expect(executeBinding.initialization.state).toBe("accepted");
    const executeBrief = executeBinding.initialization.text;
    expect(executeBrief).toContain(`plan_path: ${alternatePath}`);
    expect(executeBrief).toContain("plan_head: handoff-head-123");
    expect(executeBrief).not.toContain(".omo/plans/JUN-274.md");
    expect(executeBrief).not.toContain("<issue-key>");
  });

  test("reconcile rebuilds a planned brief with its scoped issue key after startup interruption", async () => {
    const root = await ownedRoot("omo-orchestrator-plan-reconcile-");
    const events: string[] = [];
    const prompts = new Map<string, Set<string>>();
    const herdr = new FakeHerdr(events);
    let sequence = 0;
    let failAfterRun = false;
    const dependencies: OrchestratorDependencies = {
      openRegistry,
      createHerdrClient: () => herdr,
      resolveHerdrArtifact: async (controlRoot) => ({
        artifactDir: join(controlRoot, ".managed-herdr"),
      }),
      ensureHost: async () => {},
      gitTip: (cwd, ref) => fixtureTip(root, "commit", cwd, ref),
      now: () => "2026-09-26T00:00:00.000Z",
      uuid: () => `reconcile-${++sequence}`,
      attachBinding: async (binding) => {
        const identity = herdr.nativeIdentities.get(binding.durableSessionId);
        if (identity === undefined) throw new Error("Exact native session is not open");
        let messages = prompts.get(binding.durableSessionId);
        if (messages === undefined) {
          messages = new Set();
          prompts.set(binding.durableSessionId, messages);
        }
        const session = new FakeNative(identity, events, messages);
        session.onConfigure = (current) =>
          herdr.nativeIdentities.set(binding.durableSessionId, current);
        return session;
      },
      terminateBinding: async () => {},
      prompt: async (binding, text) => {
        prompts.get(binding.durableSessionId)?.add(text);
      },
    };
    herdr.run = async function run(paneId, argv, env) {
      await FakeHerdr.prototype.run.call(this, paneId, argv, env);
      if (failAfterRun) {
        failAfterRun = false;
        throw new Error("interrupted after startup before initialization");
      }
    };
    const scope: ScopeSnapshot = {
      version: 1,
      source: "fixture",
      initiative: { id: "initiative-reconcile", url: "https://linear.test/i", revision: "r1" },
      projects: [
        {
          project: { id: "project-reconcile", url: "https://linear.test/p", revision: "r1" },
          issues: [
            {
              id: "issue-uuid-123",
              key: "JUN-274",
              url: "https://linear.test/issue/JUN-274/title",
              revision: "r1",
            },
          ],
        },
      ],
      decisionRefs: [],
    };
    const scopeFile = join(root, "scope.json");
    await Bun.write(scopeFile, JSON.stringify(await mappedScope(root, scope)));
    const orchestrator = new Orchestrator(root, "/fake/herdr.sock", dependencies);
    const imported = await orchestrator.importScope(scopeFile, true);
    if (!imported.ok) throw new Error(imported.error.message);
    const supervisor = await orchestrator.createSupervisor({
      initiativeId: "initiative-reconcile",
      scopeDigest: imported.value.digest,
      designationId: "designation-reconcile",
      execute: true,
      fixture: true,
    });
    if (!supervisor.ok) throw new Error(supervisor.error.message);
    const parent = await orchestrator.createParent({
      supervisorId: supervisor.value.binding.id,
      projectId: "project-reconcile",
    });
    if (!parent.ok) throw new Error(parent.error.message);

    failAfterRun = true;
    const created = await orchestrator.createChild({
      parentId: parent.value.binding.id,
      issueId: "issue-uuid-123",
      mode: "planned",
    });
    expect(created).toMatchObject({ ok: false, error: { code: "runtime_unavailable" } });

    const reconciled = await orchestrator.reconcile({ projectId: "project-reconcile" });
    expect(reconciled.ok).toBe(true);
    if (!reconciled.ok) throw new Error(JSON.stringify(reconciled.error));
    const child = reconciled.value.bindings.find((binding) => binding.assignment.role === "child");
    if (child === undefined)
      throw new Error(`Reconcile omitted child: ${JSON.stringify(reconciled.value.bindings)}`);
    const acceptedBrief = child.initialization.text;
    expect(acceptedBrief).toContain("stage: plan");
    expect(acceptedBrief).toContain("plan_path: .omo/plans/JUN-274.md");
    expect(acceptedBrief).not.toContain("<issue-key>");
    expect(acceptedBrief).not.toContain(".omo/plans/issue-uuid-123.md");
  });

  test.each([
    ["direct", "direct", "opencodex/anthropic/claude-opus-5-5", "medium", false],
    ["planned", "plan", "opencodex/anthropic/claude-fable-5-1", "xhigh", true],
    ["research", "research", "opencodex/anthropic/claude-opus-5-5", "xhigh", false],
  ] as const)(
    "child create --mode %s launches stage %s and records lineage ordinal 0",
    async (mode, stage, modelArg, thinking, renamesPlanTab) => {
      const root = await ownedRoot(`omo-orchestrator-mode-${mode}-`);
      const events: string[] = [];
      const prompts = new Map<string, Set<string>>();
      const herdr = new FakeHerdr(events);
      let nextId = 0;
      const dependencies: OrchestratorDependencies = {
        openRegistry,
        createHerdrClient: () => herdr,
        resolveHerdrArtifact: async (controlRoot) => ({
          artifactDir: join(controlRoot, ".managed-herdr"),
        }),
        ensureHost: async () => {
          events.push("host");
        },
        gitTip: (cwd, ref) => fixtureTip(root, "commit", cwd, ref),
        now: () => "2026-09-26T00:00:00.000Z",
        uuid: () =>
          [
            "supervisor-binding",
            "supervisor-session",
            "parent-binding",
            "parent-session",
            "child-binding",
            "child-session",
          ][nextId++] ?? `id-${nextId}`,
        attachBinding: async (binding: Binding) => {
          events.push("attach");
          const identity = herdr.nativeIdentities.get(binding.durableSessionId);
          if (identity === undefined) throw new Error("Exact native session is not open");
          let messages = prompts.get(binding.durableSessionId);
          if (messages === undefined) {
            messages = new Set();
            prompts.set(binding.durableSessionId, messages);
          }
          const session = new FakeNative(identity, events, messages);
          session.onConfigure = (current) =>
            herdr.nativeIdentities.set(binding.durableSessionId, current);
          return session;
        },
        terminateBinding: async () => {},
        prompt: async (binding, brief) => {
          const messages = prompts.get(binding.durableSessionId);
          if (messages === undefined) throw new Error("No exact native session");
          messages.add(brief);
        },
      };
      const scope: ScopeSnapshot = {
        version: 1,
        source: "fixture",
        initiative: { id: "initiative", url: "https://linear.test/i", revision: "r1" },
        projects: [
          {
            project: { id: "project", url: "https://linear.test/p", revision: "r1" },
            issues: [
              {
                id: "issue",
                ...(mode === "planned" ? { key: "JUN-274" } : {}),
                url: "https://linear.test/issue",
                revision: "r1",
              },
            ],
          },
        ],
        decisionRefs: [],
      };
      const scopeFile = join(root, "scope.json");
      await Bun.write(scopeFile, JSON.stringify(await mappedScope(root, scope)));
      const orchestrator = new Orchestrator(root, "/fake/herdr.sock", dependencies);
      const imported = await orchestrator.importScope(scopeFile, true);
      if (!imported.ok) throw new Error(imported.error.message);
      const supervisor = await orchestrator.createSupervisor({
        initiativeId: "initiative",
        scopeDigest: imported.value.digest,
        designationId: "designation",
        execute: true,
        fixture: true,
      });
      if (!supervisor.ok) throw new Error(supervisor.error.message);
      const parent = await orchestrator.createParent({
        supervisorId: supervisor.value.binding.id,
        projectId: "project",
      });
      if (!parent.ok) throw new Error(parent.error.message);
      const runsBefore = events.filter((event) => event === "run").length;
      if (mode === "planned") herdr.rootTabFromCreate = false;

      const created = await orchestrator.createChild({
        parentId: parent.value.binding.id,
        issueId: "issue",
        mode,
      });

      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error(created.error.message);
      expect(created.value.stage).toBe(stage);
      expect(created.value.mode).toBe(mode);
      expect(created.value.expectedModel).toEqual(modelForLaunch("child", stage));
      if (mode === "planned") {
        expect(created.value.binding.assignment.role).toBe("child");
        expect(created.value.binding.initialization.text).toContain(
          "plan_path: .omo/plans/JUN-274.md",
        );
        expect(created.value.binding.initialization.text).not.toContain(".omo/plans/issue.md");
        expect(planPathForIssueKey("../../unsafe")).toMatchObject({
          ok: false,
          error: { code: "invalid_input" },
        });
        expect(planPathForIssueKey("../../unsafe")).toMatchObject({
          ok: false,
          error: { code: "invalid_input" },
        });
      }
      const childRuns = events.filter((event) => event === "run").length - runsBefore;
      expect(childRuns).toBe(1);
      const argv = herdr.lastArgv;
      expect(argv).toContain("--model");
      expect(argv[argv.indexOf("--model") + 1]).toBe(modelArg);
      expect(argv[argv.indexOf("--thinking") + 1]).toBe(thinking);
      expect(argv[argv.indexOf("--name") + 1]).toBe(
        roleLabel(
          {
            role: "child",
            initiativeId: "initiative",
            projectId: "project",
            issueId: "issue",
            ownerBindingId: parent.value.binding.id,
          },
          scope,
          created.value.binding.id,
        ),
      );
      const seedPath = argv[argv.indexOf("--session") + 1];
      if (seedPath === undefined) throw new Error("Missing seed path");
      const seed = SessionManager.open(seedPath, join(root, ".omo/state/sessions"), root);
      expect(seed.buildSessionContext().model).toEqual({
        provider: "opencodex",
        modelId: modelArg.slice("opencodex/".length),
      });
      expect(seed.buildSessionContext().thinkingLevel).toBe(thinking);
      if (mode === "planned") {
        expect(created.value.binding.initialization.text).toContain(
          "plan_path: .omo/plans/JUN-274.md",
        );
      }
      const registry = openRegistry(join(root, ".omo/state/registry.sqlite"));
      try {
        const lineage = registry.lineageFor(created.value.binding.id);
        expect(lineage).toMatchObject({
          ok: true,
          value: {
            issueId: "issue",
            mode,
            stages: [
              {
                bindingId: created.value.binding.id,
                stage,
                ordinal: 0,
                launchState: "ready",
              },
            ],
          },
        });
        const recorded = registry.stageOf(created.value.binding.id);
        expect(recorded).toMatchObject({
          ok: true,
          value: {
            bindingId: created.value.binding.id,
            issueId: "issue",
            stage,
            ordinal: 0,
            previousBindingId: null,
          },
        });
      } finally {
        registry.close();
      }
      const planRenames = herdr.tabCalls.filter(
        (call) =>
          typeof call === "object" &&
          call !== null &&
          "method" in call &&
          call.method === "renameTab" &&
          "label" in call &&
          call.label === "plan",
      );
      if (renamesPlanTab) {
        const childWorkspace = [...herdr.workspaces.values()].find(
          (workspace) => workspace.workspaceId === created.value.binding.workspaceId,
        );
        expect(planRenames).toEqual([
          { method: "renameTab", tabId: childWorkspace?.rootTabId, label: "plan" },
        ]);
      } else {
        expect(planRenames).toEqual([]);
      }
      expect(created.value.binding.checkout?.branch).toContain("issues/issue-");
    },
  );

  test("a failed stage record closes the reservation and launches nothing", async () => {
    const root = await ownedRoot("omo-orchestrator-stage-fail-");
    const events: string[] = [];
    const herdr = new FakeHerdr(events);
    let nextId = 0;
    const realOpen = openRegistry;
    const dependencies: OrchestratorDependencies = {
      openRegistry: (path, options) => {
        const registry = realOpen(path, options);
        return new Proxy(registry, {
          get(target, property, receiver) {
            if (property === "recordStage") {
              return () => ({
                ok: false as const,
                error: { code: "storage_error", message: "stage write failed" },
              });
            }
            const value = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
      createHerdrClient: () => herdr,
      resolveHerdrArtifact: async (controlRoot) => ({
        artifactDir: join(controlRoot, ".managed-herdr"),
      }),
      ensureHost: async () => {
        events.push("host");
      },
      gitTip: (cwd, ref) => fixtureTip(root, "commit", cwd, ref),
      now: () => "2026-09-26T00:00:00.000Z",
      uuid: () =>
        ["supervisor-binding", "supervisor-session", "parent-binding", "parent-session"][
          nextId++
        ] ?? `id-${nextId}`,
      attachBinding: async (binding: Binding) => {
        const identity = herdr.nativeIdentities.get(binding.durableSessionId);
        if (identity === undefined) throw new Error("Exact native session is not open");
        return new FakeNative(identity, events);
      },
      terminateBinding: async () => {},
      prompt: async () => {},
    };
    const scope: ScopeSnapshot = {
      version: 1,
      source: "fixture",
      initiative: { id: "initiative", url: "https://linear.test/i", revision: "r1" },
      projects: [
        {
          project: { id: "project", url: "https://linear.test/p", revision: "r1" },
          issues: [
            { id: "issue", key: "JUN-274", url: "https://linear.test/issue", revision: "r1" },
          ],
        },
      ],
      decisionRefs: [],
    };
    await Bun.write(join(root, "scope.json"), JSON.stringify(await mappedScope(root, scope)));
    const orchestrator = new Orchestrator(root, "/fake/herdr.sock", dependencies);
    const imported = await orchestrator.importScope(join(root, "scope.json"), true);
    if (!imported.ok) throw new Error(imported.error.message);
    const supervisor = await orchestrator.createSupervisor({
      initiativeId: "initiative",
      scopeDigest: imported.value.digest,
      designationId: "designation",
      execute: true,
      fixture: true,
    });
    if (!supervisor.ok) throw new Error(supervisor.error.message);
    const parent = await orchestrator.createParent({
      supervisorId: supervisor.value.binding.id,
      projectId: "project",
    });
    if (!parent.ok) throw new Error(parent.error.message);
    const runsBefore = events.filter((event) => event === "run").length;

    const created = await orchestrator.createChild({
      parentId: parent.value.binding.id,
      issueId: "issue",
      mode: "planned",
    });

    expect(created).toMatchObject({
      ok: false,
      error: { code: "storage_error", message: "stage write failed" },
    });
    expect(events.filter((event) => event === "run")).toHaveLength(runsBefore);
    const status = orchestrator.status();
    if (!status.ok) throw new Error(status.error.message);
    const live = status.value
      .filter((binding) => binding.launchState !== "closed")
      .map((binding) => binding.id)
      .sort();
    expect(live).toEqual([parent.value.binding.id, supervisor.value.binding.id].sort());
  });

  test.each([
    [undefined, "direct"],
    ["planned", "plan"],
  ] as const)(
    "a closed child (%s) can be recreated as a new direct generation",
    async (firstMode, firstStage) => {
      const root = await ownedRoot(`omo-orchestrator-recreate-${firstStage}-`);
      const events: string[] = [];
      const prompts = new Map<string, Set<string>>();
      const herdr = new FakeHerdr(events);
      let nextId = 0;
      const dependencies: OrchestratorDependencies = {
        openRegistry,
        createHerdrClient: () => herdr,
        resolveHerdrArtifact: async (controlRoot) => ({
          artifactDir: join(controlRoot, ".managed-herdr"),
        }),
        ensureHost: async () => {
          events.push("host");
        },
        gitTip: (cwd, ref) => fixtureTip(root, "commit", cwd, ref),
        now: () => "2026-09-26T00:00:00.000Z",
        uuid: () => `id-${++nextId}`,
        attachBinding: async (binding: Binding) => {
          const identity = herdr.nativeIdentities.get(binding.durableSessionId);
          if (identity === undefined) throw new Error("Exact native session is not open");
          let messages = prompts.get(binding.durableSessionId);
          if (messages === undefined) {
            messages = new Set();
            prompts.set(binding.durableSessionId, messages);
          }
          const session = new FakeNative(identity, events, messages);
          session.onConfigure = (current) =>
            herdr.nativeIdentities.set(binding.durableSessionId, current);
          return session;
        },
        terminateBinding: async (binding) => {
          events.push(`terminate:${binding.id}`);
          herdr.nativeIdentities.delete(binding.durableSessionId);
        },
        prompt: async (binding, brief) => {
          prompts.get(binding.durableSessionId)?.add(brief);
        },
      };
      const scope: ScopeSnapshot = {
        version: 1,
        source: "fixture",
        initiative: { id: "initiative", url: "https://linear.test/i", revision: "r1" },
        projects: [
          {
            project: { id: "project", url: "https://linear.test/p", revision: "r1" },
            issues: [
              { id: "issue", key: "JUN-274", url: "https://linear.test/issue", revision: "r1" },
            ],
          },
        ],
        decisionRefs: [],
      };
      await Bun.write(join(root, "scope.json"), JSON.stringify(await mappedScope(root, scope)));
      const orchestrator = new Orchestrator(root, "/fake/herdr.sock", dependencies);
      const imported = await orchestrator.importScope(join(root, "scope.json"), true);
      if (!imported.ok) throw new Error(imported.error.message);
      const supervisor = await orchestrator.createSupervisor({
        initiativeId: "initiative",
        scopeDigest: imported.value.digest,
        designationId: "designation",
        execute: true,
        fixture: true,
      });
      if (!supervisor.ok) throw new Error(supervisor.error.message);
      const parent = await orchestrator.createParent({
        supervisorId: supervisor.value.binding.id,
        projectId: "project",
      });
      if (!parent.ok) throw new Error(parent.error.message);
      const first = await orchestrator.createChild({
        parentId: parent.value.binding.id,
        issueId: "issue",
        ...(firstMode === undefined ? {} : { mode: firstMode }),
      });
      if (!first.ok) throw new Error(first.error.message);
      const duplicate = await orchestrator.createChild({
        parentId: parent.value.binding.id,
        issueId: "issue",
      });
      expect(duplicate).toMatchObject({ ok: false, error: { code: "ownership_conflict" } });
      expect(await orchestrator.close(first.value.binding.id)).toMatchObject({
        ok: true,
        value: { launchState: "closed" },
      });

      const second = await orchestrator.createChild({
        parentId: parent.value.binding.id,
        issueId: "issue",
      });

      expect(second.ok).toBe(true);
      if (!second.ok) throw new Error(second.error.message);
      expect(second.value.binding.id).not.toBe(first.value.binding.id);
      expect(second.value).toMatchObject({ stage: "direct", mode: "direct" });
      const registry = openRegistry(join(root, ".omo/state/registry.sqlite"));
      try {
        expect(registry.lineageFor(first.value.binding.id)).toMatchObject({
          ok: true,
          value: {
            mode: firstMode === "planned" ? "planned" : "direct",
            stages: [{ bindingId: first.value.binding.id, stage: firstStage, ordinal: 0 }],
          },
        });
        expect(registry.lineageFor(second.value.binding.id)).toMatchObject({
          ok: true,
          value: {
            mode: "direct",
            stages: [
              {
                bindingId: second.value.binding.id,
                stage: "direct",
                ordinal: 0,
                launchState: "ready",
              },
            ],
          },
        });
        const generations = new Database(join(root, ".omo/state/registry.sqlite"), {
          readonly: true,
        });
        try {
          const generation = generations.query<{ generation: number }, [string]>(
            "SELECT generation FROM stage_lineage WHERE binding_id = ?",
          );
          expect(generation.get(first.value.binding.id)?.generation).toBe(0);
          expect(generation.get(second.value.binding.id)?.generation).toBe(1);
        } finally {
          generations.close();
        }
      } finally {
        registry.close();
      }
    },
  );
});
