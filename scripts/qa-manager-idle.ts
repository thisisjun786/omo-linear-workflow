import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, watch } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RpcClient, SessionManager } from "@code-yeongyu/senpi";
import { z } from "zod";
import type { Binding, Designation, Envelope, Result, ScopeSnapshot } from "../src/core/contracts";
import { deliveryRecordSchema, resultSchema, runtimeIdentitySchema } from "../src/core/schema";
import { openRegistry } from "../src/core/store";
import type { HerdrClient } from "../src/herdr";
import {
  assertHostCapacity,
  HostCapacityError,
  runtimeCacheEnvironment,
} from "../src/host-profile";
import { Orchestrator } from "../src/orchestrator";
import { acquireLaunchSession } from "../src/transport";

const root = resolve(import.meta.dir, "..");
const runCapacity = process.argv.slice(2).includes("--capacity");
const runRace = process.argv.slice(2).includes("--capacity-race");
const runFallback = process.argv.slice(2).includes("--local-fallback");
const unknownArgs = process.argv
  .slice(2)
  .filter((arg) => arg !== "--capacity" && arg !== "--capacity-race" && arg !== "--local-fallback");
if (unknownArgs.length > 0) throw new Error(`Unknown arguments: ${unknownArgs.join(" ")}`);

const MODEL = "anthropic/claude-opus-5-5";
const WAIT_MS = 30_000;
const CAPACITY = 20;

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function receipt(type: string, evidence: unknown): void {
  console.log(JSON.stringify({ type, evidence }));
}

function waitForFile(directory: string, name: string, description: string): Promise<void> {
  const path = join(directory, name);
  const done = Promise.withResolvers<void>();
  const inspect = () => {
    if (existsSync(path)) done.resolve();
  };
  const watcher = watch(directory, inspect);
  const timer = setTimeout(
    () => done.reject(new Error(`${description} deadline exceeded`)),
    WAIT_MS,
  );
  inspect();
  return done.promise.finally(() => {
    clearTimeout(timer);
    watcher.close();
  });
}

function waitForDelivery(
  dbPath: string,
  messageId: string,
  state: "sending" | "accepted",
): Promise<void> {
  const directory = resolve(dbPath, "..");
  const done = Promise.withResolvers<void>();
  const inspect = () => {
    const registry = openRegistry(dbPath, { readonly: true });
    try {
      const delivery = registry.delivery(messageId);
      if (delivery.ok && delivery.value.state === state) done.resolve();
    } catch (cause) {
      done.reject(cause);
    } finally {
      registry.close();
    }
  };
  const watcher = watch(directory, inspect);
  const timer = setTimeout(
    () => done.reject(new Error(`Delivery ${messageId} did not reach ${state}`)),
    WAIT_MS,
  );
  inspect();
  return done.promise.finally(() => {
    clearTimeout(timer);
    watcher.close();
  });
}

function messageText(message: unknown): string {
  const parsed = z
    .object({
      role: z.string(),
      content: z.union([
        z.string(),
        z.array(z.object({ type: z.string(), text: z.string().optional() })),
      ]),
    })
    .safeParse(message);
  if (!parsed.success) return "";
  return typeof parsed.data.content === "string"
    ? parsed.data.content
    : parsed.data.content.map((part) => part.text ?? "").join("");
}

async function occurrence(client: RpcClient, messageId: string): Promise<number> {
  return (await client.getMessages()).filter((message) => messageText(message).includes(messageId))
    .length;
}

async function idleNowOrSettled(client: RpcClient): Promise<void> {
  const idle = Promise.withResolvers<void>();
  const stop = client.onEvent((event) => {
    if (event.type === "agent_settled") idle.resolve();
  });
  const timer = setTimeout(() => idle.reject(new Error("Idle observation deadline")), WAIT_MS);
  try {
    if (!(await client.getState()).isStreaming) idle.resolve();
    await idle.promise;
  } finally {
    clearTimeout(timer);
    stop();
  }
}

