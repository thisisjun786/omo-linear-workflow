import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Binding, Designation, Envelope, Result, ScopeSnapshot } from "../src/core/contracts";
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

function value<T>(result: Result<T>): T {
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

async function fixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
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
    supervisor: { provider: "chatgpt-subscription", modelId: "gpt-6-astra", thinking: "high" },
    parent: { provider: "kimi-coding", modelId: "k3", thinking: "max" },
    child: { provider: "anthropic-subscription", modelId: "claude-opus-5", thinking: "xhigh" },
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

function envelope(
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

class Harness implements RuntimePort {
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
  readonly activated: string[][] = [];
  readonly execCalls: Array<{
    readonly command: string;
    readonly args: readonly string[];
    readonly options: { readonly timeout: number } | undefined;
  }> = [];
  readonly reports: Array<readonly [string, string, string]> = [];
  executeCount = 0;
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

function context(binding: Binding, mode: SessionContextPort["mode"] = "rpc"): SessionContextPort {
  const role = binding.assignment.role;
  const models: Record<
    Binding["assignment"]["role"],
    { readonly provider: string; readonly id: string; readonly thinking: string }
  > = {
    supervisor: { provider: "chatgpt-subscription", id: "gpt-6-astra", thinking: "high" },
    parent: { provider: "kimi-coding", id: "k3", thinking: "max" },
    child: { provider: "anthropic-subscription", id: "claude-opus-5", thinking: "xhigh" },
  };
  return {
    cwd: binding.cwd,
    mode,
    model: models[role],
    thinkingLevel: models[role].thinking,
    sessionManager: {
      getSessionId: () => binding.durableSessionId,
      getSessionFile: () => binding.sessionPath ?? undefined,
    },
  };
}

function resultCode(value: unknown): string {
  if (typeof value !== "object" || value === null || !("ok" in value)) return "invalid";
  if (value.ok === true) return "ok";
  if (
    !("error" in value) ||
    typeof value.error !== "object" ||
    value.error === null ||
    !("code" in value.error)
  )
    return "invalid";
  return typeof value.error.code === "string" ? value.error.code : "invalid";
}

function resultState(value: unknown): string {
  if (
    typeof value !== "object" ||
    value === null ||
    !("ok" in value) ||
    value.ok !== true ||
    !("value" in value)
  )
    return "invalid";
  const record = value.value;
  if (typeof record !== "object" || record === null || !("state" in record)) return "invalid";
  return typeof record.state === "string" ? record.state : "invalid";
}

describe("native delivery extension", () => {
  test("activates thread_send, persists acceptance, and replays without a native resend", async () => {
    await fixture(async ({ root, supervisor, parent, digest }) => {
      const harness = new Harness();
      registerInitiativeRuntime(harness, { root, hostRuntime: true });
      await harness.start()(context(supervisor));
      const send = harness.rpc("omo.initiative.send");
      const message = envelope(supervisor, parent, digest, "message-1");
      expect(resultState(await send(message))).toBe("accepted");
      const firstExec = harness.execCalls[0];
      expect(firstExec?.command).toBe("bun");
      expect(firstExec?.args[0]).toBe(join(root, "dist/core/worker.js"));
      expect(firstExec?.args).toHaveLength(2);
      expect(firstExec?.options).toEqual({ timeout: 10_000 });
      expect(harness.activated).toEqual([["thread_send"]]);
      expect(harness.executeCount).toBe(1);
      expect(resultState(await send(message))).toBe("accepted");
      expect(harness.executeCount).toBe(1);
    });
  });

  test("derives sender context and rejects forged or forbidden routes before native send", async () => {
    await fixture(async ({ root, supervisor, parent, child, digest }) => {
      const harness = new Harness();
      registerInitiativeRuntime(harness, { root, hostRuntime: true });
      await harness.start()(context(supervisor));
      const send = harness.rpc("omo.initiative.send");
      expect(resultCode(await send(envelope(parent, child, digest, "forged")))).toBe(
        "sender_forged",
      );
      expect(resultCode(await send(envelope(supervisor, child, digest, "wrong-route")))).toBe(
        "route_denied",
      );
      expect(harness.executeCount).toBe(0);
    });
  });

  test("persists malformed, wrong-target, and idempotency-uncertain native outcomes as uncertain", async () => {
    await fixture(async ({ root, supervisor, parent, digest }) => {
      const harness = new Harness();
      registerInitiativeRuntime(harness, { root, hostRuntime: true });
      await harness.start()(context(supervisor));
      const send = harness.rpc("omo.initiative.send");
      harness.receipt = { malformed: true };
      expect(resultState(await send(envelope(supervisor, parent, digest, "malformed")))).toBe(
        "uncertain",
      );
      harness.receipt = {
        kind: "ok",
        thread_id: "session-child",
        message_seq: 8,
        deduplicated: false,
        delivery: { kind: "started", turn_id: "turn-2" },
      };
      expect(resultState(await send(envelope(supervisor, parent, digest, "wrong-target")))).toBe(
        "uncertain",
      );
      harness.receipt = {
        kind: "error",
        error: { code: "recipient_closed", message: "closed", next_action: "inspect target" },
      };
      expect(resultState(await send(envelope(supervisor, parent, digest, "rejected")))).toBe(
        "rejected",
      );
      harness.receipt = {
        kind: "error",
        error: { code: "idempotency_uncertain", message: "unknown", next_action: "reconcile" },
      };
      expect(resultState(await send(envelope(supervisor, parent, digest, "uncertain")))).toBe(
        "uncertain",
      );
    });
  });

  test("guards bound direct native calls but leaves unknown sessions unaffected", async () => {
    await fixture(async ({ root, supervisor, parent, child, digest }) => {
      const bound = new Harness();
      registerInitiativeRuntime(bound, { root, hostRuntime: true });
      const sender = context(supervisor);
      expect(await bound.guard()("thread_create", {}, sender)).toEqual({
        block: true,
        reason: "Bound initiative roles cannot create native threads",
      });
      const direct = envelope(supervisor, child, digest, "direct-wrong-route");
      expect(
        (
          await bound.guard()(
            "thread_send",
            {
              thread: child.durableSessionId,
              message: JSON.stringify(direct),
              delivery: "auto",
              all_scope: true,
              idempotency_key: direct.id,
            },
            sender,
          )
        )?.block,
      ).toBe(true);
      const valid = envelope(supervisor, parent, digest, "direct-valid-route");
      expect(
        (
          await bound.guard()(
            "thread_send",
            {
              thread: parent.durableSessionId,
              message: JSON.stringify(valid),
              delivery: "auto",
              all_scope: true,
              idempotency_key: valid.id,
            },
            sender,
          )
        )?.block,
      ).toBe(true);

      const unknown = context({ ...parent, durableSessionId: "unbound-session" });
      expect(await bound.guard()("thread_create", {}, unknown)).toBeUndefined();
      expect(await bound.guard()("thread_send", {}, unknown)).toBeUndefined();
    });
  });

  test("publishes the bound TUI readiness receipt and discovers four skills", async () => {
    await fixture(async ({ root, parent }) => {
      const harness = new Harness();
      registerInitiativeRuntime(harness, { root, hostRuntime: false });
      await harness.start()(context(parent, "tui"));
      expect(await Bun.file(join(root, ".omo/state/ready", `${parent.id}.json`)).exists()).toBe(
        true,
      );
      expect(await Bun.file(join(root, ".omo/state/ready", `${parent.id}.json`)).json()).toEqual({
        bindingId: parent.id,
        durableSessionId: parent.durableSessionId,
        sessionPath: "/sessions/parent.jsonl",
        cwd: parent.cwd,
        paneId: "pane-parent",
      });
      const resources = harness.resources?.();
      expect(resources?.skillPaths).toEqual(
        ["define", "plan", "run", "check"].map((name) => join(root, "skills", name)),
      );
    });
  });
});
