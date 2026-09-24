import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@code-yeongyu/senpi";
import { z } from "zod";
import type { Binding, Registry, Result, ScopeSnapshot } from "../src/core/contracts";
import { modelForRole } from "../src/core/policy";
import { deliveryRecordSchema, envelopeSchema } from "../src/core/schema";
import { openRegistry } from "../src/core/store";
import { runtimeFailureClaim } from "../src/extension/operational";
import {
  type RuntimePort,
  registerInitiativeRuntime,
  type SessionContextPort,
} from "../src/extension/runtime";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}
const snapshot: ScopeSnapshot = {
  version: 1,
  source: "fixture",
  initiative: { id: "initiative", url: "linear://initiative", revision: "r1" },
  projects: [
    {
      project: { id: "project", url: "linear://project", revision: "r1" },
      issues: [{ id: "issue", url: "linear://issue", revision: "r1" }],
    },
  ],
  decisionRefs: [],
};
function reserve(
  registry: Registry,
  root: string,
  id: string,
  assignment: Binding["assignment"],
  scope = snapshot,
  approvalId = "approval",
) {
  const digest = value(registry.importScope(scope)).digest;
  const session = SessionManager.create(join(root, id), join(root, "sessions"));
  const binding = value(
    registry.reserve({
      bindingId: id,
      durableSessionId: session.getSessionId(),
      snapshot: scope,
      assignment,
      designation: {
        id: approvalId,
        snapshotDigest: digest,
        designatedBy: "test",
        designatedAt: "2026-09-23",
        execute: true,
        create: true,
        contact: true,
      },
      cwd: join(root, id),
      checkout:
        assignment.role === "supervisor"
          ? null
          : {
              originalRepoRoot: root,
              path: join(root, id),
              branch: `olw/${id}`,
              baseBranch: "main",
              baseCommit: "fixture-base",
            },
      herdrSocket: join(root, "herdr.sock"),
      omoSocket: join(root, "omo.sock"),
    }),
  );
  value(registry.provision(id, `workspace-${id}`, `pane-${id}`));
  const sessionPath = session.getSessionFile();
  if (sessionPath === undefined) throw new Error("Missing session path");
  value(registry.observeSession(id, sessionPath));
  value(
    registry.activate(id, {
      durableSessionId: binding.durableSessionId,
      sessionPath,
      cwd: binding.cwd,
      ...modelForRole(assignment.role),
      extensionProtocol: 1,
    }),
  );
  value(registry.beginInitialization(id, "fixture"));
  return { binding: value(registry.finishInitialization(id, "accepted")), session };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "olw-operational-"));
  roots.push(root);
  await mkdir(join(root, ".omo/state"), { recursive: true });
  const registry = openRegistry(join(root, ".omo/state/registry.sqlite"));
  try {
    const manager = reserve(registry, root, "manager", {
      role: "supervisor",
      initiativeId: "initiative",
    });
    const parent = reserve(registry, root, "parent", {
      role: "parent",
      initiativeId: "initiative",
      projectId: "project",
      ownerBindingId: manager.binding.id,
    });
    const child = reserve(registry, root, "child", {
      role: "child",
      initiativeId: "initiative",
      projectId: "project",
      issueId: "issue",
      ownerBindingId: parent.binding.id,
    });
    return { root, manager, parent, child };
  } finally {
    registry.close();
  }
}
function context(role: ReturnType<typeof reserve>): SessionContextPort {
  const model = modelForRole(role.binding.assignment.role);
  return {
    cwd: role.binding.cwd,
    mode: "rpc",
    model: { provider: model.provider, id: model.modelId },
    thinkingLevel: model.thinking,
    disableModelFallbackForSession: () => undefined,
    sessionManager: role.session,
  };
}
function assistant(stopReason: "error" | "stop" | "aborted" = "error", timestamp = 1) {
  return {
    role: "assistant" as const,
    content: [],
    api: "anthropic-messages" as const,
    provider: "cliproxyapi",
    model: "claude-opus-5-5",
    stopReason,
    timestamp,
    ...(stopReason === "stop" ? {} : { errorMessage: "Cannot find module 'runtime-dependency'" }),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
class Harness implements RuntimePort {
  sessionStart: ((ctx: SessionContextPort) => Promise<void>) | undefined;
  turnEnd: ((message: unknown, ctx: SessionContextPort) => Promise<void>) | undefined;
  toolCall: Parameters<RuntimePort["onToolCall"]>[0] | undefined;
  handlers = new Map<string, (data: unknown) => Promise<unknown>>();
  ctx: SessionContextPort;
  sends: Array<Record<string, unknown>> = [];
  notifications: string[] = [];
  beforeNativeGuard: (() => void) | undefined;
  native: (input: Record<string, unknown>) => Promise<unknown> = async (input) => ({
    kind: "ok",
    thread_id: input["thread"],
    message_seq: 1,
    deduplicated: false,
    delivery: { kind: "started", turn_id: "turn" },
  });
  constructor(
    readonly root: string,
    role: ReturnType<typeof reserve>,
  ) {
    this.ctx = context(role);
    registerInitiativeRuntime(this, { root, hostRuntime: true });
  }
  onSessionStart(handler: Parameters<RuntimePort["onSessionStart"]>[0]) {
    this.sessionStart = handler;
  }
  onTurnEnd(handler: (message: unknown, ctx: SessionContextPort) => Promise<void>) {
    this.turnEnd = handler;
  }
  onResourcesDiscover() {}
  onToolCall(handler: Parameters<RuntimePort["onToolCall"]>[0]) {
    this.toolCall = handler;
  }
  handleRpc(name: string, handler: (data: unknown) => Promise<unknown>) {
    this.handlers.set(name, handler);
  }
  getActiveTools() {
    return ["read"];
  }
  setActiveTools() {}
  notifyOperational(message: string) {
    this.notifications.push(message);
  }
  async exec(_command: string, args: readonly string[]) {
    const request = args[1];
    if (request === undefined) throw new Error("Missing request");
    const worker = Bun.spawn(["bun", join(import.meta.dir, "../src/core/worker.ts"), request], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(worker.stdout).text(),
      new Response(worker.stderr).text(),
      worker.exited,
    ]);
    return { stdout, stderr, code, killed: false };
  }
  async executeTool(name: string, input: unknown) {
    const parsed = z.record(z.string(), z.unknown()).parse(input);
    this.beforeNativeGuard?.();
    const decision = await this.toolCall?.(name, parsed, this.ctx);
    if (decision?.block) throw new Error(decision.reason);
    this.sends.push(parsed);
    return { details: { result: await this.native(parsed) } };
  }
  async emit(message: unknown) {
    await this.turnEnd?.(message, this.ctx);
  }
}

test("a persisted parent assistant error sends one distinct operational notice to its exact manager", async () => {
  const { root, parent, manager } = await fixture();
  const harness = new Harness(root, parent);
  await harness.sessionStart?.(harness.ctx);
  const message = assistant();
  const entryId = parent.session.appendMessage(message);
  const before = withRegistry(root, (registry) => value(registry.list()));
  await harness.emit(message);
  expect(harness.sends).toHaveLength(1);
  expect(harness.sends[0]?.["thread"]).toBe(manager.binding.durableSessionId);
  const record = notices(root)[0];
  expect(record).toMatchObject({
    state: "accepted",
    envelope: {
      kind: "operational_notice",
      outcome: null,
      fromBindingId: parent.binding.id,
      toBindingId: manager.binding.id,
      operational: {
        binding: parent.binding,
        ownerBindingId: manager.binding.id,
        localReason: null,
        failure: {
          sessionEntryId: entryId,
          stopReason: "error",
          errorMessage: message.errorMessage,
          source: "turn_end",
          durableSessionId: parent.binding.durableSessionId,
          sessionPath: parent.binding.sessionPath,
          cwd: parent.binding.cwd,
          provider: message.provider,
          modelId: message.model,
          timestamp: 1,
        },
      },
    },
  });
  expect(withRegistry(root, (registry) => value(registry.list()))).toEqual(before);
  expect(withRegistry(root, (registry) => value(registry.postedReports({})))).toEqual([]);
  expect(notices(root, "other-project")).toEqual([]);
  if (record === undefined) throw new Error("Missing notice");
  expect(
    await Bun.file(
      join(root, ".omo/state/operational-notices", record.envelope.id, "accepted.json"),
    ).json(),
  ).toEqual(record);
  expect(
    deliveryRecordSchema.safeParse({
      ...record,
      envelope: { ...record.envelope, outcome: "failed" },
    }).success,
  ).toBe(false);
  expect(
    deliveryRecordSchema.safeParse({ ...record, envelope: { ...record.envelope, kind: "report" } })
      .success,
  ).toBe(false);
  expect(harness.notifications).toHaveLength(1);
});

test("CLI notices exposes operational errors separately from user reports without a runtime", async () => {
  const { root, parent } = await fixture();
  const harness = new Harness(root, parent);
  await harness.sessionStart?.(harness.ctx);
  const message = assistant();
  parent.session.appendMessage(message);
  await harness.emit(message);
  const expected = notices(root);
  for (const [command, project, records] of [
    ["notices", "project", expected],
    ["notices", "other-project", []],
    ["reports", "project", []],
  ] as const) {
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "../src/cli.ts"),
        "--root",
        root,
        command,
        "--project",
        project,
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
    expect(JSON.parse(stdout)).toEqual({ ok: true, value: records });
  }
});

