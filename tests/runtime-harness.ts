import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Binding, Designation, Envelope, Result, ScopeSnapshot } from "../src/core/contracts";
import { modelForRole } from "../src/core/policy";
import { deliveryRecordSchema, resultSchema } from "../src/core/schema";
import { openRegistry } from "../src/core/store";
import {
  type RuntimePort,
  registerInitiativeRuntime,
  type SessionContextPort,
} from "../src/extension/runtime";

const snapshot: ScopeSnapshot = {
  version: 1,
  source: "fixture",
  initiative: { id: "initiative-1", url: "linear://initiative-1", revision: "rev-1" },
  projects: [
    {
      project: { id: "project-1", url: "linear://project-1", revision: "rev-1" },
      issues: [{ id: "issue-1", url: "linear://issue-1", revision: "rev-1" }],
    },
  ],
  decisionRefs: [],
};

export function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

interface Fixture {
  readonly root: string;
  readonly supervisor: Binding;
  readonly parent: Binding;
  readonly child: Binding;
  readonly digest: string;
}

export async function fixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "omo-events-"));
  await mkdir(join(root, ".omo/state"), { recursive: true });
  const registry = openRegistry(join(root, ".omo/state/registry.sqlite"));
  const digest = value(registry.importScope(snapshot)).digest;
  const designation: Designation = {
    id: "designation-1",
    snapshotDigest: digest,
    designatedBy: "test",
    designatedAt: "2026-09-22T00:00:00Z",
    execute: true,
    create: true,
    contact: true,
  };
  const reserve = (bindingId: string, assignment: Binding["assignment"]) =>
    value(
      registry.reserve({
        bindingId,
        durableSessionId: `session-${bindingId}`,
        designation,
        snapshot,
        assignment,
        cwd: `/repo/${bindingId}`,
        checkout: null,
        herdrSocket: join(root, "herdr.sock"),
        omoSocket: join(root, "omo.sock"),
      }),
    );
  const supervisor = reserve("supervisor", { role: "supervisor", initiativeId: "initiative-1" });
  const parent = reserve("parent", {
    role: "parent",
    initiativeId: "initiative-1",
    projectId: "project-1",
    ownerBindingId: supervisor.id,
  });
  const child = reserve("child", {
    role: "child",
    initiativeId: "initiative-1",
    projectId: "project-1",
    issueId: "issue-1",
    ownerBindingId: parent.id,
  });
  const models: Record<
    Binding["assignment"]["role"],
    { readonly provider: string; readonly modelId: string; readonly thinking: string }
  > = {
    manager: { provider: "opencodex", modelId: "anthropic/claude-opus-5-5", thinking: "medium" },
    supervisor: modelForRole("supervisor"),
    parent: modelForRole("parent"),
    child: modelForRole("child"),
  };
  const activate = (binding: Binding) => {
    value(registry.provision(binding.id, `workspace-${binding.id}`, `pane-${binding.id}`));
    value(registry.observeSession(binding.id, `/sessions/${binding.id}.jsonl`));
    const configured = value(
      registry.activate(binding.id, {
        durableSessionId: binding.durableSessionId,
        sessionPath: `/sessions/${binding.id}.jsonl`,
        cwd: binding.cwd,
        ...models[binding.assignment.role],
        extensionProtocol: 1,
      }),
    );
    value(registry.beginInitialization(configured.id, "Fixture initialization"));
    return value(registry.finishInitialization(configured.id, "accepted"));
  };
  const ready = {
    supervisor: activate(supervisor),
    parent: activate(parent),
    child: activate(child),
  };
  registry.close();
  try {
    await run({ root, ...ready, digest });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export function linkReadyManager(
  registry: ReturnType<typeof openRegistry>,
  parent: Binding,
  root: string,
): Binding {
  const managerSnapshot: ScopeSnapshot = {
    version: 1,
    source: "linear-export",
    initiative: null,
    projects: [],
    decisionRefs: [],
  };
  const managerDigest = value(registry.importScope(managerSnapshot)).digest;
  const manager = value(
    registry.reserve({
      bindingId: "manager",
      durableSessionId: "session-manager",
      designation: {
        id: "manager-designation",
        snapshotDigest: managerDigest,
        designatedBy: "test",
        designatedAt: "2026-09-27T00:00:00Z",
        execute: true,
        create: true,
        contact: true,
      },
      snapshot: managerSnapshot,
      assignment: { role: "manager" },
      cwd: root,
      checkout: null,
      herdrSocket: join(root, "herdr.sock"),
      omoSocket: join(root, "omo.sock"),
    }),
  );
  value(registry.provision(manager.id, "workspace-manager", "pane-manager"));
  value(registry.observeSession(manager.id, "/sessions/manager.jsonl"));
  value(
    registry.activate(manager.id, {
      durableSessionId: manager.durableSessionId,
      sessionPath: "/sessions/manager.jsonl",
      cwd: manager.cwd,
      provider: "opencodex",
      modelId: "anthropic/claude-opus-5-5",
      thinking: "medium",
      extensionProtocol: 2,
    }),
  );
  value(registry.beginInitialization(manager.id, "Fixture initialization"));
  value(registry.finishInitialization(manager.id, "accepted"));
  value(registry.setOwner(parent.id, manager.id));
  return value(registry.get(manager.id));
}

export function envelope(
  from: Binding,
  to: Binding,
  digest: string,
  id: string,
  kind: Envelope["kind"] = "instruction",
): Envelope {
  return {
    version: 1,
    id,
    fromBindingId: from.id,
    toBindingId: to.id,
    designationId: from.designationId,
    snapshotDigest: digest,
    kind,
    text: "payload",
    outcome: kind === "report" ? "completed" : null,
    evidence: [],
  };
}

export class Harness implements RuntimePort {
  sessionStart: ((ctx: SessionContextPort) => Promise<void>) | undefined;
  resources: (() => { readonly skillPaths: readonly string[] }) | undefined;
  toolCall:
    | ((
        name: string,
        input: Readonly<Record<string, unknown>>,
        ctx: SessionContextPort,
      ) => Promise<{ readonly block: boolean; readonly reason?: string } | undefined>)
    | undefined;
  readonly handlers = new Map<string, (data: unknown) => Promise<unknown>>();
  readonly tools = new Map<
    string,
    {
      execute: (toolCallId: string, params: unknown, ctx: SessionContextPort) => Promise<unknown>;
    }
  >();
  readonly activated: string[][] = [];
  readonly execCalls: Array<{
    readonly command: string;
    readonly args: readonly string[];
    readonly options: { readonly timeout: number } | undefined;
  }> = [];
  readonly reports: Array<readonly [string, string, string]> = [];
  executeCount = 0;
  readonly nativeInputs: unknown[] = [];
  afterNative: (() => Promise<void>) | undefined;
  currentContext: SessionContextPort | undefined;
  receipt: unknown = {
    kind: "ok",
    thread_id: "session-parent",
    message_seq: 7,
    deduplicated: false,
    delivery: { kind: "started", turn_id: "turn-1" },
  };

  onSessionStart(handler: (ctx: SessionContextPort) => Promise<void>): void {
    this.sessionStart = handler;
  }
  onTurnEnd(): void {}
  messageStart: Parameters<RuntimePort["onMessageStart"]>[0] | undefined;
  readonly waitEvents: unknown[] = [];
  readonly entries: Array<{ type: string; id: string; customType: string; data: unknown }> = [];
  goal: { id: string; updatedAt: number; status: "active" | "paused" | "complete" } | null = {
    id: "packet-goal",
    updatedAt: 1,
    status: "active",
  };
  pauseCalls = 0;
  resumeCalls = 0;
  userInterrupt: ((ctx: SessionContextPort) => Promise<void>) | undefined;
  goalCheck: ((ctx: SessionContextPort) => Promise<void>) | undefined;
  onUserInterrupt(handler: (ctx: SessionContextPort) => Promise<void>) {
    this.userInterrupt = handler;
  }
  onGoalCheck(handler: (ctx: SessionContextPort) => Promise<void>) {
    this.goalCheck = handler;
  }
  idleWaits = 0;
  onMessageStart(handler: Parameters<RuntimePort["onMessageStart"]>[0]): void {
    this.messageStart = handler;
  }
  emitQuestionWait(active: boolean, ids: readonly string[]): void {
    this.waitEvents.push({ active, ids: [...ids] });
  }
  appendQuestionWait(data: unknown): void {
    this.entries.push({
      type: "custom",
      id: String(this.entries.length),
      customType: "olw-question-wait",
      data,
    });
  }
  async pauseGoal() {
    this.pauseCalls++;
    if (this.goal?.status !== "active") return null;
    this.goal.status = "paused";
    this.goal.updatedAt++;
    return { id: this.goal.id, updatedAt: this.goal.updatedAt };
  }
  async ownsGoalPause(_ctx: SessionContextPort, pause: { id: string; updatedAt: number }) {
    return (
      this.goal?.id === pause.id &&
      this.goal.status === "paused" &&
      this.goal.updatedAt === pause.updatedAt
    );
  }
  async resumeGoal(
    ctx: SessionContextPort,
    pause: { id: string; updatedAt: number },
  ): Promise<void> {
    this.resumeCalls++;
    if (this.goal && (await this.ownsGoalPause(ctx, pause))) this.goal.status = "active";
  }
  isIdle(): boolean {
    return true;
  }
  async waitForIdle(): Promise<void> {
    this.idleWaits++;
  }
  async sendManagerNotice(
    target: Binding,
    request: { readonly messageId: string; readonly nativeKey: string },
  ) {
    const recipient = new Harness();
    recipient.exec = this.exec.bind(this);
    recipient.isIdle = this.isIdle.bind(this);
    recipient.waitForIdle = this.waitForIdle.bind(this);
    recipient.receipt = this.receipt;
    const priorContext = this.currentContext;
    const priorGuard = this.toolCall;
    registerInitiativeRuntime(recipient, { root: join(target.omoSocket, ".."), hostRuntime: true });
    await recipient.start()(context(target));
    // Existing tests inject native races at executeTool. Keep those injections on
    // the receiving runtime rather than replacing the native preflight with a mock.
    recipient.executeTool = async (name, input) => {
      this.currentContext = context(target);
      this.toolCall = recipient.guard();
      try {
        return await this.executeTool(name, input);
      } finally {
        this.currentContext = priorContext;
        this.toolCall = priorGuard;
      }
    };
    return resultSchema(deliveryRecordSchema).parse(
      await recipient.rpc("omo.initiative.admit-manager-notice")(request),
    );
  }
  notifyOperational(): void {}
  onResourcesDiscover(handler: () => { readonly skillPaths: readonly string[] }): void {
    this.resources = handler;
  }
  onToolCall(
    handler: (
      name: string,
      input: Readonly<Record<string, unknown>>,
      ctx: SessionContextPort,
    ) => Promise<{ readonly block: boolean; readonly reason?: string } | undefined>,
  ): void {
    this.toolCall = handler;
  }
  handleRpc(name: string, handler: (data: unknown) => Promise<unknown>): void {
    this.handlers.set(name, handler);
  }
  registerTool(tool: {
    name: string;
    execute: (toolCallId: string, params: unknown, ctx: SessionContextPort) => Promise<unknown>;
  }): void {
    this.tools.set(tool.name, tool);
  }
  callTool(name: string, toolCallId: string, params: unknown): Promise<unknown> {
    const tool = this.tools.get(name);
    if (tool === undefined || this.currentContext === undefined)
      throw new Error(`Missing tool ${name}`);
    return tool
      .execute(toolCallId, params, this.currentContext)
      .then((result) => z.object({ details: z.unknown() }).parse(result).details);
  }
  async exec(command: string, args: readonly string[], options?: { readonly timeout: number }) {
    this.execCalls.push({ command, args: [...args], options });
    const encoded = command === "bun" ? args[1] : args[3];
    if (encoded === undefined)
      return { stdout: "", stderr: "missing worker request", code: 1, killed: false };
    const child = Bun.spawn(["bun", join(import.meta.dir, "../src/core/worker.ts"), encoded], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, code, killed: false };
  }
  getActiveTools(): readonly string[] {
    return [];
  }
  setActiveTools(tools: readonly string[]): void {
    this.activated.push([...tools]);
  }
  async executeTool(name: string, input: unknown) {
    if (this.currentContext === undefined) throw new Error("Session was not started");
    const decision = await this.guard()(
      name,
      z.record(z.string(), z.unknown()).parse(input),
      this.currentContext,
    );
    if (decision?.block) throw new Error(decision.reason);
    this.executeCount += 1;
    this.nativeInputs.push(input);
    await this.afterNative?.();
    return { details: { result: this.receipt } };
  }
  async reportSession(socket: string, pane: string, path: string): Promise<void> {
    this.reports.push([socket, pane, path]);
  }

  rpc(name: string): (data: unknown) => Promise<unknown> {
    const handler = this.handlers.get(name);
    if (handler === undefined) throw new Error(`Missing RPC handler ${name}`);
    return handler;
  }
  start(): (ctx: SessionContextPort) => Promise<void> {
    if (this.sessionStart === undefined) throw new Error("Missing session_start handler");
    const handler = this.sessionStart;
    return async (ctx) => {
      this.currentContext = ctx;
      await handler(ctx);
    };
  }
  guard() {
    if (this.toolCall === undefined) throw new Error("Missing tool_call handler");
    return this.toolCall;
  }
}

export function context(
  binding: Binding,
  mode: SessionContextPort["mode"] = "rpc",
): SessionContextPort {
  const { provider, modelId, thinking } = modelForRole(binding.assignment.role);
  return {
    cwd: binding.cwd,
    mode,
    model: { provider, id: modelId },
    thinkingLevel: thinking,
    disableModelFallbackForSession: () => undefined,
    sessionManager: {
      getSessionId: () => binding.durableSessionId,
      getSessionFile: () => binding.sessionPath ?? undefined,
      getBranch: () => [],
    },
  };
}
