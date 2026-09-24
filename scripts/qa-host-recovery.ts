import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RpcClient, SessionManager } from "@code-yeongyu/senpi";
import { z } from "zod";
import { modelForRole } from "../src/core/policy";
import { bindingSchema } from "../src/core/schema";
import { createHerdrClient } from "../src/herdr";
import { readHostStatus, runtimeCacheEnvironment } from "../src/host-profile";
import { attach, idle } from "./qa-hierarchy";
import { QaError } from "./qa-rpc";
import { checkedQaCommand, prepareQaWorld } from "./qa-world";

const success = z.object({ ok: z.literal(true), value: z.unknown() });
const refusal = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.literal("runtime_unavailable"),
    details: z.object({
      reason: z.literal("host_profile_mismatch"),
      missingExtensions: z.array(z.string()),
      recovery: z.object({
        automatic: z.literal(false),
        argv: z.array(z.string()),
        env: z.record(z.string(), z.string()),
      }),
    }),
  }),
});
const created = z.object({
  binding: bindingSchema.refine(
    (b) => b.launchState === "ready" && b.initialization.state === "accepted",
  ),
  readiness: z.literal("ready"),
  execution: z.literal("brief_accepted"),
});
const models = [modelForRole("supervisor").modelId, modelForRole("parent").modelId];
const evidenceDir = join(import.meta.dir, "../.omo/evidence/real-use-repairs/host-recovery");