function withRegistry<T>(root: string, operation: (registry: Registry) => T): T {
  const registry = openRegistry(join(root, ".omo/state/registry.sqlite"));
  try {
    return operation(registry);
  } finally {
    registry.close();
  }
}
function notices(root: string, projectId?: string) {
  return withRegistry(root, (registry) =>
    value(registry.operationalNotices(projectId === undefined ? {} : { projectId })),
  );
}

test("normal completion, idle startup, abort/cancel and reload alone never infer failure", async () => {
  const { root, parent } = await fixture();
  const harness = new Harness(root, parent);
  await harness.sessionStart?.(harness.ctx);
  for (const reason of ["stop", "aborted"] as const) {
    const message = assistant(reason);
    parent.session.appendMessage(message);
    await harness.emit(message);
  }
  await harness.emit({ role: "toolResult", isError: true, content: [] });
  // A reload is not a request to sweep or reinterpret old failures.
  parent.session.appendMessage(assistant("error", 2));
  registerInitiativeRuntime(harness, { root, hostRuntime: true });
  await harness.sessionStart?.(harness.ctx);
  expect(harness.sends).toEqual([]);
  expect(notices(root)).toEqual([]);
  expect(harness.notifications).toEqual([]);
});

test("concurrent duplicate events and deserialized replay after reload claim only once", async () => {
  const { root, parent, manager } = await fixture();
  const harness = new Harness(root, parent);
  const message = assistant();
  parent.session.appendMessage(message);
  await Promise.all([harness.emit(message), harness.emit(message)]);
  const original = notices(root);
  withRegistry(root, (registry) => {
    value(registry.setOwner(parent.binding.id, null));
    value(registry.beginClose(manager.binding.id));
    value(registry.finishClose(manager.binding.id));
  });
  registerInitiativeRuntime(harness, { root, hostRuntime: true });
  await harness.sessionStart?.(harness.ctx);
  await harness.emit(JSON.parse(JSON.stringify(message)));
  expect(harness.sends).toHaveLength(1);
  expect(harness.notifications).toHaveLength(1);
  expect(notices(root)).toEqual(original);
});

