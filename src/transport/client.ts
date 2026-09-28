import { RpcClient, type RpcClientEvent } from "@code-yeongyu/senpi";
import { z } from "zod";
import type { Binding, DeliveryRecord, Envelope, Result, RuntimeIdentity } from "../core/contracts";
import type { RoleModel } from "../core/policy";
import { envelopeSchema } from "../core/schema";
import { describeResultSchema, sendResultSchema } from "./schema";

export class NativeSessionAbsentError extends Error {
  constructor(message = "Exact durable native session is not open") {
    super(message);
    this.name = "NativeSessionAbsentError";
  }
}

export class NativeSessionNotReadyError extends Error {
  constructor(readonly status: "opening" | "closing" | "closed") {
    super(`Exact durable native session is present but ${status}`);
    this.name = "NativeSessionNotReadyError";
  }
}

export type NativeSessionProbe =
  | { readonly state: "open" }
  | { readonly state: "absent" }
  | { readonly state: "present"; readonly status: "opening" | "closing" | "closed" }
  | { readonly state: "unknown"; readonly reason: string };

export interface NativeSession {
  configure(model: RoleModel): Promise<void>;
  hasUserMessage(text: string): Promise<boolean>;
  describe(): Promise<Result<RuntimeIdentity>>;
  send(envelope: Envelope): Promise<Result<DeliveryRecord>>;
  deliverUserAnswer(messageId: string): Promise<Result<DeliveryRecord>>;
  onEvent(listener: (event: unknown) => void): () => void;
  close(): Promise<void>;
}

export interface RpcPort {
  getMessages(): Promise<readonly unknown[]>;
  setModel(provider: string, modelId: string): Promise<unknown>;
  setThinkingLevel(level: RoleModel["thinking"]): Promise<unknown>;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Emergency transport teardown for adapters whose graceful stop can stall. */
  destroy?(): void;
  closeSession(sessionId?: string): Promise<void>;
  listSessions(): Promise<
    ReadonlyArray<{
      readonly sessionId: string;
      readonly durableSessionId?: string;
      readonly sessionPath?: string;
      readonly cwd: string;
      readonly status: "opening" | "open" | "closing" | "closed";
    }>
  >;
  openSession(options: {
    readonly sessionPath?: string;
    readonly cwd?: string;
    readonly retain_on_disconnect?: boolean;
  }): Promise<{ readonly sessionId: string; readonly attached?: boolean }>;
  requestExtension(name: string, data?: unknown): Promise<unknown>;
  onEvent(listener: (event: RpcClientEvent) => void): () => void;
}

function failure<T>(code: string, message: string, details?: unknown): Result<T> {
  return details === undefined
    ? { ok: false, error: { code, message } }
    : { ok: false, error: { code, message, details } };
}

export function publicRpcClient(socketPath: string): RpcPort {
  const client = new RpcClient({ socketPath });
  return Object.assign(client, {
    destroy: () => {
      const transport = client as unknown as {
        socket?: { destroy(): void } | null;
        process?: { kill(signal: NodeJS.Signals): void } | null;
      };
      transport.socket?.destroy();
      transport.process?.kill("SIGKILL");
    },
  });
}

export async function attachBinding(binding: Binding): Promise<NativeSession> {
  return attachBindingWithClient(binding, publicRpcClient(binding.omoSocket));
}

export async function probeBindingSession(binding: Binding): Promise<NativeSessionProbe> {
  return probeBindingSessionWithClient(binding, publicRpcClient(binding.omoSocket));
}

export async function probeBindingSessionWithClient(
  binding: Binding,
  client: RpcPort,
  timeoutMs = 5_000,
  schedule: (expire: () => void, ms: number) => () => void = (expire, ms) => {
    const timer = setTimeout(expire, ms);
    return () => clearTimeout(timer);
  },
): Promise<NativeSessionProbe> {
  if (binding.sessionPath === null)
    return { state: "unknown", reason: "Binding has no observed native session path" };
  let timedOut = false;
  let cancel = () => {};
  const timeout = new Promise<never>((_resolve, reject) => {
    cancel = schedule(() => {
      timedOut = true;
      reject(new Error("Native session probe timed out"));
    }, timeoutMs);
  });
  try {
    const sessions = await Promise.race([
      (async () => {
        await client.start();
        return client.listSessions();
      })(),
      timeout,
    ]);
    const matches = sessions.filter(
      (session) =>
        session.durableSessionId === binding.durableSessionId &&
        session.sessionPath === binding.sessionPath &&
        session.cwd === binding.cwd,
    );
    if (matches.length === 0) return { state: "absent" };
    if (matches.length !== 1)
      return { state: "unknown", reason: "Multiple native sessions claim the binding" };
    const exact = matches[0];
    if (exact === undefined) return { state: "unknown", reason: "Session probe was inconsistent" };
    return exact.status === "open" ? { state: "open" } : { state: "present", status: exact.status };
  } catch (cause) {
    return {
      state: "unknown",
      reason: timedOut
        ? "Native session probe timed out"
        : cause instanceof Error
          ? cause.message
          : String(cause),
    };
  } finally {
    cancel();
    let cancelStopDeadline = () => {};
    const stopDeadline = new Promise<void>((resolve) => {
      cancelStopDeadline = schedule(() => {
        client.destroy?.();
        resolve();
      }, timeoutMs);
    });
    await Promise.race([client.stop().catch(() => {}), stopDeadline]);
    cancelStopDeadline();
  }
}

