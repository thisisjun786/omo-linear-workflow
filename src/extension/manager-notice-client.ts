import { RpcClient } from "@code-yeongyu/senpi";
import { z } from "zod";
import type { Binding, DeliveryRecord, Result } from "../core/contracts";
import { deliveryRecordSchema, resultSchema } from "../core/schema";

export type ManagerNoticeDeliveryPhase = "before_request" | "request_uncertain";

export class ManagerNoticeDeliveryError extends Error {
  public override readonly name = "ManagerNoticeDeliveryError";

  public constructor(
    public readonly phase: ManagerNoticeDeliveryPhase,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface ManagerNoticeRpcClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  listSessions(): Promise<
    readonly {
      readonly status: string;
      readonly durableSessionId?: string;
      readonly sessionPath?: string;
      readonly cwd?: string;
      readonly sessionId: string;
    }[]
  >;
  openSession(options: {
    readonly sessionPath: string;
    readonly cwd: string;
    readonly retain_on_disconnect: true;
  }): Promise<{ readonly attached?: boolean; readonly sessionId: string }>;
  closeSession(sessionId: string): Promise<void>;
  requestExtension(name: string, data?: unknown): Promise<unknown>;
}

export type ManagerNoticeReply =
  | {
      readonly phase: "admission_failed";
      readonly cause: {
        readonly code: string;
        readonly message: string;
        readonly details?: unknown;
      };
    }
  | { readonly phase: "delivery_result"; readonly result: Result<DeliveryRecord> };

export const managerNoticeReplySchema: z.ZodType<ManagerNoticeReply> = z.discriminatedUnion(
  "phase",
  [
    z.strictObject({
      phase: z.literal("admission_failed"),
      cause: z.strictObject({
        code: z.string().min(1),
        message: z.string().min(1),
        details: z.unknown().optional(),
      }),
    }),
    z.strictObject({
      phase: z.literal("delivery_result"),
      result: resultSchema(deliveryRecordSchema),
    }),
  ],
);

export async function sendManagerNotice(
  target: Binding,
  request: { readonly messageId: string; readonly nativeKey: string },
  createClient: (socketPath: string) => ManagerNoticeRpcClient = (socketPath) =>
    new RpcClient({ socketPath }),
): Promise<ManagerNoticeReply> {
  if (target.sessionPath === null)
    throw new ManagerNoticeDeliveryError("before_request", "Manager has no native session path");
  const client = createClient(target.omoSocket);
  let requested = false;
  let outcome:
    | { readonly ok: true; readonly reply: ManagerNoticeReply }
    | { readonly ok: false; readonly error: ManagerNoticeDeliveryError };
  try {
    await client.start();
    const exact = (await client.listSessions()).find(
      (session) =>
        session.status === "open" &&
        session.durableSessionId === target.durableSessionId &&
        session.sessionPath === target.sessionPath &&
        session.cwd === target.cwd,
    );
    if (!exact) throw new Error("Manager native session is not open");
    const opened = await client.openSession({
      sessionPath: target.sessionPath,
      cwd: target.cwd,
      retain_on_disconnect: true,
    });
    if (opened.attached !== true || opened.sessionId !== exact.sessionId) {
      if (opened.attached === false) await client.closeSession(opened.sessionId);
      throw new Error("Manager identity changed during admission attachment");
    }
    requested = true;
    outcome = {
      ok: true,
      reply: managerNoticeReplySchema.parse(
        await client.requestExtension("omo.initiative.admit-manager-notice", request),
      ),
    };
  } catch (cause) {
    outcome = {
      ok: false,
      error: new ManagerNoticeDeliveryError(
        requested ? "request_uncertain" : "before_request",
        cause instanceof Error ? cause.message : String(cause),
        { cause },
      ),
    };
  }
  try {
    await client.stop();
  } catch (cause) {
    console.error("OLW manager notice client cleanup failed", cause);
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.reply;
}