test("indistinguishable persisted errors are surfaced as attribution ambiguity, not guessed", async () => {
  const { root, parent } = await fixture();
  const harness = new Harness(root, parent);
  const first = assistant();
  const second = assistant();
  const firstId = parent.session.appendMessage(first);
  await harness.emit(first);
  parent.session.appendMessage(second);
  await harness.emit(second);
  // The public native event has no entry ID, and SessionManager materializes copies.
  // Equal evidence in two entries cannot safely select either entry on replay.
  expect(harness.sends).toHaveLength(1);
  expect(
    notices(root).map((record) => record.envelope.operational?.failure.sessionEntryId),
  ).toEqual([firstId]);
  await harness.emit(JSON.parse(JSON.stringify(second)));
  expect(harness.sends).toHaveLength(1);
  expect(harness.notifications).toHaveLength(3);
});

test.each([
  "standalone",
  "closed",
  "unavailable",
  "absent",
  "owner-paused",
  "sender-paused",
  "sender-cancelled",
] as const)(
  "%s recipient/contact state leaves durable local telemetry without a native wake or state mutation",
  async (scenario) => {
    const { root, parent, manager } = await fixture();
    withRegistry(root, (registry) => {
      if (scenario === "standalone") value(registry.setOwner(parent.binding.id, null));
      if (scenario === "closed") {
        value(registry.beginClose(manager.binding.id));
        value(registry.finishClose(manager.binding.id));
      }
      if (scenario === "unavailable") value(registry.setLaunchState(manager.binding.id, "failed"));
      if (scenario === "owner-paused")
        value(registry.setContactState(manager.binding.id, "paused"));
      if (scenario === "sender-paused")
        value(registry.setContactState(parent.binding.id, "paused"));
      if (scenario === "sender-cancelled")
        value(registry.setContactState(parent.binding.id, "cancelled"));
    });
    if (scenario === "absent") {
      const db = new Database(join(root, ".omo/state/registry.sqlite"));
      try {
        db.query("DELETE FROM bindings WHERE id = ?").run(manager.binding.id);
      } finally {
        db.close();
      }
    }
    const before = withRegistry(root, (registry) => value(registry.list()));
    const harness = new Harness(root, parent);
    const message = assistant();
    parent.session.appendMessage(message);
    await harness.emit(message);
    const record = notices(root)[0];
    expect(record).toMatchObject({
      state: "posted",
      receipt: null,
      envelope: { toBindingId: null, kind: "operational_notice", outcome: null },
    });
    expect(record?.envelope.operational?.localReason).not.toBeNull();
    expect(harness.sends).toEqual([]);
    expect(withRegistry(root, (registry) => value(registry.list()))).toEqual(before);
    expect(withRegistry(root, (registry) => value(registry.postedReports({})))).toEqual([]);
    if (record === undefined) throw new Error("Missing local telemetry");
    expect(
      await Bun.file(
        join(root, ".omo/state/operational-notices", record.envelope.id, "posted.json"),
      ).json(),
    ).toEqual(record);
    await harness.emit(message);
    expect(notices(root)).toEqual([record]);
    expect(harness.notifications).toHaveLength(1);
  },
);

