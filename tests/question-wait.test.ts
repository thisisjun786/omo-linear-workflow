import { expect, test } from "bun:test";
import { join } from "node:path";
import type { Envelope } from "../src/core/contracts";
import { openRegistry } from "../src/core/store";
import { AnswerIdleDeadline } from "../src/extension/answer-idle";
import { registerInitiativeRuntime } from "../src/extension/runtime";
import { context, fixture, Harness, value } from "./runtime-harness";

const questions = {
  questions: [
    { id: "choice", question: "Choose?", options: [{ label: "yes" }], multiSelect: false },
  ],
};

test("asked question parks the packet goal through reload; only native answer delivery releases it", async () => {
  await fixture(async ({ root, child, parent, digest }) => {
    const h = new Harness();
    const ctx = context(child);
    ctx.sessionManager.getBranch = () => h.entries;
    registerInitiativeRuntime(h, { root, hostRuntime: true });
    await h.start()(ctx);
    await h.callTool("olw_ask", "waiting", questions);
    expect(h.goal?.status).toBe("paused");
    expect(h.waitEvents.at(-1)).toEqual({ active: true, ids: ["question:child:waiting"] });
    const answer: Envelope = {
      version: 1,
      id: "answer:question:child:waiting",
      fromBindingId: parent.id,
      toBindingId: child.id,
      designationId: parent.designationId,
      snapshotDigest: digest,
      kind: "answer",
      text: "yes",
      outcome: null,
      evidence: [],
      answer: {
        questionId: "question:child:waiting",
        answers: { choice: { selected: ["yes"] } },
        unanswered: [],
      },
    };
    const r = openRegistry(join(root, ".omo/state/registry.sqlite"));
    try {
      value(r.claim(parent.durableSessionId, answer));
      value(
        r.finish(answer.id, {
          kind: "error",
          error: { code: "turn_conflict_before_delivery", message: "busy", next_action: "inspect" },
        }),
      );
      expect(value(r.questions({}))[0]?.answered).toBe(false);
      const reload = new Harness();
      reload.goal = h.goal;
      reload.entries.push(...h.entries);
      const resumedCtx = context(child);
      resumedCtx.sessionManager.getBranch = () => reload.entries;
      registerInitiativeRuntime(reload, { root, hostRuntime: true });
      await reload.start()(resumedCtx);
      expect(reload.goal?.status).toBe("paused");
      expect(reload.waitEvents.at(-1)).toEqual({ active: true, ids: ["question:child:waiting"] });
      await reload.messageStart?.({ role: "user", content: JSON.stringify(answer) }, resumedCtx);
      expect(reload.goal?.status).toBe("paused");
      const claim = value(r.claim(parent.durableSessionId, answer));
      // Native message_start can precede the sender's finish receipt.
      await reload.messageStart?.({ role: "user", content: JSON.stringify(answer) }, resumedCtx);
      expect(reload.goal?.status).toBe("active");
      expect(reload.waitEvents.at(-1)).toEqual({ active: false, ids: [] });
      value(
        r.finish(
          answer.id,
          {
            kind: "ok",
            thread_id: child.durableSessionId,
            message_seq: 2,
            deduplicated: false,
            delivery: { kind: "started", turn_id: "answer" },
          },
          claim.nativeKey,
        ),
      );
      expect(value(r.questions({}))[0]?.answered).toBe(true);
      const resumes = reload.resumeCalls;
      const events = reload.waitEvents.length;
      await reload.messageStart?.({ role: "user", content: JSON.stringify(answer) }, resumedCtx);
      await reload.callTool("olw_ask", "waiting", questions);
      expect(reload.resumeCalls).toBe(resumes);
      expect(reload.waitEvents).toHaveLength(events);
      expect(reload.goal?.status).toBe("active");
    } finally {
      r.close();
    }
  });
});

test("failed ask does not strand a goal; accepted question replay never creates another wait or send", async () => {
  await fixture(async ({ root, child }) => {
    const h = new Harness();
    registerInitiativeRuntime(h, { root, hostRuntime: true });
    await h.start()(context(child));
    h.receipt = {
      kind: "error",
      error: { code: "recipient_closed", message: "closed", next_action: "inspect" },
    };
    await h.callTool("olw_ask", "failed", questions);
    expect(h.goal?.status).toBe("active");
    h.receipt = {
      kind: "ok",
      thread_id: "session-parent",
      message_seq: 1,
      deduplicated: false,
      delivery: { kind: "started", turn_id: "q" },
    };
    await h.callTool("olw_ask", "ok", questions);
    const count = h.executeCount;
    await h.callTool("olw_ask", "ok", questions);
    expect(h.executeCount).toBe(count);
    expect(h.goal?.status).toBe("paused");
    expect(h.waitEvents.at(-1)).toEqual({ active: true, ids: ["question:child:ok"] });
  });
});

test("retrying a proven rejected question reestablishes the wait under the same ID", async () =>
  fixture(async ({ root, child }) => {
    const h = new Harness();
    registerInitiativeRuntime(h, { root, hostRuntime: true });
    await h.start()(context(child));
    h.receipt = {
      kind: "error",
      error: { code: "turn_conflict_before_delivery", message: "busy", next_action: "inspect" },
    };
    await h.callTool("olw_ask", "retry", questions);
    expect(h.goal?.status).toBe("active");
    h.receipt = {
      kind: "ok",
      thread_id: "session-parent",
      message_seq: 1,
      deduplicated: false,
      delivery: { kind: "started", turn_id: "q" },
    };
    await h.callTool("olw_ask", "retry", questions);
    expect(h.goal?.status).toBe("paused");
    expect(h.waitEvents.at(-1)).toEqual({ active: true, ids: ["question:child:retry"] });
  }));

