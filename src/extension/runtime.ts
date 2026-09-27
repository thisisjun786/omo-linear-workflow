import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { z } from "zod";
import type {
  Binding,
  ClaimResult,
  DeliveryRecord,
  Designation,
  Envelope,
  Result,
  RuntimeIdentity,
} from "../core/contracts";
import { canRetryDelivery, questionRecipient } from "../core/policy";
import {
  bindingSchema,
  claimResultSchema,
  deliveryRecordSchema,
  designationSchema,
  envelopeSchema,
  nativeReceiptSchema,
  questionPayloadSchema,
  resultSchema,
  workerRequestSchema,
} from "../core/schema";
import { publishReadiness } from "../readiness";
import { type GoalPause, goalPauseSchema } from "./goal-pause";
import { publishOperationalNotice, runtimeFailureClaim } from "./operational";

export interface SessionContextPort {
  readonly cwd: string;
  readonly mode: "tui" | "rpc" | "app-server" | "json" | "print";
  readonly goalStoreFile?: string;
  readonly model: { readonly provider: string; readonly id: string } | undefined;
  readonly thinkingLevel: string | undefined;
  disableModelFallbackForSession(): void;
  readonly sessionManager: {
    getSessionId(): string;
    getSessionFile(): string | undefined;
    getBranch(): readonly {
      readonly type: string;
      readonly id: string;
      readonly message?: unknown;
      readonly customType?: string;
      readonly data?: unknown;
    }[];
  };
}

export interface RuntimePort {
  onSessionStart(handler: (ctx: SessionContextPort) => Promise<void>): void;
  onMessageStart(handler: (message: unknown, ctx: SessionContextPort) => Promise<void>): void;
  emitQuestionWait(active: boolean, ids: readonly string[]): void;
  appendQuestionWait(data: unknown): void;
  pauseGoal(ctx: SessionContextPort): Promise<GoalPause | null | false>;
  ownsGoalPause(ctx: SessionContextPort, pause: GoalPause): Promise<boolean>;
  resumeGoal(
    ctx: SessionContextPort,
    pause: GoalPause,
    onOwnershipLost?: () => void,
  ): Promise<void>;
  onUserInterrupt(handler: (ctx: SessionContextPort) => Promise<void>): void;
  onGoalCheck(handler: (ctx: SessionContextPort) => Promise<void>): void;
  waitForIdle(target: Binding, timeoutMs?: number): Promise<void>;
  isIdle(target: Binding): boolean;
  onTurnEnd(handler: (message: unknown, ctx: SessionContextPort) => Promise<void>): void;
  notifyOperational(message: string, ctx: SessionContextPort): void;
  onResourcesDiscover(handler: () => { readonly skillPaths: string[] }): void;
  onToolCall(
    handler: (
      toolName: string,
      input: Readonly<Record<string, unknown>>,
      ctx: SessionContextPort,
    ) => Promise<{ readonly block: boolean; readonly reason?: string } | undefined>,
  ): void;
  handleRpc(name: string, handler: (data: unknown) => Promise<unknown>): void;
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: typeof askParameters;
    execute: (
      toolCallId: string,
      params: unknown,
      ctx: SessionContextPort,
    ) => Promise<{
      content: { type: "text"; text: string }[];
      details: unknown;
    }>;
  }): void;
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

type WorkerAction =
  | "lookup-session"
  | "lookup-binding"
  | "lookup-designation"
  | "lookup-delivery"
  | "authorize"
  | "claim"
  | "post"
  | "finish"
  | "uncertain"
  | "release-user-answer";

const nativeSendInputSchema = z.strictObject({
  thread: z.string().min(1),
  message: z.string(),
  delivery: z.literal("auto"),
  all_scope: z.literal(true),
  idempotency_key: z.string().min(1),
});