test("link changes select the current owner only for a new incident, not replayed local telemetry", async () => {
  const { root, parent, manager } = await fixture();
  const harness = new Harness(root, parent);
  withRegistry(root, (registry) => value(registry.setOwner(parent.binding.id, null)));
  const first = assistant();
  parent.session.appendMessage(first);
  await harness.emit(first);
  withRegistry(root, (registry) => value(registry.setOwner(parent.binding.id, manager.binding.id)));
  await harness.emit(first);
  expect(harness.sends).toHaveLength(0);
  const second = assistant("error", 2);
  parent.session.appendMessage(second);
  await harness.emit(second);
  expect(harness.sends).toHaveLength(1);
  expect(harness.sends[0]?.["thread"]).toBe(manager.binding.durableSessionId);
  expect(notices(root).map((record) => record.state)).toEqual(["posted", "accepted"]);
});

test("a newly linked cross-designation manager receives a new incident from the unchanged parent", async () => {
  const { root, parent } = await fixture();
  const harness = new Harness(root, parent);
  const second = withRegistry(root, (registry) => {
    const scope: ScopeSnapshot = {
      ...snapshot,
      initiative: { id: "second-initiative", url: "linear://second-initiative", revision: "r2" },
    };
    const manager = reserve(
      registry,
      root,
      "second-manager",
      { role: "supervisor", initiativeId: "second-initiative" },
      scope,
      "second-approval",
    );
    value(registry.setOwner(parent.binding.id, manager.binding.id));
    return manager;
  });
  const before = withRegistry(root, (registry) => value(registry.list()));
  const message = assistant();
  parent.session.appendMessage(message);
  await harness.emit(message);
  expect(harness.sends[0]?.["thread"]).toBe(second.binding.durableSessionId);
  expect(notices(root)[0]?.envelope.designationId).toBe(parent.binding.designationId);
  expect(withRegistry(root, (registry) => value(registry.list()))).toEqual(before);
});