async function main() {
  const qa = await prepareQaWorld();
  const agentDir = join(qa.scratch, "legacy-agent");
  await mkdir(agentDir);
  Object.assign(qa.environment, {
    OMO_CODING_AGENT_DIR: agentDir,
    SENPI_CODING_AGENT_DIR: agentDir,
    PI_CODING_AGENT_DIR: agentDir,
  });
  let production: Awaited<ReturnType<typeof prepareQaWorld>> | undefined;
  const log: {
    qaRoot: string;
    result: string;
    refusal?: unknown;
    legacy?: unknown;
    handoff?: unknown;
    qaParent?: unknown;
    productionRoot?: string;
    productionTurn?: unknown;
    error?: string;
    fixtureCleanupError?: string;
    cleanupError?: string;
  } = { qaRoot: qa.scratch, result: "incomplete" };
  const socket = join(qa.controlRoot, ".omo/state/omo.sock");
  const native = new RpcClient({ socketPath: socket });
  let fixtureSession: { id: string; path: string; durable: string } | undefined;
  let fixtureConnected = false;
  let qaClosed = false;
  let failure: unknown;
  const invoke = async (world: Awaited<ReturnType<typeof prepareQaWorld>>, args: string[]) => {
    const response = await world.cli(args);
    if (response.code !== 0)
      throw new QaError(`CLI ${args.join(" ")}: ${JSON.stringify(response)}`);
    return success.parse(JSON.parse(response.stdout)).value;
  };
  const importScope = async (world: Awaited<ReturnType<typeof prepareQaWorld>>) => {
    const path = join(world.scratch, "scope.json");
    await writeFile(path, await readFile(join(world.installRoot, "tests/fixtures/scope.json")));
    return z
      .object({ digest: z.string() })
      .parse(await invoke(world, ["scope", "import", "--file", path, "--fixture"])).digest;
  };
  try {
    const profilePath = join(qa.controlRoot, "omo-host.json");
    // Build the old profile from the real launch spec: only the OLW extension is absent.
    const full = {
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
        OMO_INITIATIVE_ROOT: qa.controlRoot,
        OMO_RPC_SOCKET: socket,
      },
    };
    const legacy = join(qa.controlRoot, "legacy-host.json");
    await writeFile(
      legacy,
      JSON.stringify({
        ...full,
        core: { ...full.core, extensions: full.core.extensions.slice(0, -1) },
      }),
      { mode: 0o600 },
    );
    const host = join(qa.controlRoot, "node_modules/.bin/omo");
    const hostEnv = { ...qa.environment, ...runtimeCacheEnvironment(qa.controlRoot) };
    await checkedQaCommand(
      [host, "host", "ensure", "--launch-spec", legacy, "--socket", socket, "--policy", "never"],
      qa.controlRoot,
      hostEnv,
    );
    const before = await readHostStatus(qa.controlRoot, socket, hostEnv);
    assert.equal(before.reachable, true);
    assert.equal(before.sessions.worker, 0);
    assert.ok(
      !before.launchProfile?.core.extensions.some((path) =>
        path.endsWith("/dist/extension/index.js"),
      ),
    );
    // Native durable fixture is owned by this script, not by the OLW registry.
    const manager = SessionManager.create(
      qa.controlRoot,
      join(qa.controlRoot, ".omo/state/sessions"),
      {
        id: crypto.randomUUID(),
      },
    );
    const path = manager.getSessionFile();
    assert.ok(path);
    await mkdir(join(qa.controlRoot, ".omo/state/sessions"), { recursive: true });
    await writeFile(path, `${JSON.stringify(manager.getHeader())}\n`, { flag: "wx", mode: 0o600 });
    await native.start();
    fixtureConnected = true;
    assert.deepEqual(await native.listSessions(), []);
    const opened = await native.openSession({
      sessionPath: path,
      cwd: qa.controlRoot,
      retain_on_disconnect: true,
    });
    assert.notEqual(opened.attached, true);
    const fixtureIdentity = (await native.listSessions()).find(
      (session) => session.sessionPath === path,
    );
    assert.ok(fixtureIdentity?.durableSessionId);
    fixtureSession = { id: opened.sessionId, path, durable: fixtureIdentity.durableSessionId };
    const anchor = createHerdrClient(qa.herdrSocket);
    let focus: string | null;
    let workspaceCount: number;
    try {
      const ws = await anchor.createWorkspace(qa.repository, "host recovery focus fixture");
      qa.workspaces.push(ws.workspaceId);
      const snapshot = await anchor.snapshot();
      focus = snapshot.focusedWorkspaceId;
      workspaceCount = snapshot.workspaces.length;
    } finally {
      anchor.close();
    }
    const digest = await importScope(qa);
    const createArgs = [
      "supervisor",
      "create",
      "--initiative",
      "initiative-omo-1",
      "--scope-digest",
      digest,
      "--designation",
      "host-recovery",
      "--execute",
      "--fixture",
    ];
    const rejected = await qa.cli(createArgs);
    assert.equal(rejected.code, 3);
    const mismatch = refusal.parse(JSON.parse(rejected.stdout));
    assert.ok(
      mismatch.error.details.missingExtensions.some((p) => p.endsWith("/dist/extension/index.js")),
    );
    assert.deepEqual(mismatch.error.details.recovery.argv, [
      host,
      "host",
      "handoff",
      "--launch-spec",
      profilePath,
      "--socket",
      socket,
    ]);
    const preStatus = z
      .array(bindingSchema)
      .parse(await invoke(qa, ["status", "--initiative", "initiative-omo-1"]));
    assert.equal(preStatus.filter((b) => b.launchState !== "closed").length, 0);
    const preNative = await native.listSessions();
    assert.equal(preNative.length, 1);
    assert.equal(preNative[0]?.sessionId, fixtureSession.id);
    const preSnapshotClient = createHerdrClient(qa.herdrSocket);
    try {
      const snapshot = await preSnapshotClient.snapshot();
      assert.equal(snapshot.focusedWorkspaceId, focus);
      assert.equal(snapshot.workspaces.length, workspaceCount);
    } finally {
      preSnapshotClient.close();
    }
    log.refusal = mismatch.error;
    log.legacy = before;
    // The refusal advertises the exact official handoff, and nothing happens automatically.
    await native.stop();
    fixtureConnected = false;
    await checkedQaCommand(mismatch.error.details.recovery.argv, qa.controlRoot, {
      ...qa.environment,
      ...mismatch.error.details.recovery.env,
    });
    const after = await readHostStatus(qa.controlRoot, socket, hostEnv);
    assert.ok(
      after.generation !== null &&
        before.generation !== null &&
        after.generation > before.generation,
    );
    assert.ok(
      after.launchProfile?.core.extensions.some((p) => p.endsWith("/dist/extension/index.js")),
    );
    await native.start();
    fixtureConnected = true;
    const reopened = await native.openSession({
      sessionPath: fixtureSession.path,
      cwd: qa.controlRoot,
      retain_on_disconnect: true,
    });
    const retained = (await native.listSessions()).find((s) => s.sessionId === reopened.sessionId);
    assert.ok(retained);
    assert.equal(reopened.state.sessionId, fixtureSession.durable);
    assert.equal(retained.sessionPath, fixtureSession.path);
    assert.equal(retained.durableSessionId, fixtureSession.durable);
    fixtureSession.id = reopened.sessionId;
    assert.ok(retained.status === "open");
    const afterHandoffHerdr = createHerdrClient(qa.herdrSocket);
    try {
      const snapshot = await afterHandoffHerdr.snapshot();
      assert.equal(snapshot.focusedWorkspaceId, focus);
      assert.equal(snapshot.workspaces.length, workspaceCount);
    } finally {
      afterHandoffHerdr.close();
    }
    const recoveredModels = await native.getAvailableModels();
    for (const model of models)
      assert.ok(recoveredModels.some((m) => m.provider === "opencodex" && m.id === model));
    const supervisor = created.parse(await invoke(qa, createArgs)).binding;
    const supervisorRpc = await attach(supervisor);
    try {
      const state = await supervisorRpc.getState();
      const expected = modelForRole("supervisor");
      assert.equal(state.model?.provider, expected.provider);
      assert.equal(state.model?.id, expected.modelId);
      assert.equal(state.thinkingLevel, expected.thinking);
      await idle(supervisorRpc);
      const initialMessages = await supervisorRpc.getMessages();
      const countBrief = (messages: typeof initialMessages) =>
        messages.filter((message) => {
          if (message.role !== "user") return false;
          const content =
            typeof message.content === "string"
              ? message.content
              : message.content
                  .filter((part) => part.type === "text")
                  .map((part) => part.text)
                  .join("");
          return content === supervisor.initialization.text;
        }).length;
      assert.equal(countBrief(initialMessages), 1);
      const reconciled = z
        .object({ bindings: z.array(bindingSchema) })
        .parse(await invoke(qa, ["reconcile", "--initiative", "initiative-omo-1"]));
      assert.equal(reconciled.bindings.find((b) => b.id === supervisor.id)?.launchState, "ready");
      assert.equal(countBrief(await supervisorRpc.getMessages()), 1);
    } finally {
      await supervisorRpc.stop();
    }
    const status = z
      .array(bindingSchema)
      .parse(await invoke(qa, ["status", "--initiative", "initiative-omo-1"]));
    assert.deepEqual(
      status.filter((b) => b.launchState === "ready").map((b) => b.id),
      [supervisor.id],
    );
    assert.equal(status.filter((b) => b.initialization.state === "accepted").length, 1);
    log.handoff = {
      beforeGeneration: before.generation,
      afterGeneration: after.generation,
      retainedSession: retained,
      supervisor,
    };
    // Prime QA's real native Anthropic tool path before removing its entire owned root.
    const parent = created.parse(
      await invoke(qa, [
        "parent",
        "create",
        "--supervisor",
        supervisor.id,
        "--project",
        "project-omo-1",
        "--repo",
        qa.repository,
        "--base",
        "main",
      ]),
    ).binding;
    const parentRpc = await attach(parent);
    try {
      await idle(parentRpc);
      await toolTurn(parentRpc, qa.repository);
    } finally {
      await parentRpc.stop();
    }
    log.qaParent = {
      id: parent.id,
      sessionPath: parent.sessionPath,
      model: modelForRole("parent").modelId,
    };
    // Explicitly close the extra owned native session; qa.close only owns registry bindings.
    await native.closeSession(fixtureSession.id);
    fixtureSession = undefined;
    await native.stop();
    fixtureConnected = false;
    await qa.close();
    qaClosed = true;
    assert.equal(await Bun.file(join(qa.controlRoot, "dist/extension/index.js")).exists(), false);
    production = await prepareQaWorld();
    log.productionRoot = production.scratch;
    assert.notEqual(production.controlRoot, qa.controlRoot);
    const prodDigest = await importScope(production);
    const prodSupervisor = created.parse(
      await invoke(production, [
        "supervisor",
        "create",
        "--initiative",
        "initiative-omo-1",
        "--scope-digest",
        prodDigest,
        "--designation",
        "production-like",
        "--execute",
        "--fixture",
      ]),
    ).binding;
    const prodParent = created.parse(
      await invoke(production, [
        "parent",
        "create",
        "--supervisor",
        prodSupervisor.id,
        "--project",
        "project-omo-1",
        "--repo",
        production.repository,
        "--base",
        "main",
      ]),
    ).binding;
    const prodRpc = await attach(prodParent);
    try {
      await idle(prodRpc);
      const beforeReload = await prodRpc.getState();
      const firstTurn = await toolTurn(prodRpc, production.repository);
      await idle(prodRpc);
      const reload = await prodRpc.reload();
      assert.notEqual(reload.cancelled, true);
      const result = await toolTurn(prodRpc, production.repository);
      const afterReload = await prodRpc.getState();
      assert.equal(afterReload.sessionId, beforeReload.sessionId);
      assert.equal(afterReload.sessionFile, beforeReload.sessionFile);
      assert.ok(!result.errorMessages.some((text) => text.includes(qa.controlRoot)));
      assert.ok(!result.errorMessages.some((text) => text.includes("extension-runtime-module")));
      log.productionTurn = {
        parent: prodParent.id,
        sessionPath: prodParent.sessionPath,
        firstTurn,
        beforeReload,
        afterReload,
        ...result,
      };
    } finally {
      await prodRpc.stop();
    }
    log.result = "pass";
  } catch (error) {
    failure = error;
    log.error = String(error);
  } finally {
    if (fixtureConnected) {
      try {
        if (fixtureSession) await native.closeSession(fixtureSession.id);
        await native.stop();
      } catch (error) {
        failure ??= error;
        log.fixtureCleanupError = String(error);
      }
    }
    for (const world of [production, qaClosed ? undefined : qa]) {
      if (!world) continue;
      try {
        await world.close();
      } catch (error) {
        failure ??= error;
        log.cleanupError = String(error);
      }
    }
    if (failure) log.result = "failed";
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(join(evidenceDir, "result.json"), `${JSON.stringify(log, null, 2)}\n`);
  }
  if (failure) throw failure;
}

