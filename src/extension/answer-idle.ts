import { RpcClient } from "@code-yeongyu/senpi";
import type { Binding } from "../core/contracts";

export interface AnswerIdleClient {
  start(): Promise<void>;
  listSessions(): Promise<
    ReadonlyArray<{
      sessionId: string;
      durableSessionId?: string;
      sessionPath?: string;
      cwd: string;
      status: string;
    }>
  >;
  openSession(options: {
    sessionPath: string;
    cwd: string;
    retain_on_disconnect: boolean;
  }): Promise<{ sessionId: string; attached?: boolean }>;
  closeSession(sessionId?: string): Promise<void>;
  getState(): Promise<{ isStreaming: boolean }>;
  onEvent(handler: (event: { type: string }) => void): () => void;
  stop(): Promise<void>;
}
export class AnswerIdleDeadline extends Error {}
export async function waitForAnswerIdle(
  target: Binding,
  client: AnswerIdleClient = new RpcClient({ socketPath: target.omoSocket }),
  timeoutMs = 30_000,
): Promise<void> {
  if (!target.sessionPath) throw new Error("Answer target has no native session path");
  let stop: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await client.start();
    const exact = (await client.listSessions()).find(
      (s) =>
        s.status === "open" &&
        s.durableSessionId === target.durableSessionId &&
        s.sessionPath === target.sessionPath &&
        s.cwd === target.cwd,
    );
    if (!exact) throw new Error("Answer target is not an existing native session");
    const opened = await client.openSession({
      sessionPath: target.sessionPath,
      cwd: target.cwd,
      retain_on_disconnect: true,
    });
    if (opened.attached !== true || opened.sessionId !== exact.sessionId) {
      if (opened.attached === false) await client.closeSession(opened.sessionId);
      throw new Error("Answer target identity changed during attachment");
    }
    const idle = Promise.withResolvers<void>();
    let done = false;
    const inspect = () => {
      if (done) return;
      void client.getState().then((state) => {
        if (!state.isStreaming) idle.resolve();
      }, idle.reject);
    };
    stop = client.onEvent((event) => {
      if (
        event.type === "agent_end" ||
        event.type === "agent_idle" ||
        event.type === "agent_settled"
      )
        inspect();
    });
    timer = setTimeout(
      () => idle.reject(new AnswerIdleDeadline("Answer target idle deadline exceeded")),
      timeoutMs,
    );
    inspect();
    try {
      await idle.promise;
    } finally {
      done = true;
    }
  } finally {
    clearTimeout(timer);
    stop?.();
    await client.stop();
  }
}
