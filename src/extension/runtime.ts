import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";
import { z } from "zod";
import type { DeliveryRecord, Envelope, Result, RuntimeIdentity } from "../core/contracts";
import {
  bindingSchema,
  claimResultSchema,
  deliveryRecordSchema,
  envelopeSchema,
  nativeReceiptSchema,
  resultSchema,
  workerRequestSchema,
} from "../core/schema";
import { publishReadiness } from "../readiness";

export interface SessionContextPort {
  readonly cwd: string;
  readonly mode: "tui" | "rpc" | "app-server" | "json" | "print";
  readonly model: { readonly provider: string; readonly id: string } | undefined;
  readonly thinkingLevel: string | undefined;
  readonly sessionManager: {
    getSessionId(): string;
    getSessionFile(): string | undefined;
  };
}

export interface RuntimePort {
  onSessionStart(handler: (ctx: SessionContextPort) => Promise<void>): void;
  onResourcesDiscover(handler: () => { readonly skillPaths: string[] }): void;
  onToolCall(
    handler: (
      toolName: string,
      input: Readonly<Record<string, unknown>>,
      ctx: SessionContextPort,
    ) => Promise<{ readonly block: boolean; readonly reason?: string } | undefined>,
  ): void;
  handleRpc(name: string, handler: (data: unknown) => Promise<unknown>): void;
  exec(
    command: string,
    args: readonly string[],
    options?: { readonly timeout: number },
  ): Promise<{
    readonly stdout: string;
    readonly stderr: string;
    readonly code: number;
    readonly killed: boolean;
  }>;
  getActiveTools(): readonly string[];
  setActiveTools(tools: readonly string[]): void;
  executeTool(name: string, input: unknown): Promise<{ readonly details: unknown }>;
}

export interface RuntimeConfig {
  readonly root: string;
  readonly hostRuntime: boolean;
}

type WorkerAction = "lookup-session" | "authorize" | "claim" | "finish" | "uncertain";

const nativeSendInputSchema = z.strictObject({
  thread: z.string().min(1),
  message: z.string(),
  delivery: z.literal("auto"),
  all_scope: z.literal(true),
  idempotency_key: z.string().min(1),
});