export async function attachBindingWithClient(
  binding: Binding,
  client: RpcPort,
): Promise<NativeSession> {
  if (binding.sessionPath === null) throw new Error("Binding has no observed native session path");
  await client.start();
  try {
    const sessions = await client.listSessions();
    const matches = sessions.filter(
      (session) =>
        session.durableSessionId === binding.durableSessionId &&
        session.sessionPath === binding.sessionPath &&
        session.cwd === binding.cwd,
    );
    const exact = matches[0];
    if (exact === undefined) throw new NativeSessionAbsentError();
    if (matches.length !== 1)
      throw new Error("Host must contain exactly one durable native session");
    if (exact.status !== "open") throw new NativeSessionNotReadyError(exact.status);
    const opened = await client.openSession({
      sessionPath: binding.sessionPath,
      cwd: binding.cwd,
      retain_on_disconnect: true,
    });
    if (opened.attached !== true || opened.sessionId !== exact.sessionId) {
      if (opened.attached === false) await client.closeSession(opened.sessionId);
      throw new Error("Native host did not attach the exact existing session");
    }
  } catch (cause) {
    await client.stop();
    throw cause;
  }

  return {
    async hasUserMessage(text: string): Promise<boolean> {
      const userMessage = z.object({
        role: z.literal("user"),
        content: z.union([
          z.string(),
          z.array(z.object({ type: z.string(), text: z.string().optional() })),
        ]),
      });
      return (await client.getMessages()).some((message) => {
        const parsed = userMessage.safeParse(message);
        if (!parsed.success) return false;
        return typeof parsed.data.content === "string"
          ? parsed.data.content === text
          : parsed.data.content.some((part) => part.type === "text" && part.text === text);
      });
    },
    async configure(model: RoleModel): Promise<void> {
      await client.setModel(model.provider, model.modelId);
      await client.setThinkingLevel(model.thinking);
    },
    async describe(): Promise<Result<RuntimeIdentity>> {
      const decoded = await client.requestExtension("omo.initiative.describe");
      const parsed = describeResultSchema.safeParse(decoded);
      if (!parsed.success)
        return failure(
          "invalid_response",
          "Describe RPC returned an invalid result",
          parsed.error.issues,
        );
      if (
        parsed.data.ok &&
        (parsed.data.value.durableSessionId !== binding.durableSessionId ||
          parsed.data.value.sessionPath !== binding.sessionPath ||
          parsed.data.value.cwd !== binding.cwd)
      ) {
        return failure("identity_mismatch", "Attached runtime identity does not match binding");
      }
      return parsed.data;
    },
    async send(envelope: Envelope): Promise<Result<DeliveryRecord>> {
      const valid = envelopeSchema.safeParse(envelope);
      if (!valid.success)
        return failure("invalid_envelope", "Envelope is invalid", valid.error.issues);
      const decoded = await client.requestExtension("omo.initiative.send", valid.data);
      const parsed = sendResultSchema.safeParse(decoded);
      return parsed.success
        ? parsed.data
        : failure("invalid_response", "Send RPC returned an invalid result", parsed.error.issues);
    },
    async deliverUserAnswer(messageId: string): Promise<Result<DeliveryRecord>> {
      const decoded = await client.requestExtension("omo.initiative.deliver-user-answer", {
        messageId,
      });
      const parsed = sendResultSchema.safeParse(decoded);
      return parsed.success
        ? parsed.data
        : failure(
            "invalid_response",
            "User answer RPC returned an invalid result",
            parsed.error.issues,
          );
    },
    onEvent(listener: (event: unknown) => void): () => void {
      return client.onEvent(listener);
    },
    close(): Promise<void> {
      return client.stop();
    },
  };
}
