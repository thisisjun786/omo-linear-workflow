import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SessionManager } from "@code-yeongyu/senpi";
import type { Binding, Result, RuntimeIdentity, ScopeSnapshot } from "../src/core/contracts";
import { modelForLaunch, modelForRole } from "../src/core/policy";
import { openRegistry } from "../src/core/store";
import { createHerdrClient, type HerdrClient } from "../src/herdr";
import { Orchestrator, type OrchestratorDependencies, planPaneExited } from "../src/orchestrator";
import { publishReadiness } from "../src/readiness";
import { type NativeSession, NativeSessionAbsentError } from "../src/transport";
import { prepareQaWorld } from "./qa-world";

function value<T>(result: Result<T>): T {
  assert.ok(result.ok, JSON.stringify(result));
  return result.value;
}

const evidenceRoot = "/home/jun/code/omo-linear-workflow/.omo/evidence/lina-302";
await mkdir(evidenceRoot, { recursive: true });
const receipt: Record<string, unknown> = { result: "FAILED", cleanup: {} };
const world = await prepareQaWorld();
try {
  receipt["scratch"] = world.scratch;
  receipt["controlRoot"] = world.controlRoot;
  receipt["herdrSocket"] = world.herdrSocket;
  const registryPath = join(world.controlRoot, ".omo/state/registry.sqlite");
  await mkdir(join(world.controlRoot, ".omo/state"), { recursive: true });
  const registry = openRegistry(registryPath);
  const scope: ScopeSnapshot = {
    version: 1,
    source: "fixture",
    initiative: null,
    projects: [
      {
        project: { id: "project", url: "linear://project", revision: "1" },
        issues: [{ id: "issue", key: "QA-302", url: "linear://issue", revision: "1" }],
      },
    ],
    decisionRefs: [],
  };
  const digest = value(registry.importScope(scope)).digest;
  const designation = {
    id: "designation",
    snapshotDigest: digest,
    designatedBy: "qa",
    designatedAt: new Date().toISOString(),
    create: true,
    execute: true,
    contact: true,
  };
  const roleRoot = join(world.controlRoot, ".omo/checkouts/lina-302");
  await mkdir(roleRoot, { recursive: true });
  const checkout = {
    kind: "owned-clone" as const,
    remote: "file:///qa",
    receiptPath: join(world.scratch, "receipt.json"),
    originalRepoRoot: roleRoot,
    path: roleRoot,
    branch: "qa",
    baseBranch: "main",
    baseCommit: "head",
  };
  const base = {
    designation,
    snapshot: scope,
    cwd: roleRoot,
    checkout,
    herdrSocket: world.herdrSocket,
    omoSocket: join(world.controlRoot, ".omo/state/omo.sock"),
  };
  const parent = value(
    registry.reserve({
      ...base,
      bindingId: "parent",
      durableSessionId: "qa-parent-session",
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
    registry.reserve({
      ...base,
      bindingId: "plan",
      durableSessionId: "qa-plan-session",
      assignment,
    }),
  );
  const herdr = createHerdrClient(world.herdrSocket);
  const workspace = await herdr.createWorkspace(roleRoot, "lina-302-qa");
  world.workspaces.push(workspace.workspaceId);
  const executePane = (await herdr.createTab(workspace.workspaceId, roleRoot, "execute"))
    .rootPaneId;
  const identities = new Map<string, RuntimeIdentity>();
  const makeReady = async (binding: Binding, paneId: string): Promise<Binding> => {
    const model = modelForRole(binding.assignment.role);
    const manager = SessionManager.create(
      roleRoot,
      join(world.controlRoot, ".omo/state/sessions"),
      { id: binding.durableSessionId },
    );
    manager.appendModelChange(model.provider, model.modelId);
    manager.appendThinkingLevelChange(model.thinking);
    const path = manager.getSessionFile();
    const header = manager.getHeader();
    assert.ok(path && header);
    await mkdir(join(world.controlRoot, ".omo/state/sessions"), { recursive: true });
    await writeFile(
      path,
      `${[header, ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
    value(registry.provision(binding.id, workspace.workspaceId, paneId));
    value(registry.observeSession(binding.id, path));
    const identity = {
      durableSessionId: binding.durableSessionId,
      sessionPath: path,
      cwd: roleRoot,
      ...model,
      extensionProtocol: 2 as const,
    };
    identities.set(binding.durableSessionId, identity);
    value(registry.activate(binding.id, identity));
    value(registry.beginInitialization(binding.id, "brief"));
    value(registry.finishInitialization(binding.id, "accepted"));
    return value(registry.get(binding.id));
  };
  const readyParent = await makeReady(parent, workspace.rootPaneId);
  const readyPlan = await makeReady(plan, workspace.rootPaneId);
  value(registry.recordStage(plan.id, "issue", "plan", 0, null));
  value(
    registry.recordHandoff(plan.id, {
      planPath: join(world.controlRoot, "plan.md"),
      planSha256: "a".repeat(64),
      head: "head",
      completedAt: new Date().toISOString(),
    }),
  );
  const execute = value(
    registry.successorReservation(
      plan.id,
      {
        ...base,
        bindingId: "execute",
        durableSessionId: "qa-execute-session",
        assignment,
      },
      "execute",
    ),
  );
  const executeModel = modelForLaunch("child", "execute");
  const executeManager = SessionManager.create(
    roleRoot,
    join(world.controlRoot, ".omo/state/sessions"),
    { id: execute.durableSessionId },
  );
  executeManager.appendModelChange(executeModel.provider, executeModel.modelId);
  executeManager.appendThinkingLevelChange(executeModel.thinking);
  const executePath = executeManager.getSessionFile();
  const executeHeader = executeManager.getHeader();
  assert.ok(executePath && executeHeader);
  await writeFile(
    executePath,
    `${[executeHeader, ...executeManager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
  value(registry.provision(execute.id, workspace.workspaceId, executePane));
  const launchClaim = value(registry.beginSuccessorLaunch(execute.id, executePane, "1", "0"));
  assert.ok(launchClaim.claimed);
  value(registry.observeSuccessorSession(execute.id, launchClaim.token, executePath));
  // Recreate the interrupted dispatch with a stable attempt after the session path is stored.
  const db = new (await import("bun:sqlite")).Database(registryPath);
  db.query(
    "UPDATE bindings SET launch_state = 'uncertain', json = json_set(json, '$.launchState', 'uncertain') WHERE id = ?",
  ).run(execute.id);
  db.query("UPDATE successor_launch SET state = 'uncertain' WHERE binding_id = ?").run(execute.id);
  db.close();
  registry.close();

  const exited = Promise.withResolvers<void>();
  const stopEvents = await herdr.subscribe((event) => {
    if (planPaneExited(event, executePane)) exited.resolve();
  });
  await herdr.run(
    executePane,
    [
      "bash",
      "-lc",
      'exec -a omo sh -c \'trap "exit 0" TERM INT; while :; do read -r line || exit 0; [ "$line" = /quit ] && exit 0; done\'',
    ],
    {},
  );
  let nativeReady = false;
  let sends = 0;
  const fakeSession = (identity: RuntimeIdentity): NativeSession => ({
    configure: async (model) => {
      identities.set(identity.durableSessionId, { ...identity, ...model });
    },
    hasUserMessage: async () => false,
    describe: async () => ({
      ok: true,
      value: identities.get(identity.durableSessionId) ?? identity,
    }),
    send: async (envelope) => {
      sends += 1;
      return {
        ok: true,
        value: {
          envelope,
          state: "accepted",
          receipt: {
            kind: "ok",
            thread_id: execute.durableSessionId,
            message_seq: sends,
            deduplicated: false,
            delivery: { kind: "started", turn_id: `qa-${sends}` },
          },
        },
      };
    },
    deliverUserAnswer: async () => {
      throw new Error("unexpected answer");
    },
    onEvent: () => () => {},
    close: async () => {},
  });
  const recoveryHerdr = (): HerdrClient => {
    const client = createHerdrClient(world.herdrSocket);
    const recoveryRun: HerdrClient["run"] = async (paneId, argv, env) => {
      await client.run(paneId, argv, env);
      if (argv.includes("--session")) {
        const current = openRegistry(registryPath);
        const binding = value(current.get(execute.id));
        current.close();
        assert.ok(binding.sessionPath);
        identities.set(execute.durableSessionId, {
          durableSessionId: execute.durableSessionId,
          sessionPath: binding.sessionPath,
          cwd: binding.cwd,
          ...executeModel,
          extensionProtocol: 2,
        });
        nativeReady = true;
        await publishReadiness(world.controlRoot, {
          bindingId: binding.id,
          durableSessionId: binding.durableSessionId,
          sessionPath: binding.sessionPath,
          cwd: binding.cwd,
          paneId,
        });
      }
    };
    return new Proxy(client, {
      get(target, property) {
        if (property === "run") return recoveryRun;
        const member = Reflect.get(target, property);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
  };
  const dependencies: OrchestratorDependencies = {
    openRegistry,
    createHerdrClient: recoveryHerdr,
    attachBinding: async (binding) => {
      if (binding.id === execute.id && !nativeReady) throw new NativeSessionAbsentError();
      const identity = identities.get(binding.durableSessionId);
      assert.ok(identity);
      return fakeSession(identity);
    },
    terminateBinding: async () => {},
    resolveHerdrArtifact: async () => ({ artifactDir: join(world.controlRoot, ".omo/herdr") }),
    ensureHost: async () => {},
    checkHostProfile: async () => {},
    gitTip: async () => "head",
    now: () => new Date().toISOString(),
    uuid: () => crypto.randomUUID(),
    prompt: async () => {},
  };
  const recovered = await new Orchestrator(
    world.controlRoot,
    world.herdrSocket,
    dependencies,
  ).stageStart({
    fromId: readyPlan.id,
    parentId: readyParent.id,
    stage: "execute",
    messageId: "start",
  });
  assert.ok(recovered.ok, JSON.stringify(recovered));
  await Promise.race([
    exited.promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("pane exit timeout")), 5000),
    ),
  ]);
  stopEvents();
  assert.equal(recovered.value.binding.id, execute.id);
  assert.equal(recovered.value.binding.durableSessionId, execute.durableSessionId);
  assert.equal(recovered.value.binding.sessionPath, executePath);
  assert.equal(sends, 1);
  receipt["recovery"] = {
    sameBinding: recovered.value.binding.id,
    sameDurableSessionId: recovered.value.binding.durableSessionId,
    sameSessionPath: recovered.value.binding.sessionPath,
    initializationSends: sends,
    exactPaneStopped: executePane,
  };
  receipt["result"] = "PASS";
} finally {
  await world.close();
  receipt["cleanup"] = {
    worldClosed: true,
    scratchRemoved: !(await Bun.file(world.scratch).exists()),
    ...world.cleanup,
  };
  await writeFile(
    join(evidenceRoot, "official-herdr-recovery.json"),
    JSON.stringify(receipt, null, 2),
  );
}
console.log("LINA_302_QA_PASS", JSON.stringify(receipt));