test("an owner change after claiming blocks the old native route without rerouting or retrying", async () => {
  const { root, parent, manager } = await fixture();
  const harness = new Harness(root, parent);
  harness.beforeNativeGuard = () => {
    withRegistry(root, (registry) => value(registry.setOwner(parent.binding.id, null)));
  };
  const message = assistant();
  parent.session.appendMessage(message);
  await harness.emit(message);
  expect(harness.sends).toHaveLength(0);
  expect(notices(root)[0]).toMatchObject({
    state: "uncertain",
    envelope: { toBindingId: manager.binding.id },
  });
  await harness.emit(message);
  expect(notices(root)).toHaveLength(1);
  expect(harness.sends).toHaveLength(0);
});

test("child failure notifies only its own parent; supervisor failure stays with the user", async () => {
  const { root, parent, child, manager } = await fixture();
  const childRuntime = new Harness(root, child);
  const childMessage = assistant();
  child.session.appendMessage(childMessage);
  await childRuntime.emit(childMessage);
  expect(childRuntime.sends[0]?.["thread"]).toBe(parent.binding.durableSessionId);
  const managerRuntime = new Harness(root, manager);
  const managerMessage = { ...assistant(), model: "gpt-6-astra" };
  manager.session.appendMessage(managerMessage);
  await managerRuntime.emit(managerMessage);
  expect(managerRuntime.sends).toEqual([]);
  expect(notices(root).map((record) => record.state)).toEqual(["accepted", "posted"]);
});

test.each([
  "lost-ack",
  "malformed",
  "wrong-target",
  "turn_conflict",
  "idempotency_uncertain",
  "recipient_closed",
] as const)(
  "native %s preserves the original incident/recipient and never retries or silently reroutes",
  async (outcome) => {
    const { root, parent, manager } = await fixture();
    const harness = new Harness(root, parent);
    const acceptedAtNativeBoundary: unknown[] = [];
    harness.native = async (input) => {
      if (outcome === "lost-ack" || outcome === "turn_conflict")
        acceptedAtNativeBoundary.push(input);
      if (outcome === "lost-ack") throw new Error("accepted but ACK lost");
      if (outcome === "malformed") return { malformed: true };
      if (outcome === "wrong-target")
        return {
          kind: "ok",
          thread_id: "foreign",
          message_seq: 0,
          deduplicated: false,
          delivery: { kind: "queued", queue_position: 0 },
        };
      return {
        kind: "error",
        error: { code: outcome, message: "native boundary evidence", next_action: "inspect" },
      };
    };
    const message = assistant();
    parent.session.appendMessage(message);
    await harness.emit(message);
    const [record] = notices(root);
    if (record === undefined) throw new Error("Missing operational notice");
    expect(record).toMatchObject({
      state: outcome === "recipient_closed" ? "rejected" : "uncertain",
      envelope: {
        toBindingId: manager.binding.id,
        operational: { localReason: null, failure: { errorMessage: message.errorMessage } },
      },
    });
    if (outcome === "turn_conflict" || outcome === "idempotency_uncertain")
      expect(record?.receipt).toMatchObject({ kind: "error", error: { code: outcome } });
    withRegistry(root, (registry) => value(registry.setOwner(parent.binding.id, null)));
    registerInitiativeRuntime(harness, { root, hostRuntime: true });
    await harness.emit(message);
    expect(harness.sends).toHaveLength(1);
    expect(notices(root)).toEqual([record]);
    expect(withRegistry(root, (registry) => value(registry.postedReports({})))).toEqual([]);
    if (outcome === "lost-ack" || outcome === "turn_conflict")
      expect(acceptedAtNativeBoundary).toHaveLength(1);
  },
);

test("a sending claim survives concurrent replay/reload without another native attempt", async () => {
  const { root, parent } = await fixture();
  const harness = new Harness(root, parent);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  harness.native = async (input) => {
    entered.resolve();
    await release.promise;
    return {
      kind: "ok",
      thread_id: input["thread"],
      message_seq: 1,
      deduplicated: false,
      delivery: { kind: "queued", queue_position: 0 },
    };
  };
  const message = assistant();
  parent.session.appendMessage(message);
  const pending = harness.emit(message);
  try {
    await entered.promise;
    expect(notices(root)[0]?.state).toBe("sending");
    registerInitiativeRuntime(harness, { root, hostRuntime: true });
    await harness.emit(message);
    expect(harness.sends).toHaveLength(1);
  } finally {
    release.resolve();
    await pending;
  }
  expect(notices(root)[0]?.state).toBe("accepted");
}, 15_000);