const askParameters = Type.Object({
  questions: Type.Array(
    Type.Object({
      id: Type.String(),
      question: Type.String(),
      options: Type.Array(
        Type.Object({ label: Type.String(), description: Type.Optional(Type.String()) }),
      ),
      multiSelect: Type.Boolean(),
    }),
    { minItems: 1 },
  ),
});
const askInputSchema = questionPayloadSchema.shape.questions.min(1);
const askInstruction = "end your turn; the answer arrives as a message";

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
    readonly messageId: string;
    readonly input: z.infer<typeof nativeSendInputSchema>;
    readonly userAnswer: boolean;
    readonly managerTarget?: Binding;
    readonly admissionDeadline?: number;
    admissionFailure?: string;
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

  async function uncertain(
    messageId: string,
    reason: string,
    nativeKey: string,
  ): Promise<Result<DeliveryRecord>> {
    return worker(
      "uncertain",
      { messageId, reason, nativeKey },
      resultSchema(deliveryRecordSchema),
    );
  }

  const waiting = new Set<string>();
  const settledQuestions = new Set<string>();
  let pause: GoalPause | null = null;
  let userOverride = false;
  const waitSchema = z.object({
    ids: z.array(z.string()),
    settled: z.array(z.string()),
    pause: goalPauseSchema.nullable(),
    userOverride: z.boolean(),
  });
  // Serializes concurrent tool calls and native answer/cancel events, not model turns.
  let waitTail: Promise<unknown> = Promise.resolve();
  function changeWait<T>(action: () => Promise<T>): Promise<T> {
    const result = waitTail.then(action);
    waitTail = result.catch(() => undefined); // caller still receives the failure
    return result;
  }
  function publishWait(): void {
    const ids = [...waiting];
    port.appendQuestionWait({ ids, settled: [...settledQuestions], pause, userOverride });
    port.emitQuestionWait(!userOverride && ids.length > 0, userOverride ? [] : ids);
  }
  async function checkOwnership(ctx: SessionContextPort): Promise<void> {
    if (pause !== null && !(await port.ownsGoalPause(ctx, pause))) {
      pause = null;
      userOverride = true;
      publishWait();
    }
  }
  port.onGoalCheck((ctx) => changeWait(() => checkOwnership(ctx)));
  port.onUserInterrupt(() =>
    changeWait(async () => {
      // Interrupt cancels OLW's right to resume, not the durable question/answer route.
      if (waiting.size === 0) return;
      pause = null;
      userOverride = true;
      publishWait();
    }),
  );
  async function holdQuestion(id: string, ctx: SessionContextPort): Promise<void> {
    await changeWait(async () => {
      if (waiting.has(id) || settledQuestions.has(id)) return;
      await checkOwnership(ctx);
      if (waiting.size === 0 && !userOverride) {
        const acquired = await port.pauseGoal(ctx);
        if (acquired === false) userOverride = true;
        else pause = acquired;
      }
      waiting.add(id);
      publishWait();
    });
  }
  async function releaseQuestion(
    id: string,
    ctx: SessionContextPort,
    settled = true,
  ): Promise<void> {
    await changeWait(async () => {
      if (!waiting.has(id)) return;
      await checkOwnership(ctx);
      waiting.delete(id);
      if (settled) settledQuestions.add(id);
      if (waiting.size === 0 && pause !== null) {
        await port.resumeGoal(ctx, pause, () => {
          userOverride = true;
        });
        pause = null;
      }
      publishWait();
    });
  }
  port.handleRpc("omo.initiative.cancel-question", async (data) => {
    const ctx = await contextWhenStarted();
    if (!ctx) return failure("session_unavailable", "Session has not started");
    const requested = z.strictObject({ questionId: z.string().min(1) }).safeParse(data);
    if (!requested.success) return failure("invalid_question", "Question id is required");
    if (!waiting.has(requested.data.questionId) && !settledQuestions.has(requested.data.questionId))
      return failure("question_unknown", "This session is not waiting on that question");
    await releaseQuestion(requested.data.questionId, ctx);
    return { ok: true, value: { questionId: requested.data.questionId, cancelled: true } };
  });
  port.onMessageStart(async (message, ctx) => {
    const incoming = z
      .object({
        role: z.literal("user"),
        content: z.union([
          z.string(),
          z.array(z.object({ type: z.string(), text: z.string().optional() })),
        ]),
      })
      .safeParse(message);
    if (!incoming.success) return;
    const text =
      typeof incoming.data.content === "string"
        ? incoming.data.content
        : incoming.data.content
            .filter((part) => part.type === "text")
            .map((part) => part.text ?? "")
            .join("");
    let decoded: unknown;
    try {
      decoded = JSON.parse(text);
    } catch {
      return;
    }
    const answer = envelopeSchema.safeParse(decoded);
    if (
      !answer.success ||
      answer.data.kind !== "answer" ||
      !answer.data.answer ||
      !waiting.has(answer.data.answer.questionId)
    )
      return;
    const stored = await worker(
      "lookup-delivery",
      { messageId: answer.data.id },
      resultSchema(deliveryRecordSchema),
    );
    if (!stored.ok) throw new Error(`${stored.error.code}: ${stored.error.message}`);
    // The native message event may precede the sender's finish receipt. A rejected
    // or uncertain ledger row, or text read via a tool, is never an answer signal.
    if (
      (stored.value.state === "sending" || stored.value.state === "accepted") &&
      JSON.stringify(stored.value.envelope) === JSON.stringify(answer.data)
    ) {
      await releaseQuestion(answer.data.answer.questionId, ctx);
    }
  });

  let askRegistered = false;
  port.onResourcesDiscover(() => ({
    skillPaths: ["define", "plan", "run", "check"].map((name) => join(config.root, "skills", name)),
  }));

  port.onSessionStart(async (ctx) => {
    const binding = await lookup(ctx.sessionManager.getSessionId());
    if (binding.ok && binding.value.assignment.role !== "manager" && config.hostRuntime)
      ctx.disableModelFallbackForSession();
    if (binding.ok && config.hostRuntime) {
      waiting.clear();
      settledQuestions.clear();
      pause = null;
      userOverride = false;
      const saved = ctx.sessionManager
        .getBranch()
        .findLast((entry) => entry.customType === "olw-question-wait");
      if (saved !== undefined) {
        const state = waitSchema.parse(saved.data);
        for (const id of state.ids) waiting.add(id);
        for (const id of state.settled) settledQuestions.add(id);
        pause = state.pause;
        userOverride = state.userOverride;
      }
      await checkOwnership(ctx);
      port.emitQuestionWait(!userOverride && waiting.size > 0, userOverride ? [] : [...waiting]);
    }
    if (
      binding.ok &&
      (binding.value.assignment.role === "child" || binding.value.assignment.role === "parent") &&
      !askRegistered
    ) {
      port.registerTool({
        name: "olw_ask",
        label: "Ask OLW owner",
        description:
          "Route questions to the OLW owner or user inbox. End your turn; the answer arrives as a message.",
        parameters: askParameters,
        execute: async (toolCallId, params, toolCtx) => {
          const result = await ask(toolCallId, params, toolCtx);
          const details = result.ok
            ? {
                ok: true,
                id: result.value.record.envelope.id,
                state: result.value.record.state,
                disposition: result.value.disposition,
                instruction: askInstruction,
              }
            : result;
          return { content: [{ type: "text", text: JSON.stringify(details) }], details };
        },
      });
      askRegistered = true;
    }
    currentContext = ctx;
    sessionStarted.resolve();
    if (config.hostRuntime || ctx.mode !== "tui") return;
    const sessionPath = ctx.sessionManager.getSessionFile();
    if (sessionPath === undefined) return;
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
      extensionProtocol: 2,
    };
    return { ok: true, value: identity };
  });

  async function ask(
    toolCallId: string,
    params: unknown,
    ctx: SessionContextPort,
  ): Promise<Result<{ record: DeliveryRecord; disposition: "new" | "replay" }>> {
    const questions = z.strictObject({ questions: askInputSchema }).safeParse(params);
    if (!questions.success)
      return failure("invalid_question", "Questions are invalid", questions.error.issues);
    const sender = await lookup(ctx.sessionManager.getSessionId());
    if (!sender.ok) return sender;
    if (sender.value.assignment.role !== "child" && sender.value.assignment.role !== "parent")
      return failure("route_denied", "Only children and parents ask questions");
    const messageId = `question:${sender.value.id}:${toolCallId}`;
    const existing = await worker(
      "lookup-delivery",
      { messageId },
      resultSchema(deliveryRecordSchema),
    );
    if (!existing.ok && existing.error.code !== "not_found") return existing;
    const ownerId = sender.value.assignment.ownerBindingId;
    const owner =
      ownerId === null
        ? null
        : await worker("lookup-binding", { bindingId: ownerId }, resultSchema(bindingSchema));
    if (owner !== null && !owner.ok && owner.error.code !== "not_found") return owner;
    const targetId = questionRecipient(
      sender.value.assignment.role,
      existing.ok ? existing.value : null,
      owner?.ok ? owner.value : null,
    );
    if (targetId === null && sender.value.assignment.role === "child")
      return failure("not_ready", "Child's parent is not ready");
    const designation = await worker<Designation>(
      "lookup-designation",
      { designationId: sender.value.designationId },
      resultSchema(designationSchema),
    );
    if (!designation.ok) return designation;
    const envelope: Envelope = {
      version: 1,
      id: messageId,
      fromBindingId: sender.value.id,
      toBindingId: targetId,
      designationId: sender.value.designationId,
      snapshotDigest: designation.value.snapshotDigest,
      kind: "question",
      text: questions.data.questions.map((question) => question.question).join("\n"),
      outcome: null,
      evidence: [],
      question: { questions: questions.data.questions, escalates: null },
    };
    if (
      existing.ok &&
      JSON.stringify(existing.value.envelope) !== JSON.stringify(envelopeSchema.parse(envelope))
    )
      return failure("message_conflict", "Message ID is bound to a different immutable payload");
    if (targetId === null) {
      if (existing.ok)
        return { ok: true, value: { record: existing.value, disposition: "replay" } };
      await holdQuestion(messageId, ctx);
      const posted = await worker(
        "post",
        { senderSessionId: ctx.sessionManager.getSessionId(), envelope },
        resultSchema(deliveryRecordSchema),
      );
      if (!posted.ok) await releaseQuestion(messageId, ctx, false);
      return posted.ok
        ? {
            ok: true,
            value: {
              record: posted.value,
              disposition: "new",
            },
          }
        : posted;
    }
    // Persist the pause before the owner can answer. Native goal startup reads
    // this paused state before external extensions restore their event channels.
    const alreadyWaiting = waiting.has(messageId);
    await holdQuestion(messageId, ctx);
    const claimed = await claimAndDeliver(envelope, ctx);
    if (!alreadyWaiting && (!claimed.ok || claimed.value.record.state === "rejected"))
      await releaseQuestion(messageId, ctx, false);
    return claimed.ok ? { ok: true, value: claimed.value } : claimed;
  }

  port.handleRpc("omo.initiative.send", async (data) => {
    const ctx = await contextWhenStarted();
    if (ctx === undefined) return failure("session_unavailable", "Session has not started");
    const envelope = envelopeSchema.safeParse(data);
    if (!envelope.success)
      return failure("invalid_envelope", "Envelope is invalid", envelope.error.issues);
    const result = await claimAndDeliver(envelope.data, ctx);
    return result.ok ? { ok: true, value: result.value.record } : result;
  });

  async function claimAndDeliver(
    envelope: Envelope,
    ctx: SessionContextPort,
  ): Promise<Result<{ record: DeliveryRecord; disposition: "new" | "replay" }>> {
    const claim = await worker(
      "claim",
      { senderSessionId: ctx.sessionManager.getSessionId(), envelope },
      resultSchema(claimResultSchema),
    );
    if (!claim.ok) return claim;
    if (claim.value.disposition === "replay")
      return { ok: true, value: { record: claim.value.record, disposition: "replay" } };
    if (claim.value.disposition === "in_progress") {
      return failure(
        "delivery_in_progress",
        "Delivery outcome is not safe to replay",
        claim.value.record,
      );
    }

    let delivered = await deliver(claim.value, ctx, false);
    if (
      envelope.kind === "answer" &&
      delivered.ok &&
      canRetryDelivery(delivered.value) &&
      !(
        delivered.value.receipt?.kind === "error" &&
        delivered.value.receipt.error.details === "idle_admission_failed"
      )
    ) {
      const successor = await worker(
        "claim",
        { senderSessionId: ctx.sessionManager.getSessionId(), envelope },
        resultSchema(claimResultSchema),
      );
      if (!successor.ok) return successor;
      if (successor.value.disposition === "new")
        delivered = await deliver(successor.value, ctx, false);
    }
    return delivered.ok
      ? { ok: true, value: { record: delivered.value, disposition: "new" } }
      : delivered;
  }

  port.handleRpc("omo.initiative.deliver-user-answer", async (data) => {
    const ctx = await contextWhenStarted();
    if (ctx === undefined) return failure("session_unavailable", "Session has not started");
    const requested = z.strictObject({ messageId: z.string().min(1) }).safeParse(data);
    if (!requested.success)
      return failure("invalid_envelope", "User answer id is invalid", requested.error.issues);
    const released = await worker(
      "release-user-answer",
      {
        messageId: requested.data.messageId,
        recipientSessionId: ctx.sessionManager.getSessionId(),
      },
      resultSchema(claimResultSchema),
    );
    if (!released.ok) return released;
    return deliver(released.value, ctx, true);
  });

  async function admitManager(target: Binding, deadline: number): Promise<void> {
    do {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("Manager idle admission deadline exceeded");
      await port.waitForIdle(target, remaining);
    } while (!port.isIdle(target));
  }

  async function deliver(
    claim: ClaimResult,
    ctx: SessionContextPort,
    userAnswer: boolean,
  ): Promise<Result<DeliveryRecord>> {
    if (claim.target === null) return { ok: true, value: claim.record };
    const envelope = claim.record.envelope;
    const nativeKey = claim.nativeKey ?? envelope.id;
    const active = new Set(port.getActiveTools());
    active.add("thread_send");
    port.setActiveTools([...active]);
    let details: unknown;
    const managerNotice =
      claim.target.assignment.role === "manager" &&
      (envelope.kind === "report" || envelope.kind === "question");
    let message = JSON.stringify(envelope);
    if (managerNotice) {
      const sender = await lookup(ctx.sessionManager.getSessionId());
      if (!sender.ok) return sender;
      const project =
        sender.value.assignment.role === "parent"
          ? sender.value.assignment.projectId
          : sender.value.id;
      const summary =
        envelope.text.split(/\r?\n/, 1)[0]?.replace(/\s+/g, " ").trim().slice(0, 100) ?? "";
      const command = envelope.kind === "report" ? "reports" : "questions";
      message = `[OLW] ${project} ${envelope.kind}: ${summary} - details: olw ${command} --project ${project}\n${message}`;
    }
    const admissionDeadline = Date.now() + 25_000;
    if (envelope.kind === "answer" || managerNotice) {
      try {
        if (managerNotice) await admitManager(claim.target, admissionDeadline);
        else await port.waitForIdle(claim.target);
      } catch (cause) {
        return worker(
          "finish",
          {
            messageId: envelope.id,
            nativeKey,
            receipt: {
              kind: "error",
              error: {
                code: "turn_conflict_before_delivery",
                details: "idle_admission_failed",
                message: `Target did not become idle before delivery: ${messageOf(cause)}`,
                next_action:
                  "Inspect the target; retry this same logical ID only after it is idle.",
              },
            },
          },
          resultSchema(deliveryRecordSchema),
        );
      }
    }
    try {
      const input = nativeSendInputSchema.parse({
        thread: claim.target.durableSessionId,
        message,
        delivery: "auto",
        all_scope: true,
        idempotency_key: nativeKey,
      });
      const executed = await dispatch.run(
        {
          senderSessionId: ctx.sessionManager.getSessionId(),
          messageId: envelope.id,
          input,
          userAnswer,
          ...(managerNotice ? { managerTarget: claim.target, admissionDeadline } : {}),
          used: false,
        },
        async () => {
          let result: { readonly details: unknown } | undefined;
          try {
            result = await port.executeTool("thread_send", input);
          } catch (cause) {
            if (dispatch.getStore()?.admissionFailure === undefined) throw cause;
            // The tool-call guard recorded proof that the native implementation never ran.
          }
          const failed = dispatch.getStore()?.admissionFailure;
          if (failed === undefined) {
            if (result === undefined) throw new Error("Native tool returned no result");
            return result;
          }
          return {
            details: {
              result: {
                kind: "error",
                error: {
                  code: "turn_conflict_before_delivery",
                  details: "idle_admission_failed",
                  message: failed,
                  next_action: "Retry this same ID after the manager is idle.",
                },
              },
            },
          };
        },
      );
      details = executed.details;
    } catch (cause) {
      return uncertain(envelope.id, `Native send did not return: ${messageOf(cause)}`, nativeKey);
    }
    const detailsResult = z.strictObject({ result: z.unknown() }).safeParse(details);
    if (!detailsResult.success)
      return uncertain(envelope.id, "Native result details were malformed", nativeKey);
    const receipt = nativeReceiptSchema.safeParse(detailsResult.data.result);
    if (!receipt.success) return uncertain(envelope.id, "Native receipt was malformed", nativeKey);
    const finished = await worker(
      "finish",
      { messageId: envelope.id, receipt: receipt.data, nativeKey },
      resultSchema(deliveryRecordSchema),
    );
    if (finished.ok) return finished;
    if (finished.error.code === "receipt_target_mismatch") {
      return uncertain(envelope.id, "Native receipt targeted a different session", nativeKey);
    }
    return finished;
  }

  port.onTurnEnd(async (message, ctx) => {
    // A forwarding failure is already this claim's uncertain outcome, not another incident.
    if (dispatch.getStore()?.senderSessionId === ctx.sessionManager.getSessionId()) return;
    if (!existsSync(dbPath)) return;
    try {
      const observation = runtimeFailureClaim(message, ctx);
      if (observation === undefined) return;
      const claim = await worker(
        "claim",
        {
          senderSessionId: ctx.sessionManager.getSessionId(),
          envelope: observation,
        },
        resultSchema(claimResultSchema),
      );
      if (!claim.ok) {
        if (claim.error.code === "not_found") return; // A native session need not be an OLW role.
        throw new Error(`${claim.error.code}: ${claim.error.message}`);
      }
      await publishOperationalNotice(config.root, claim.value.record);
      if (claim.value.disposition !== "new") return;
      const delivered = await deliver(claim.value, ctx, false);
      if (!delivered.ok) throw new Error(`${delivered.error.code}: ${delivered.error.message}`);
      const path = await publishOperationalNotice(config.root, delivered.value);
      port.notifyOperational(
        `OLW operational error ${delivered.value.envelope.id}: ${delivered.value.state}. Evidence: ${path}. This is telemetry, not a completion report or user acknowledgment.`,
        ctx,
      );
    } catch (cause) {
      // Surface notification/storage failures without throwing into the native agent loop.
      port.notifyOperational(
        `OLW operational notification failed for ${ctx.sessionManager.getSessionId()}: ${messageOf(cause)}. Inspect ${dbPath}; do not retry with a fresh ID.`,
        ctx,
      );
    }
  });

  port.onToolCall(async (toolName, input, ctx) => {
    if (
      toolName !== "thread_create" &&
      toolName !== "thread_send" &&
      toolName !== "ask_user_question" &&
      toolName !== "request_user_input"
    )
      return undefined;
    const sender = await lookup(ctx.sessionManager.getSessionId());
    if (!sender.ok && sender.error.code === "not_found") return undefined;
    if (!sender.ok) return { block: true, reason: sender.error.message };
    if (toolName === "ask_user_question" || toolName === "request_user_input") {
      return sender.value.assignment.role === "child" || sender.value.assignment.role === "parent"
        ? {
            block: true,
            reason:
              "OLW role: use olw_ask with the same questions; the answer arrives as a delivery",
          }
        : undefined;
    }
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
      const message = nativeInput.data.message;
      decoded = JSON.parse(
        message.startsWith("[OLW] ") ? message.slice(message.indexOf("\n") + 1) : message,
      );
    } catch {
      return { block: true, reason: "Direct thread_send message is not an envelope" };
    }
    const envelope = envelopeSchema.safeParse(decoded);
    if (!envelope.success || envelope.data.id !== permit.messageId) {
      return { block: true, reason: "Direct thread_send identity is invalid" };
    }
    if (permit.userAnswer) {
      const released = await worker(
        "release-user-answer",
        {
          messageId: envelope.data.id,
          recipientSessionId: ctx.sessionManager.getSessionId(),
        },
        resultSchema(claimResultSchema),
      );
      if (!released.ok) return { block: true, reason: released.error.message };
      if (
        envelope.data.fromBindingId !== null ||
        envelope.data.kind !== "answer" ||
        released.value.target === null ||
        JSON.stringify(envelope.data) !== JSON.stringify(released.value.record.envelope) ||
        nativeInput.data.thread !== released.value.target.durableSessionId
      ) {
        return { block: true, reason: "Direct thread_send identity is invalid" };
      }
      permit.used = true;
      return undefined;
    }
    if (envelope.data.fromBindingId !== sender.value.id) {
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
    if (permit.managerTarget !== undefined && permit.admissionDeadline !== undefined) {
      try {
        // All worker/preflight awaits are over. Read the live target context synchronously
        // immediately before releasing thread_send; a raced turn returns to event admission.
        while (!port.isIdle(permit.managerTarget))
          await admitManager(permit.managerTarget, permit.admissionDeadline);
      } catch (cause) {
        permit.admissionFailure = messageOf(cause);
        return { block: true, reason: permit.admissionFailure };
      }
    }
    permit.used = true;
    return undefined;
  });
}

export type DescribeReply = Result<RuntimeIdentity>;
export type SendReply = Result<DeliveryRecord>;
export type SendInput = Envelope;