function failure<T>(code: string, message: string, details?: unknown): Result<T> {
  return details === undefined
    ? { ok: false, error: { code, message } }
    : { ok: false, error: { code, message, details } };
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function registerInitiativeRuntime(port: RuntimePort, config: RuntimeConfig): void {
  const dbPath = join(config.root, ".omo/state/registry.sqlite");
  const workerPath = join(config.root, "dist/core/worker.js");
  let currentContext: SessionContextPort | undefined;
  const sessionStarted = Promise.withResolvers<void>();
  const dispatch = new AsyncLocalStorage<{
    readonly senderSessionId: string;
    readonly input: z.infer<typeof nativeSendInputSchema>;
    used: boolean;
  }>();

  async function contextWhenStarted(): Promise<SessionContextPort | undefined> {
    if (currentContext !== undefined) return currentContext;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      // Reload registers RPC handlers before it emits session_start.
      await Promise.race([
        sessionStarted.promise,
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, 10_000);
        }),
      ]);
      return currentContext;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function worker<T>(
    action: WorkerAction,
    input: unknown,
    schema: z.ZodType<Result<T>>,
  ): Promise<Result<T>> {
    const request = workerRequestSchema.safeParse({ version: 1, dbPath, action, input });
    if (!request.success)
      return failure(
        "invalid_worker_request",
        "Registry worker request is invalid",
        request.error.issues,
      );
    const execution = await port.exec("bun", [workerPath, JSON.stringify(request.data)], {
      timeout: 10_000,
    });
    if (execution.killed || execution.code !== 0 || execution.stderr.length > 0) {
      return failure("worker_failed", "Registry worker failed", {
        code: execution.code,
        killed: execution.killed,
        stderr: execution.stderr,
      });
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(execution.stdout);
    } catch (cause) {
      return failure("worker_failed", "Registry worker returned invalid JSON", messageOf(cause));
    }
    const parsed = schema.safeParse(decoded);
    return parsed.success
      ? parsed.data
      : failure("worker_failed", "Registry worker returned an invalid result", parsed.error.issues);
  }

  const lookup = (sessionId: string) =>
    worker("lookup-session", { durableSessionId: sessionId }, resultSchema(bindingSchema));

  async function uncertain(messageId: string, reason: string): Promise<Result<DeliveryRecord>> {
    return worker("uncertain", { messageId, reason }, resultSchema(deliveryRecordSchema));
  }

  port.onResourcesDiscover(() => ({
    skillPaths: ["define", "plan", "run", "check"].map((name) => join(config.root, "skills", name)),
  }));

  port.onSessionStart(async (ctx) => {
    currentContext = ctx;
    sessionStarted.resolve();
    if (config.hostRuntime || ctx.mode !== "tui") return;
    const sessionPath = ctx.sessionManager.getSessionFile();
    if (sessionPath === undefined) return;
    const binding = await lookup(ctx.sessionManager.getSessionId());
    if (!binding.ok || binding.value.paneId === null) return;
    await publishReadiness(config.root, {
      bindingId: binding.value.id,
      durableSessionId: ctx.sessionManager.getSessionId(),
      sessionPath,
      cwd: ctx.cwd,
      paneId: binding.value.paneId,
    });
  });

  port.handleRpc("omo.initiative.describe", async () => {
    const ctx = await contextWhenStarted();
    if (ctx === undefined) return failure("session_unavailable", "Session has not started");
    const binding = await lookup(ctx.sessionManager.getSessionId());
    if (!binding.ok) return binding;
    const sessionPath = ctx.sessionManager.getSessionFile();
    if (sessionPath === undefined || ctx.model === undefined || ctx.thinkingLevel === undefined) {
      return failure("identity_unavailable", "Runtime identity is incomplete");
    }
    const identity: RuntimeIdentity = {
      durableSessionId: ctx.sessionManager.getSessionId(),
      sessionPath,
      cwd: ctx.cwd,
      provider: ctx.model.provider,
      modelId: ctx.model.id,
      thinking: ctx.thinkingLevel,
      extensionProtocol: 1,
    };
    return { ok: true, value: identity };
  });

  port.handleRpc("omo.initiative.send", async (data) => {
    const ctx = await contextWhenStarted();
    if (ctx === undefined) return failure("session_unavailable", "Session has not started");
    const envelope = envelopeSchema.safeParse(data);
    if (!envelope.success)
      return failure("invalid_envelope", "Envelope is invalid", envelope.error.issues);
    const claim = await worker(
      "claim",
      { senderSessionId: ctx.sessionManager.getSessionId(), envelope: envelope.data },
      resultSchema(claimResultSchema),
    );
    if (!claim.ok) return claim;
    if (claim.value.disposition === "replay") return { ok: true, value: claim.value.record };
    if (claim.value.disposition === "in_progress") {
      return failure(
        "delivery_in_progress",
        "Delivery outcome is not safe to replay",
        claim.value.record,
      );
    }

    const active = new Set(port.getActiveTools());
    active.add("thread_send");
    port.setActiveTools([...active]);
    let details: unknown;
    try {
      const input = nativeSendInputSchema.parse({
        thread: claim.value.target.durableSessionId,
        message: JSON.stringify(envelope.data),
        delivery: "auto",
        all_scope: true,
        idempotency_key: envelope.data.id,
      });
      const executed = await dispatch.run(
        { senderSessionId: ctx.sessionManager.getSessionId(), input, used: false },
        () => port.executeTool("thread_send", input),
      );
      details = executed.details;
    } catch (cause) {
      return uncertain(envelope.data.id, `Native send did not return: ${messageOf(cause)}`);
    }
    const detailsResult = z.strictObject({ result: z.unknown() }).safeParse(details);
    if (!detailsResult.success)
      return uncertain(envelope.data.id, "Native result details were malformed");
    const receipt = nativeReceiptSchema.safeParse(detailsResult.data.result);
    if (!receipt.success) return uncertain(envelope.data.id, "Native receipt was malformed");
    if (receipt.data.kind === "error" && receipt.data.error.code === "idempotency_uncertain") {
      return uncertain(envelope.data.id, "Native idempotency outcome is uncertain");
    }
    const finished = await worker(
      "finish",
      { messageId: envelope.data.id, receipt: receipt.data },
      resultSchema(deliveryRecordSchema),
    );
    if (finished.ok) return finished;
    if (finished.error.code === "receipt_target_mismatch") {
      return uncertain(envelope.data.id, "Native receipt targeted a different session");
    }
    return finished;
  });

  port.onToolCall(async (toolName, input, ctx) => {
    if (toolName !== "thread_create" && toolName !== "thread_send") return undefined;
    const sender = await lookup(ctx.sessionManager.getSessionId());
    if (!sender.ok && sender.error.code === "not_found") return undefined;
    if (!sender.ok) return { block: true, reason: sender.error.message };
    if (toolName === "thread_create") {
      return { block: true, reason: "Bound initiative roles cannot create native threads" };
    }
    const permit = dispatch.getStore();
    if (
      permit === undefined ||
      permit.used ||
      permit.senderSessionId !== ctx.sessionManager.getSessionId()
    ) {
      return { block: true, reason: "Bound sends must use the claimed initiative RPC" };
    }
    const nativeInput = nativeSendInputSchema.safeParse(input);
    if (!nativeInput.success)
      return { block: true, reason: "Direct thread_send arguments are invalid" };
    if (JSON.stringify(nativeInput.data) !== JSON.stringify(permit.input)) {
      return { block: true, reason: "Native send does not match the claimed attempt" };
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(nativeInput.data.message);
    } catch {
      return { block: true, reason: "Direct thread_send message is not an envelope" };
    }
    const envelope = envelopeSchema.safeParse(decoded);
    if (
      !envelope.success ||
      envelope.data.id !== nativeInput.data.idempotency_key ||
      envelope.data.fromBindingId !== sender.value.id
    ) {
      return { block: true, reason: "Direct thread_send identity is invalid" };
    }
    const authorized = await worker(
      "authorize",
      { senderSessionId: ctx.sessionManager.getSessionId(), envelope: envelope.data },
      resultSchema(bindingSchema),
    );
    if (!authorized.ok) return { block: true, reason: authorized.error.message };
    if (nativeInput.data.thread !== authorized.value.durableSessionId) {
      return {
        block: true,
        reason: "Direct thread_send target does not match the authorized route",
      };
    }
    permit.used = true;
    return undefined;
  });
}

export type DescribeReply = Result<RuntimeIdentity>;
export type SendReply = Result<DeliveryRecord>;
export type SendInput = Envelope;
