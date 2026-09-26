import { expect, jest, test } from "bun:test";
import {
  type AnswerIdleClient,
  AnswerIdleDeadline,
  waitForAnswerIdle,
} from "../src/extension/answer-idle";
import { fixture } from "./runtime-harness";

test.each(["idle", "deadline"] as const)(
  "answer admission is event-driven and bounded: %s",
  async (mode) =>
    fixture(async ({ child }) => {
      jest.useFakeTimers();
      const inspected = Promise.withResolvers<void>();
      let busy = true;
      let reads = 0;
      let stopped = false;
      let subscribed = false;
      let handler: ((event: { type: string }) => void) | undefined;
      const client: AnswerIdleClient = {
        start: async () => {},
        listSessions: async () => [
          {
            sessionId: "route",
            durableSessionId: child.durableSessionId,
            sessionPath: child.sessionPath ?? "",
            cwd: child.cwd,
            status: "open",
          },
        ],
        openSession: async () => ({ sessionId: "route", attached: true }),
        closeSession: async () => {},
        getState: async () => {
          expect(subscribed).toBe(true);
          reads++;
          inspected.resolve();
          return { isStreaming: busy };
        },
        onEvent: (cb) => {
          handler = cb;
          subscribed = true;
          return () => {
            subscribed = false;
          };
        },
        stop: async () => {
          stopped = true;
        },
      };
      try {
        const pending = waitForAnswerIdle(child, client, 30000).then(
          () => null,
          (error) => error,
        );
        await inspected.promise;
        if (mode === "deadline") jest.advanceTimersByTime(30000);
        else {
          busy = false;
          handler?.({ type: "agent_idle" });
        }
        const result = await pending;
        if (mode === "deadline") {
          expect(result).toBeInstanceOf(AnswerIdleDeadline);
          expect(reads).toBe(1);
        } else {
          expect(result).toBeNull();
          expect(reads).toBe(2);
        }
        expect(stopped).toBe(true);
        expect(subscribed).toBe(false);
      } finally {
        jest.useRealTimers();
      }
    }),
);