// Native transcript, not a prose reply, establishes real Anthropic multi-tool execution.
async function toolTurn(client: RpcClient, cwd: string) {
  const priorCount = (await client.getMessages()).length;
  const ended = Promise.withResolvers<void>();
  const timer = setTimeout(
    () => ended.reject(new QaError("Native tool turn did not end")),
    120_000,
  );
  const detach = client.onEvent((event) => {
    if (event.type === "agent_end") ended.resolve();
  });
  try {
    await client.prompt(
      `Use the native read tool for ${join(cwd, "README.md")}. Then use eval in JavaScript to call tool.bash({command: "pwd"}) and print its result. Do not substitute Bun.$ or another shell runner. Report the results without editing files.`,
    );
    await ended.promise;
  } finally {
    clearTimeout(timer);
    detach();
  }
  const messages = (await client.getMessages()).slice(priorCount);
  const assistant = messages.filter((m) => m.role === "assistant");
  const toolCalls = assistant.flatMap((m) => m.content.filter((part) => part.type === "toolCall"));
  const errorMessages = assistant
    .filter((m) => m.stopReason === "error")
    .map((m) => m.errorMessage ?? "");
  assert.equal(errorMessages.length, 0, JSON.stringify(errorMessages));
  const nestedCalls = messages.flatMap((message) => {
    if (message.role !== "toolResult") return [];
    assert.equal(message.isError, false);
    const parsed = z
      .object({
        details: z.object({ toolCalls: z.array(z.object({ name: z.string(), ok: z.boolean() })) }),
      })
      .safeParse(message);
    return parsed.success ? parsed.data.details.toolCalls.filter((call) => call.ok) : [];
  });
  const toolNames = [
    ...toolCalls.map((call) => call.name),
    ...nestedCalls.map((call) => call.name),
  ];
  assert.ok(toolNames.includes("read"), "Native read tool was not called");
  assert.ok(toolNames.includes("bash"), "Native bash tool was not called through eval");
  const state = await client.getState();
  const expected = modelForRole("parent");
  assert.equal(state.model?.provider, expected.provider);
  assert.equal(state.model?.id, expected.modelId);
  assert.equal(state.thinkingLevel, expected.thinking);
  return { toolNames, errorMessages };
}

await main();