function envelope(parent: Binding, manager: Binding, digest: string, id: string): Envelope {
  return {
    version: 1,
    id,
    fromBindingId: parent.id,
    toBindingId: manager.id,
    designationId: parent.designationId,
    snapshotDigest: digest,
    kind: "report",
    text: `completed ${id}\nReproducible manager idle QA payload`,
    outcome: "completed",
    evidence: ["native worker-host transcript"],
  };
}

function seedRegistry(
  scratch: string,
  socket: string,
  managerPath: string,
  parentPath: string,
): { readonly manager: Binding; readonly parent: Binding; readonly digest: string } {
  const dbPath = join(scratch, ".omo/state/registry.sqlite");
  const registry = openRegistry(dbPath);
  try {
    const managerSnapshot: ScopeSnapshot = {
      version: 1,
      source: "linear-export",
      initiative: null,
      projects: [],
      decisionRefs: [],
    };
    const managerDigest = value(registry.importScope(managerSnapshot)).digest;
    const managerDesignation: Designation = {
      id: "qa-manager-designation",
      snapshotDigest: managerDigest,
      designatedBy: "LINA-307 real QA",
      designatedAt: new Date().toISOString(),
      execute: true,
      create: true,
      contact: true,
    };
    const reservedManager = value(
      registry.reserve({
        bindingId: "qa-manager",
        durableSessionId: "qa-manager-session",
        designation: managerDesignation,
        snapshot: managerSnapshot,
        assignment: { role: "manager" },
        cwd: scratch,
        checkout: null,
        herdrSocket: join(scratch, "unused-herdr.sock"),
        omoSocket: socket,
      }),
    );
    value(registry.provision(reservedManager.id, "qa-manager-workspace", "qa-manager-pane"));
    value(registry.observeSession(reservedManager.id, managerPath));
    value(
      registry.activate(reservedManager.id, {
        durableSessionId: reservedManager.durableSessionId,
        sessionPath: managerPath,
        cwd: scratch,
        provider: "opencodex",
        modelId: MODEL,
        thinking: "medium",
        extensionProtocol: 2,
      }),
    );
    value(registry.beginInitialization(reservedManager.id, "LINA-307 manager QA fixture"));
    const manager = value(registry.finishInitialization(reservedManager.id, "accepted"));

    const parentSnapshot: ScopeSnapshot = {
      version: 1,
      source: "fixture",
      initiative: null,
      projects: [
        {
          project: { id: "qa-project", url: "linear://qa-project", revision: "1" },
          issues: [],
        },
      ],
      decisionRefs: [],
    };
    const digest = value(registry.importScope(parentSnapshot)).digest;
    const parentDesignation: Designation = {
      id: "qa-parent-designation",
      snapshotDigest: digest,
      designatedBy: "LINA-307 real QA",
      designatedAt: new Date().toISOString(),
      execute: true,
      create: true,
      contact: true,
    };
    const reservedParent = value(
      registry.reserve({
        bindingId: "qa-parent",
        durableSessionId: "qa-parent-session",
        designation: parentDesignation,
        snapshot: parentSnapshot,
        assignment: {
          role: "parent",
          initiativeId: null,
          projectId: "qa-project",
          ownerBindingId: manager.id,
        },
        cwd: scratch,
        checkout: null,
        herdrSocket: join(scratch, "unused-herdr.sock"),
        omoSocket: socket,
      }),
    );
    value(registry.provision(reservedParent.id, "qa-parent-workspace", "qa-parent-pane"));
    value(registry.observeSession(reservedParent.id, parentPath));
    value(
      registry.activate(reservedParent.id, {
        durableSessionId: reservedParent.durableSessionId,
        sessionPath: parentPath,
        cwd: scratch,
        provider: "opencodex",
        modelId: MODEL,
        thinking: "medium",
        extensionProtocol: 2,
      }),
    );
    value(registry.beginInitialization(reservedParent.id, "LINA-307 parent QA fixture"));
    return {
      manager,
      parent: value(registry.finishInitialization(reservedParent.id, "accepted")),
      digest,
    };
  } finally {
    registry.close();
  }
}