test("forwarding errors do not recursively become new operational incidents", async () => {
  const { root, parent } = await fixture();
  const harness = new Harness(root, parent);
  harness.native = async () => {
    const forwardingFailure = assistant("error", 2);
    parent.session.appendMessage(forwardingFailure);
    await harness.emit(forwardingFailure);
    throw new Error("forwarding failed");
  };
  const message = assistant();
  parent.session.appendMessage(message);
  await harness.emit(message);
  expect(harness.sends).toHaveLength(1);
  expect(notices(root)).toHaveLength(1);
  expect(notices(root)[0]?.state).toBe("uncertain");
});

test("native evidence is not forgeable through ordinary sends, and exact identity is checked by the worker", async () => {
  const { root, parent } = await fixture();
  const harness = new Harness(root, parent);
  await harness.sessionStart?.(harness.ctx);
  const message = assistant();
  parent.session.appendMessage(message);
  await harness.emit(message);
  const envelope = notices(root)[0]?.envelope;
  expect(envelope).toBeDefined();
  expect(await harness.handlers.get("omo.initiative.send")?.(envelope)).toMatchObject({
    ok: false,
    error: { code: "route_denied" },
  });
  const input = harness.sends[0];
  if (input === undefined) throw new Error("No native send");
  expect(await harness.toolCall?.("thread_send", input, harness.ctx)).toMatchObject({
    block: true,
  });
  const claim = runtimeFailureClaim(message, harness.ctx);
  if (claim === undefined) throw new Error("No error observation");
  for (const failure of [
    { ...claim.failure, durableSessionId: "foreign" },
    { ...claim.failure, cwd: "/foreign" },
    { ...claim.failure, sessionPath: "/foreign.jsonl" },
  ]) {
    const result = await harness.exec("bun", [
      "worker",
      JSON.stringify({
        version: 1,
        dbPath: join(root, ".omo/state/registry.sqlite"),
        action: "claim",
        input: {
          senderSessionId: parent.binding.durableSessionId,
          envelope: { ...claim, failure },
        },
      }),
    ]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: "identity_mismatch" },
    });
  }
  expect(envelopeSchema.safeParse({ ...envelope, operational: undefined }).success).toBe(false);
  expect(harness.sends).toHaveLength(1);
});

test("stopReason alone is explicit error evidence, and the actual event model is retained", async () => {
  const { root, parent } = await fixture();
  const harness = new Harness(root, parent);
  const { errorMessage: _errorMessage, ...message } = {
    ...assistant(),
    model: "actual-error-model",
  };
  parent.session.appendMessage(message);
  await harness.emit(message);
  expect(notices(root)[0]?.envelope.operational?.failure).toMatchObject({
    modelId: "actual-error-model",
    errorMessage: null,
    stopReason: "error",
  });
  expect(withRegistry(root, (registry) => value(registry.get(parent.binding.id)))).toEqual(
    parent.binding,
  );
});

test("unbound native sessions never acquire a fake binding or operational route", async () => {
  const { root, parent } = await fixture();
  const harness = new Harness(root, parent);
  const session = SessionManager.create(join(root, "unbound"), join(root, "sessions"));
  harness.ctx = { ...harness.ctx, cwd: session.getCwd(), sessionManager: session };
  const message = assistant();
  session.appendMessage(message);
  await harness.emit(message);
  expect(notices(root)).toEqual([]);
  expect(harness.sends).toEqual([]);
  expect(harness.notifications).toEqual([]);
  expect(withRegistry(root, (registry) => value(registry.list()))).toHaveLength(3);
});

test("missing native evidence and storage publication failure are visible without throwing into the agent loop", async () => {
  const { root, parent } = await fixture();
  const harness = new Harness(root, parent);
  const message = assistant();
  await harness.emit(message);
  expect(harness.notifications).toHaveLength(1);
  expect(notices(root)).toEqual([]);
  parent.session.appendMessage(message);
  await Bun.write(join(root, ".omo/state/operational-notices"), "not a directory");
  await harness.emit(message);
  expect(harness.notifications).toHaveLength(2);
  expect(harness.sends).toEqual([]);
  expect(notices(root)[0]?.state).toBe("sending");
});