test.each(["normal", "deadline", "conflict", "uncertain"] as const)(
  "two native answers release only the final wait; %s admission preserves history",
  async (mode) =>
    fixture(async ({ root, child, parent, digest }) => {
      const h = new Harness();
      const ctx = context(child);
      registerInitiativeRuntime(h, { root, hostRuntime: true });
      await h.start()(ctx);
      await Promise.all([
        h.callTool("olw_ask", "one", questions),
        h.callTool("olw_ask", "two", questions),
      ]);
      const sender = new Harness();
      registerInitiativeRuntime(sender, { root, hostRuntime: true });
      await sender.start()(context(parent));
      const r = openRegistry(join(root, ".omo/state/registry.sqlite"));
      try {
        const envelope = (id: string): Envelope => ({
          version: 1,
          id: `answer:question:child:${id}`,
          fromBindingId: parent.id,
          toBindingId: child.id,
          designationId: parent.designationId,
          snapshotDigest: digest,
          kind: "answer",
          text: "yes",
          outcome: null,
          evidence: [],
          answer: {
            questionId: `question:child:${id}`,
            answers: { choice: { selected: ["yes"] } },
            unanswered: [],
          },
        });
        sender.receipt = {
          kind: "ok",
          thread_id: child.durableSessionId,
          message_seq: 2,
          deduplicated: false,
          delivery: { kind: "started", turn_id: "answer" },
        };
        if (mode === "deadline")
          sender.waitForIdle = async () => {
            sender.idleWaits++;
            throw new AnswerIdleDeadline("deadline");
          };
        if (mode === "conflict" || mode === "uncertain") {
          const accepted = sender.receipt;
          sender.receipt = {
            kind: "error",
            error: {
              code: mode === "conflict" ? "turn_conflict_before_delivery" : "idempotency_uncertain",
              message: "race",
              next_action: "inspect",
            },
          };
          sender.afterNative = async () => {
            if (sender.executeCount === 2) sender.receipt = accepted;
          };
        }
        await sender.rpc("omo.initiative.send")(envelope("one"));
        if (mode === "deadline" || mode === "uncertain") {
          expect(sender.executeCount).toBe(mode === "deadline" ? 0 : 1);
          expect(value(r.delivery(envelope("one").id)).attempts).toHaveLength(1);
          expect(value(r.questions({})).every((q) => !q.answered)).toBe(true);
          expect(h.goal?.status).toBe("paused");
          return;
        }
        expect(sender.executeCount).toBe(mode === "conflict" ? 2 : 1);
        const count = sender.executeCount;
        await sender.rpc("omo.initiative.send")(envelope("one"));
        expect(sender.executeCount).toBe(count);
        await h.messageStart?.({ role: "user", content: JSON.stringify(envelope("one")) }, ctx);
        expect(h.goal?.status).toBe("paused");
        await sender.rpc("omo.initiative.send")(envelope("two"));
        await h.messageStart?.({ role: "user", content: JSON.stringify(envelope("two")) }, ctx);
        expect(h.goal?.status).toBe("active");
        expect(h.resumeCalls).toBe(1);
        expect(h.pauseCalls).toBe(1);
      } finally {
        r.close();
      }
    }),
);

test("simultaneous asks share one pause; cancellation and replay do not strand or double-resume it", async () =>
  fixture(async ({ root, child }) => {
    const h = new Harness();
    const ctx = context(child);
    registerInitiativeRuntime(h, { root, hostRuntime: true });
    await h.start()(ctx);
    await Promise.all([
      h.callTool("olw_ask", "one", questions),
      h.callTool("olw_ask", "two", questions),
    ]);
    expect(h.goal?.status).toBe("paused");
    expect(h.pauseCalls).toBe(1);
    expect(
      await h.rpc("omo.initiative.cancel-question")({ questionId: "question:child:one" }),
    ).toMatchObject({ ok: true });
    expect(h.goal?.status).toBe("paused");
    await h.rpc("omo.initiative.cancel-question")({ questionId: "question:child:two" });
    expect(h.goal?.status).toBe("active");
    expect(h.resumeCalls).toBe(1);
    await h.callTool("olw_ask", "one", questions);
    expect(h.goal?.status).toBe("active");
    expect(h.pauseCalls).toBe(1);
  }));

test.each(["interrupt", "resume"] as const)(
  "user %s wins over question pause across further asks and reload",
  async (action) =>
    fixture(async ({ root, child }) => {
      const h = new Harness();
      const ctx = context(child);
      ctx.sessionManager.getBranch = () => h.entries;
      registerInitiativeRuntime(h, { root, hostRuntime: true });
      await h.start()(ctx);
      await h.callTool("olw_ask", "one", questions);
      if (action === "interrupt") await h.userInterrupt?.(ctx);
      else {
        if (h.goal) {
          h.goal.status = "active";
          h.goal.updatedAt++;
        }
        await h.goalCheck?.(ctx);
      }
      expect(h.waitEvents.at(-1)).toMatchObject({ active: false });
      await h.callTool("olw_ask", "two", questions);
      expect(h.pauseCalls).toBe(1);
      await h.start()(ctx);
      expect(h.waitEvents.at(-1)).toMatchObject({ active: false });
      await h.rpc("omo.initiative.cancel-question")({ questionId: "question:child:one" });
      await h.rpc("omo.initiative.cancel-question")({ questionId: "question:child:two" });
      expect(h.resumeCalls).toBe(0);
    }),
);