async function writeSession(directory: string, cwd: string, id: string): Promise<string> {
  const manager = SessionManager.create(cwd, directory, { id });
  const path = manager.getSessionFile();
  assert.ok(path);
  manager.appendModelChange("opencodex", MODEL);
  manager.appendThinkingLevelChange("medium");
  await writeFile(
    path,
    `${[manager.getHeader(), ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    { flag: "wx", mode: 0o600 },
  );
  return path;
}

async function openRetained(
  socket: string,
  path: string,
  cwd: string,
): Promise<{ readonly client: RpcClient; readonly sessionId: string }> {
  const client = new RpcClient({ socketPath: socket });
  await client.start();
  try {
    const opened = await client.openSession({ sessionPath: path, cwd, retain_on_disconnect: true });
    return { client, sessionId: opened.sessionId };
  } catch (cause) {
    await client.stop();
    throw cause;
  }
}

async function main(): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), "olw-manager-idle-"));
  const state = join(scratch, ".omo/state");
  const sessions = join(state, "sessions");
  const gate = join(scratch, "gate");
  const home = join(scratch, "home");
  const agent = join(home, ".omo/agent");
  const socket = join(state, "omo.sock");
  const owned: Array<{ readonly client: RpcClient; readonly sessionId: string }> = [];
  let hostStarted = false;
  let host: ReturnType<typeof spawn> | undefined;
  let hostExited: Promise<unknown> | undefined;
  let failure: unknown;
  let cleanupFailure: unknown;
  try {
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    await mkdir(gate, { mode: 0o700 });
    await mkdir(join(agent, "extensions"), { recursive: true, mode: 0o700 });
    await symlink(join(root, "node_modules"), join(scratch, "node_modules"), "dir");
    await symlink(join(root, "dist"), join(scratch, "dist"), "dir");
    await writeFile(join(home, ".zshrc"), "# isolated LINA-307 QA home\n");
    await writeFile(
      join(agent, "extensions/qa-provider.ts"),
      `import offline from ${JSON.stringify(join(root, "scripts/qa-official-provider.ts"))};\nexport default (pi) => offline(pi, ${JSON.stringify(gate)});\n`,
      { mode: 0o600 },
    );
    await writeFile(
      join(agent, "models.json"),
      JSON.stringify({
        providers: {
          opencodex: {
            baseUrl: "http://offline.invalid",
            api: "openai-completions",
            apiKey: "qa-offline-not-a-secret",
            models: [
              {
                id: MODEL,
                name: MODEL,
                reasoning: true,
                input: ["text"],
                contextWindow: 1_000_000,
                maxTokens: 32_000,
              },
            ],
          },
        },
      }),
      { mode: 0o600 },
    );
    await writeFile(
      join(agent, "settings.json"),
      JSON.stringify({
        defaultProvider: "opencodex",
        defaultModel: MODEL,
        defaultThinkingLevel: "medium",
        permissionPreset: "full-access",
        quietStartup: true,
      }),
      { mode: 0o600 },
    );
    await writeFile(join(agent, "auth.json"), "{}\n", { mode: 0o600 });

    const managerPath = await writeSession(sessions, scratch, "qa-manager-session");
    const parentPath = await writeSession(sessions, scratch, "qa-parent-session");
    const fixture = seedRegistry(scratch, socket, managerPath, parentPath);
    const { PATH, USER } = process.env;
    const env = {
      PATH,
      USER,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local/share"),
      XDG_STATE_HOME: join(home, ".local/state"),
      OMO_CODING_AGENT_DIR: agent,
      SENPI_CODING_AGENT_DIR: agent,
      PI_CODING_AGENT_DIR: agent,
      OMO_CODING_AGENT_SESSION_DIR: sessions,
      PI_OFFLINE: "1",
      OMO_NATIVE: "1",
      OMO_INITIATIVE_HOST: "1",
      OMO_INITIATIVE_EXTENSION_PROTOCOL_2: "1",
      OMO_INITIATIVE_WORKER_ADMISSION_2: "1",
      OMO_INITIATIVE_ROOT: scratch,
      OMO_RPC_SOCKET: socket,
      ...runtimeCacheEnvironment(scratch),
    };
    host = spawn(
      process.execPath,
      [
        join(root, "node_modules/@code-yeongyu/senpi/dist/cli.js"),
        "--mode",
        "rpc",
        "--listen",
        socket,
        "--session-runtime",
        "worker",
        "--no-approve",
        "--no-context-files",
        "--no-recommended-models",
        "--no-model-fallback",
        "--omo-senpi-builtin-mcps-disabled",
        "--omo-senpi-memory-disabled",
        "-e",
        join(root, "node_modules/omo-ai/plugin"),
        "-e",
        join(root, "node_modules/omo-ai/plugin/extensions/omo-member.js"),
        "-e",
        join(root, "dist/extension/index.js"),
      ],
      { cwd: scratch, env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    hostExited = once(host, "exit");
    const ready = Promise.withResolvers<void>();
    let diagnostic = "";
    host.stdout?.resume();
    host.stderr?.on("data", (chunk: Buffer) => {
      diagnostic += chunk.toString();
      if (diagnostic.includes("senpi rpc listening on")) ready.resolve();
    });
    host.once("error", ready.reject);
    host.once("exit", () => ready.reject(new Error(`Host exited: ${diagnostic}`)));
    const deadline = setTimeout(
      () => ready.reject(new Error(`Host readiness: ${diagnostic}`)),
      WAIT_MS,
    );
    try {
      await ready.promise;
    } finally {
      clearTimeout(deadline);
    }
    hostStarted = true;
    receipt("host", { scratch, socket, runtime: "worker", pid: host.pid, pidIsolation: false });

    const managerOpen = await openRetained(socket, managerPath, scratch);
    owned.push(managerOpen);
    const parentOpen = await openRetained(socket, parentPath, scratch);
    owned.push(parentOpen);
    let managerClient = managerOpen.client;
    const parentClient = parentOpen.client;
    await Promise.all([idleNowOrSettled(managerClient), idleNowOrSettled(parentClient)]);
    const [managerIdentityRaw, parentIdentityRaw] = await Promise.all([
      managerClient.requestExtension("omo.initiative.describe"),
      parentClient.requestExtension("omo.initiative.describe"),
    ]);
    const managerIdentity = value(resultSchema(runtimeIdentitySchema).parse(managerIdentityRaw));
    const parentIdentity = value(resultSchema(runtimeIdentitySchema).parse(parentIdentityRaw));
    assert.deepEqual(
      [managerIdentity.durableSessionId, managerIdentity.sessionPath, managerIdentity.cwd],
      [fixture.manager.durableSessionId, fixture.manager.sessionPath, fixture.manager.cwd],
    );
    assert.deepEqual(
      [parentIdentity.durableSessionId, parentIdentity.sessionPath, parentIdentity.cwd],
      [fixture.parent.durableSessionId, fixture.parent.sessionPath, fixture.parent.cwd],
    );
    receipt("describe", { manager: managerIdentity, parent: parentIdentity });

    const idleMessage = envelope(fixture.parent, fixture.manager, fixture.digest, "qa-idle-report");
    const idleAccepted = value(
      resultSchema(deliveryRecordSchema).parse(
        await parentClient.requestExtension("omo.initiative.send", idleMessage),
      ),
    );
    assert.equal(idleAccepted.state, "accepted");
    const idleReplay = value(
      resultSchema(deliveryRecordSchema).parse(
        await parentClient.requestExtension("omo.initiative.send", idleMessage),
      ),
    );
    assert.deepEqual(idleReplay, idleAccepted);
    await idleNowOrSettled(managerClient);
    assert.equal(await occurrence(managerClient, idleMessage.id), 1);
    receipt("idle-send", { delivery: idleAccepted, transcriptOccurrences: 1 });

    await rm(join(gate, "entered"), { force: true });
    await rm(join(gate, "release"), { force: true });
    const entered = waitForFile(gate, "entered", "Provider busy gate");
    await managerClient.prompt("OLW_ENTRY_BUSY_GATE");
    await entered;
    assert.equal((await managerClient.getState()).isStreaming, true);
    const busyMessage = envelope(fixture.parent, fixture.manager, fixture.digest, "qa-busy-report");
    const sending = waitForDelivery(join(state, "registry.sqlite"), busyMessage.id, "sending");
    const busyResult = parentClient.requestExtension("omo.initiative.send", busyMessage);
    await sending;
    assert.equal((await managerClient.getState()).isStreaming, true);
    assert.equal(await occurrence(managerClient, busyMessage.id), 0);
    await writeFile(join(gate, "release"), "release\n", { flag: "wx", mode: 0o600 });
    const busyAccepted = value(resultSchema(deliveryRecordSchema).parse(await busyResult));
    assert.equal(busyAccepted.state, "accepted");
    await idleNowOrSettled(managerClient);
    assert.equal(await occurrence(managerClient, busyMessage.id), 1);
    const busyReplay = value(
      resultSchema(deliveryRecordSchema).parse(
        await parentClient.requestExtension("omo.initiative.send", busyMessage),
      ),
    );
    assert.deepEqual(busyReplay, busyAccepted);
    assert.equal(await occurrence(managerClient, busyMessage.id), 1);
    receipt("busy-send", {
      waitedWhileStreaming: true,
      absentBeforeRelease: true,
      delivery: busyAccepted,
      transcriptOccurrences: 1,
    });

    // A proven pre-request failure must settle the claim, then allow a same-ID
    // successor attempt when the exact manager becomes available again.
    await managerClient.closeSession(managerOpen.sessionId);
    await managerClient.stop();
    owned.splice(owned.indexOf(managerOpen), 1);
    const retryMessage = envelope(
      fixture.parent,
      fixture.manager,
      fixture.digest,
      "qa-admission-retry",
    );
    const rejected = value(
      resultSchema(deliveryRecordSchema).parse(
        await parentClient.requestExtension("omo.initiative.send", retryMessage),
      ),
    );
    assert.equal(rejected.state, "rejected");
    const reopened = await openRetained(socket, managerPath, scratch);
    owned.push(reopened);
    managerClient = reopened.client;
    const retried = value(
      resultSchema(deliveryRecordSchema).parse(
        await parentClient.requestExtension("omo.initiative.send", retryMessage),
      ),
    );
    assert.equal(retried.state, "accepted");
    assert.equal(retried.attempts?.length, 2);
    assert.equal(await occurrence(managerClient, retryMessage.id), 1);
    assert.deepEqual(await parentClient.requestExtension("omo.initiative.send", retryMessage), {
      ok: true,
      value: retried,
    });
    assert.equal(await occurrence(managerClient, retryMessage.id), 1);
    receipt("admission-retry", {
      first: rejected.state,
      retry: retried.state,
      attempts: retried.attempts?.length,
      transcriptOccurrences: 1,
    });

    if (runFallback) {
      let listener: ((event: unknown) => void) | undefined;
      let stopped = false;
      let removed = false;
      let tui: ReturnType<typeof Bun.spawn> | undefined;
      let observer: Awaited<ReturnType<typeof openRetained>> | undefined;
      const unexpected = async (): Promise<never> => {
        throw new Error("Unexpected fallback QA operation");
      };
      const herdr: HerdrClient = {
        createWorkspace: async (cwd) => ({
          workspaceId: "fallback-ws",
          rootPaneId: "fallback-pane",
          cwd,
        }),
        subscribe: async (cb) => {
          listener = cb;
          return () => {};
        },
        close() {},
        run: async (_pane, argv) => {
          const path = argv[argv.indexOf("--session") + 1];
          assert.ok(path);
          observer = await openRetained(socket, path, scratch);
          const row = (await observer.client.listSessions()).find(
            (row) => row.sessionPath === path,
          );
          assert.equal(row?.attachments, 2);
          const registry = openRegistry(join(state, "registry.sqlite"));
          try {
            const binding = value(registry.bySession(SessionManager.open(path).getSessionId()));
            const nonce = argv
              .find((arg) => arg.startsWith("OMO_INITIATIVE_LAUNCH_NONCE="))
              ?.split("=")[1];
            assert.ok(nonce);
            tui = Bun.spawn(
              [
                process.execPath,
                join(root, "scripts/qa-tui-fallback.ts"),
                scratch,
                binding.id,
                binding.durableSessionId,
                path,
                "fallback-pane",
                nonce,
              ],
              { stdin: "pipe", stdout: "inherit", stderr: "inherit" },
            );
            receipt("observer-plus-hold", {
              attachments: row?.attachments,
              observerPid: process.pid,
              tuiPid: tui.pid,
            });
          } finally {
            registry.close();
          }
        },
        sendKeys: async (pane) => {
          assert.equal(pane, "fallback-pane");
          tui?.kill();
          await tui?.exited;
          stopped = true;
          listener?.({ event: "pane.exited", data: { pane_id: pane } });
        },
        closeWorkspace: async (id) => {
          assert.equal(id, "fallback-ws");
          assert.equal(stopped, true);
          removed = true;
        },
        createWorktree: unexpected,
        createTab: unexpected,
        renameTab: unexpected,
        closeTab: unexpected,
        focusWorkspace: unexpected,
        focusPane: unexpected,
        paneContainsProcess: async (_pane, pid) => tui?.pid === pid && tui.exitCode === null,
        paneForegroundProcesses: async () =>
          tui?.exitCode === null ? [{ pid: tui.pid, name: "bun" }] : [],
        snapshot: unexpected,
        removeWorktree: unexpected,
      };
      const registry = openRegistry(join(state, "registry.sqlite"));
      let digest: string;
      try {
        digest = value(
          registry.importScope({
            version: 1,
            source: "fixture",
            initiative: { id: "fallback", url: "linear://fallback", revision: "1" },
            projects: [],
            decisionRefs: [],
          }),
        ).digest;
      } finally {
        registry.close();
      }
      const orchestrator = new Orchestrator(scratch, join(scratch, "unused-herdr.sock"), {
        openRegistry,
        createHerdrClient: () => herdr,
        resolveHerdrArtifact: async () => ({ artifactDir: scratch }),
        ensureHost: async () => {},
        checkHostProfile: async () => {},
        acquireLaunchSession,
        attachBinding: unexpected,
        terminateBinding: unexpected,
        prompt: unexpected,
        gitTip: unexpected,
        now: () => new Date().toISOString(),
        uuid: () => crypto.randomUUID(),
      });
      let result: Awaited<ReturnType<Orchestrator["createSupervisor"]>>;
      try {
        result = await orchestrator.createSupervisor({
          initiativeId: "fallback",
          scopeDigest: digest,
          designationId: "fallback-designation",
          execute: true,
          fixture: true,
        });
      } finally {
        tui?.kill();
        await tui?.exited;
        if (observer !== undefined) {
          await observer.client.closeSession(observer.sessionId);
          await observer.client.stop();
        }
      }
      assert.deepEqual(result.ok, false);
      if (result.ok) throw new Error("Local fallback activated");
      assert.equal(result.error.code, "runtime_unavailable");
      assert.deepEqual(result.error.details, { reason: "tui_local_fallback" });
      assert.equal(stopped, true);
      assert.equal(removed, true);
      const binding = value(orchestrator.status({ initiativeId: "fallback" }))[0];
      assert.equal(binding?.launchState, "closed");
      const cleanupObserver = new RpcClient({ socketPath: socket });
      await cleanupObserver.start();
      try {
        assert.equal(
          (await cleanupObserver.listSessions()).some(
            (row) => row.sessionPath === binding?.sessionPath,
          ),
          false,
        );
      } finally {
        await cleanupObserver.stop();
      }
      receipt("local-fallback-cleaned", { result, stopped, removed, binding });
    }

    if (runCapacity || runRace) {
      for (let index = owned.length; index < (runRace ? CAPACITY - 1 : CAPACITY); index++) {
        const path = await writeSession(sessions, scratch, `qa-capacity-${index}`);
        owned.push(await openRetained(socket, path, scratch));
      }
      if (runRace) {
        let launches = 0;
        let removedWorkspace = false;
        const unexpected = async (): Promise<never> => {
          throw new Error("Unexpected QA control-plane operation");
        };
        // Only the workspace boundary is a fixture. Capacity observation and
        // slot acquisition use the real disposable native host.
        const herdr: HerdrClient = {
          createWorkspace: async (cwd) => ({
            workspaceId: "race-workspace",
            rootPaneId: "race-pane",
            cwd,
          }),
          closeWorkspace: async (id) => {
            assert.equal(id, "race-workspace");
            removedWorkspace = true;
          },
          run: async () => {
            launches++;
            throw new Error("Refused admission must not launch a local TUI");
          },
          subscribe: async () => () => {},
          close() {},
          createWorktree: unexpected,
          createTab: unexpected,
          renameTab: unexpected,
          closeTab: unexpected,
          focusWorkspace: unexpected,
          focusPane: unexpected,
          paneContainsProcess: unexpected,
          paneForegroundProcesses: unexpected,
          sendKeys: unexpected,
          snapshot: unexpected,
          removeWorktree: unexpected,
        };
        const scope: ScopeSnapshot = {
          version: 1,
          source: "fixture",
          initiative: { id: "race-initiative", url: "linear://race", revision: "1" },
          projects: [],
          decisionRefs: [],
        };
        const registry = openRegistry(join(state, "registry.sqlite"));
        let digest: string;
        try {
          digest = value(registry.importScope(scope)).digest;
        } finally {
          registry.close();
        }
        const orchestrator = new Orchestrator(scratch, join(scratch, "unused-herdr.sock"), {
          openRegistry,
          createHerdrClient: () => herdr,
          resolveHerdrArtifact: async () => ({ artifactDir: scratch }),
          ensureHost: async () => {},
          checkHostProfile: async () => {},
          assertHostCapacity: async (path, sessionPath) => {
            await assertHostCapacity(path, sessionPath);
            receipt("race-precheck", { openSessions: owned.length, passed: true });
            const competing = await writeSession(sessions, scratch, "race-last-slot");
            owned.push(await openRetained(socket, competing, scratch));
          },
          acquireLaunchSession,
          attachBinding: unexpected,
          terminateBinding: unexpected,
          prompt: unexpected,
          gitTip: unexpected,
          now: () => new Date().toISOString(),
          uuid: () => crypto.randomUUID(),
        });
        const result = await orchestrator.createSupervisor({
          initiativeId: "race-initiative",
          scopeDigest: digest,
          designationId: "race-designation",
          execute: true,
          fixture: true,
        });
        assert.equal(result.ok, false);
        if (result.ok) throw new Error("Race unexpectedly launched");
        assert.equal(result.error.code, "host_session_capacity");
        assert.deepEqual(result.error.details, {
          count: 20,
          limit: 20,
          action: "close_an_existing_role",
        });
        assert.equal(launches, 0);
        assert.equal(removedWorkspace, true);
        const binding = value(orchestrator.status({ initiativeId: "race-initiative" }))[0];
        assert.equal(binding?.launchState, "closed");
        assert.equal(binding?.initialization.state, "pending");
        receipt("race-launch", { result, tuiLaunches: launches, removedWorkspace, binding });
      }
      const overflowPath = await writeSession(sessions, scratch, "qa-capacity-overflow");
      const capacity = await assertHostCapacity(socket, overflowPath).then(
        () => null,
        (cause: unknown) => cause,
      );
      assert.ok(capacity instanceof HostCapacityError);
      assert.equal(capacity.code, "host_session_capacity");
      const overflow = new RpcClient({ socketPath: socket });
      await overflow.start();
      let refused: unknown;
      try {
        await overflow.openSession({
          sessionPath: overflowPath,
          cwd: scratch,
          retain_on_disconnect: true,
        });
        assert.fail("Worker host admitted session 21");
      } catch (cause) {
        assert.ok(cause instanceof Error);
        assert.equal(cause.name, "RpcCommandError");
        assert.equal(cause.message, "open_failed: too_many_sessions");
        refused = {
          native: cause.message,
          code: capacity.code,
          count: capacity.count,
          limit: capacity.limit,
          action: capacity.action,
        };
      } finally {
        await overflow.stop();
      }
      const attachment = new RpcClient({ socketPath: socket });
      await attachment.start();
      const attached = await attachment.openSession({
        sessionPath: managerPath,
        cwd: scratch,
        retain_on_disconnect: true,
      });
      assert.equal(attached.attached, true);
      await attachment.closeSession(attached.sessionId);
      await attachment.stop();
      receipt("capacity", {
        runtime: "worker",
        openSessions: CAPACITY,
        refusal: refused,
        attachAtCap: { sessionId: attached.sessionId, attached: attached.attached },
      });
      if (runRace) {
        const competing = owned.pop();
        assert.ok(competing);
        await competing.client.closeSession(competing.sessionId);
        await competing.client.stop();
        const heldPath = await writeSession(sessions, scratch, "qa-held-launch");
        const heldBinding = {
          ...fixture.manager,
          durableSessionId: "qa-held-launch",
          sessionPath: heldPath,
        };
        const held = await acquireLaunchSession(heldBinding);
        const tui = new RpcClient({ socketPath: socket });
        try {
          await tui.start();
          const attached = await tui.openSession({ sessionPath: heldPath, cwd: scratch });
          assert.equal(attached.attached, true);
          // This branch owns the exact RpcClient it just attached. The separate
          // local-fallback scenario above exercises process-attributed proof.
          await held.confirmTuiAttachment(
            undefined,
            async () => (await tui.getState()).sessionId === "qa-held-launch",
          );
          await held.release();
          assert.equal((await tui.getState()).sessionId, "qa-held-launch");
          owned.push({ client: tui, sessionId: attached.sessionId });
          receipt("held-launch", { attachedAtCapacity: true, aliveAfterAdmissionRelease: true });
        } catch (cause) {
          await tui.stop();
          throw cause;
        }
      }
    } else {
      receipt("capacity", {
        skipped: true,
        invocation: "bun scripts/qa-manager-idle.ts --capacity",
      });
    }
    receipt("result", {
      status: "PASS",
      capacity: runCapacity || runRace ? "verified" : "skipped",
      race: runRace ? "verified" : "skipped",
    });
  } catch (cause) {
    failure = cause;
    receipt("result", { status: "FAIL", error: cause instanceof Error ? cause.stack : cause });
  } finally {
    const cleanupErrors: unknown[] = [];
    try {
      if (existsSync(join(gate, "entered")) && !existsSync(join(gate, "release")))
        await writeFile(join(gate, "release"), "cleanup release\n", { mode: 0o600 });
    } catch (cause) {
      cleanupErrors.push(cause);
    }
    for (const session of owned.toReversed()) {
      try {
        await session.client.closeSession(session.sessionId);
      } catch (cause) {
        cleanupErrors.push(cause);
      }
      try {
        await session.client.stop();
      } catch (cause) {
        cleanupErrors.push(cause);
      }
    }
    if (host?.pid !== undefined) {
      try {
        if (host.exitCode === null && host.signalCode === null) process.kill(-host.pid, "SIGTERM");
        const pid = host.pid;
        const timer = setTimeout(() => {
          if (host?.exitCode === null && host.signalCode === null) process.kill(-pid, "SIGKILL");
        }, 5000);
        try {
          await hostExited;
        } finally {
          clearTimeout(timer);
        }
      } catch (cause) {
        cleanupErrors.push(cause);
      }
    }
    if (cleanupErrors.length === 0) {
      await rm(scratch, { recursive: true, force: true });
      receipt("cleanup", {
        sessionsClosed: owned.length,
        hostStopped: hostStarted,
        socketRemoved: !existsSync(socket),
        rootRemoved: !existsSync(scratch),
      });
    } else {
      cleanupFailure = new AggregateError(cleanupErrors, "Owned QA cleanup failed");
      receipt("cleanup", {
        status: "FAIL",
        rootRetained: scratch,
        errors: cleanupErrors.map((cause) => (cause instanceof Error ? cause.stack : cause)),
      });
    }
  }
  if (failure !== undefined && cleanupFailure !== undefined)
    throw new AggregateError([failure, cleanupFailure], "QA and cleanup failed");
  if (failure !== undefined) throw failure;
  if (cleanupFailure !== undefined) throw cleanupFailure;
}

await main();
