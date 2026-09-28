import { RpcClient } from "@code-yeongyu/senpi";
import type { Binding } from "../core/contracts";
import { deliveryRecordSchema, resultSchema } from "../core/schema";

export async function sendManagerNotice(
  target: Binding,
  request: { readonly messageId: string; readonly nativeKey: string },
) {
  if (target.sessionPath === null) throw new Error("Manager has no native session path");
  const client = new RpcClient({ socketPath: target.omoSocket });
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
    return resultSchema(deliveryRecordSchema).parse(
      await client.requestExtension("omo.initiative.admit-manager-notice", request),
    );
  } finally {
    await client.stop();
  }
}
