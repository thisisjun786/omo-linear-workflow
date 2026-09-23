import { RpcClient, type RpcClientEvent } from "@code-yeongyu/senpi";
import { z } from "zod";
import type { Binding, DeliveryRecord, Envelope, Result, RuntimeIdentity } from "../core/contracts";
import type { RoleModel } from "../core/policy";
import { envelopeSchema } from "../core/schema";
import { describeResultSchema, sendResultSchema } from "./schema";

export interface NativeSession {
  configure(model: RoleModel): Promise<void>;
  hasUserMessage(text: string): Promise<boolean>;
  describe(): Promise<Result<RuntimeIdentity>>;
  send(envelope: Envelope): Promise<Result<DeliveryRecord>>;
  onEvent(listener: (event: unknown) => void): () => void;
  close(): Promise<void>;
}

export interface RpcPort {
  getMessages(): Promise<readonly unknown[]>;
  setModel(provider: string, modelId: string): Promise<unknown>;
  setThinkingLevel(level: RoleModel["thinking"]): Promise<unknown>;
  start(): Promise<void>;
  stop(): Promise<void>;
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
  return new RpcClient({ socketPath });
}

export async function attachBinding(binding: Binding): Promise<NativeSession> {
  return attachBindingWithClient(binding, publicRpcClient(binding.omoSocket));
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
        session.status === "open" &&
        session.durableSessionId === binding.durableSessionId &&
        session.sessionPath === binding.sessionPath &&
        session.cwd === binding.cwd,
    );
    const exact = matches[0];
    if (exact === undefined) throw new Error("Exact durable native session is not open");
    if (matches.length !== 1)
      throw new Error("Host must contain exactly one durable native session");
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
    onEvent(listener: (event: unknown) => void): () => void {
      return client.onEvent(listener);
    },
    close(): Promise<void> {
      return client.stop();
    },
  };
}
