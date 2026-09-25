import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
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
import { modelForRole } from "../../src/core/policy";
import { openRegistry } from "../../src/core/store";
import type { HerdrClient, Snapshot, Workspace } from "../../src/herdr";
import { createHostProfile, RUNTIME_CACHE_MARKER } from "../../src/host-profile";
import {
  Orchestrator,
  type OrchestratorDependencies,
  readSessionPath,
} from "../../src/orchestrator";
import { publishReadiness } from "../../src/readiness";
import type { NativeSession } from "../../src/transport";

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
        "supervisor create",
        "parent create",
        "child create",
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
        session_runtime: "in-process",
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
        OMO_INITIATIVE_ROOT: root,
        OMO_RPC_SOCKET: join(root, ".omo/state/omo.sock"),
        [RUNTIME_CACHE_MARKER]: "1",
      },
    });
    await rm(root, { recursive: true, force: true });
  });
});

describe("Herdr readiness event", () => {
  test("accepts normalized panes and the actual Herdr event source shape", () => {
    expect(
      readSessionPath(
        {
          event: "pane_updated",
          data: {
            type: "pane_updated",
            pane: {
              pane_id: "pane-1",
              agent_session: {
                source: "herdr:pi",
                agent: "pi",
                kind: "path",
                value: "/s/session.jsonl",
              },
            },
          },
        },
        "pane-1",
      ),
    ).toBe("/s/session.jsonl");
    expect(
      readSessionPath({ paneId: "pane-1", sessionPath: "/s/normalized.jsonl" }, "pane-1"),
    ).toBe("/s/normalized.jsonl");
  });
  test("does not treat a durable session ID report as a session file path", () => {
    expect(
      readSessionPath(
        {
          event: "pane.updated",
          data: {
            pane: {
              pane_id: "pane-1",
              agent_session: { kind: "id", value: "session-id-not-a-path" },
            },
          },
        },
        "pane-1",
      ),
    ).toBeNull();
  });
});

class FakeHerdr implements HerdrClient {
  readonly events: string[];
  readonly emittedEvent: unknown;
  listener: ((event: unknown) => void) | undefined;
  verifyIdentity = false;
  holdSnapshot = false;
  snapshots = 0;
  cwd = "";
  root = "";
  readonly workspaces = new Map<string, Workspace>();
  readonly nativeIdentities = new Map<string, RuntimeIdentity>();
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
    this.cwd = cwd;
    this.root = cwd;
    const workspace = { workspaceId: "ws", rootPaneId: "pane", cwd, label: _label };
    this.workspaces.set(workspace.workspaceId, workspace);
    return workspace;
  }
  async createWorktree(checkout: Checkout, label: string): Promise<Workspace> {
    this.cwd = checkout.path;
    const id = `worktree-${++this.nextWorkspace}`;
    const workspace = { workspaceId: id, rootPaneId: `${id}:p1`, cwd: checkout.path, label };
    this.workspaces.set(id, workspace);
    return workspace;
  }
  async run(
    _pane: string,
    argv: readonly string[],
    env: Readonly<Record<string, string>>,
  ): Promise<void> {
    this.events.push("run");
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
        extensionProtocol: 1,
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
    return {
      focusedWorkspaceId: null,
      focusedTabId: null,
      focusedPaneId: null,
      workspaces: [...this.workspaces.values()],
      panes: [...this.workspaces.values()].map((workspace) => ({
        paneId: workspace.rootPaneId,
        workspaceId: workspace.workspaceId,
        revision: 1,
        sessionPath: null,
      })),
    };
  }
  async reportSession(): Promise<void> {}
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
        gitTip: async () => "commit",
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
      await Bun.write(scopeFile, JSON.stringify(scope));
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
          repo: root,
          base: "main",
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
            repo: root,
            base: "main",
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
          repo: root,
          base: "main",
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
      gitTip: async () => "commit",
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
    await Bun.write(scopeFile, JSON.stringify(scope));
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
        gitTip: async () => "commit",
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
      await Bun.write(scopeFile, JSON.stringify(scope));
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
});
