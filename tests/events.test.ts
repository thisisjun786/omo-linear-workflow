import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { z } from "zod";
import type { Binding, NativeReceipt, ScopeSnapshot } from "../src/core/contracts";
import { modelForRole } from "../src/core/policy";
import { deliveryRecordSchema, resultSchema } from "../src/core/schema";
import { openRegistry } from "../src/core/store";
import { registerInitiativeRuntime } from "../src/extension/runtime";
import { context, envelope, fixture, Harness, linkReadyManager, value } from "./runtime-harness";

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
  test("only bound host roles disable model fallback for their own session", async () => {
    await fixture(async ({ root, supervisor, parent, child }) => {
      for (const binding of [supervisor, parent, child]) {
        const harness = new Harness();
        let disabled = 0;
        const ctx = Object.assign(context(binding), {
          disableModelFallbackForSession: () => {
            disabled += 1;
          },
        });
        registerInitiativeRuntime(harness, { root, hostRuntime: true });
        await harness.start()(ctx);
        expect(disabled).toBe(1);
        registerInitiativeRuntime(harness, { root, hostRuntime: true });
        await harness.start()(ctx);
        expect(disabled).toBe(2);
      }
      for (const [hostRuntime, binding] of [
        [false, parent],
        [true, { ...parent, durableSessionId: "internal-workflow-worker" }],
      ] as const) {
        const harness = new Harness();
        let disabled = 0;
        registerInitiativeRuntime(harness, { root, hostRuntime });
        await harness.start()(
          Object.assign(context(binding), {
            disableModelFallbackForSession: () => {
              disabled += 1;
            },
          }),
        );
        expect(disabled).toBe(0);
      }
    });
  });
  test("describes a live role when RPC arrives before session_start after reload", async () => {
    await fixture(async ({ root, parent }) => {
      const harness = new Harness();
      registerInitiativeRuntime(harness, { root, hostRuntime: true });
      await harness.start()(context(parent));
      registerInitiativeRuntime(harness, { root, hostRuntime: true });

      const pending = harness.rpc("omo.initiative.describe")(undefined);
      await harness.start()(context(parent));

      expect(await pending).toEqual({
        ok: true,
        value: {
          durableSessionId: parent.durableSessionId,
          sessionPath: parent.sessionPath,
          cwd: parent.cwd,
          ...modelForRole("parent"),
          extensionProtocol: 2,
        },
      });
    });
  });

  test("delivers once when RPC arrives before session_start after reload", async () => {
    await fixture(async ({ root, supervisor, parent, digest }) => {
      const harness = new Harness();
      registerInitiativeRuntime(harness, { root, hostRuntime: true });
      await harness.start()(context(supervisor));
      registerInitiativeRuntime(harness, { root, hostRuntime: true });

      const pending = harness.rpc("omo.initiative.send")(
        envelope(supervisor, parent, digest, "reload-message"),
      );
      await harness.start()(context(supervisor));

      expect(resultState(await pending)).toBe("accepted");
      expect(harness.executeCount).toBe(1);
    });
  });

  test("activates thread_send, persists acceptance, and replays without a native resend", async () => {
    await fixture(async ({ root, supervisor, parent, digest }) => {
      const harness = new Harness();
      registerInitiativeRuntime(harness, { root, hostRuntime: true });
      await harness.start()(context(supervisor));
      const send = harness.rpc("omo.initiative.send");
      const message = envelope(supervisor, parent, digest, "message-1");
      expect(resultState(await send(message))).toBe("accepted");
      expect(z.object({ delivery: z.string() }).parse(harness.nativeInputs[0]).delivery).toBe(
        "follow_up",
      );
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

  test("same-ID recovery crosses the real worker boundary with one new native key", async () => {
    await fixture(async ({ root, supervisor, parent, digest }) => {
      const harness = new Harness();
      registerInitiativeRuntime(harness, { root, hostRuntime: false });
      await harness.start()(context(supervisor));
      const message = envelope(supervisor, parent, digest, "recovery");
      const send = harness.rpc("omo.initiative.send");
      const rejected: NativeReceipt = {
        kind: "error",
        error: { code: "turn_conflict_before_delivery", message: "fixture", next_action: "retry" },
      };
      harness.receipt = rejected;
      const first = value(resultSchema(deliveryRecordSchema).parse(await send(message)));
      expect(first.state).toBe("rejected");
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      harness.afterNative = () => {
        entered.resolve();
        return release.promise;
      };
      harness.receipt = {
        kind: "ok",
        thread_id: parent.durableSessionId,
        message_seq: 2,
        deduplicated: false,
        delivery: { kind: "started", turn_id: "work" },
      };
      const sending = send(message);
      try {
        await entered.promise;
        expect(await send(message)).toMatchObject({
          ok: false,
          error: { code: "delivery_in_progress" },
        });
        expect(harness.executeCount).toBe(2);
      } finally {
        release.resolve();
      }
      const recovered = value(resultSchema(deliveryRecordSchema).parse(await sending));
      expect(recovered.state).toBe("accepted");
      expect(recovered.attempts).toMatchObject([
        { number: 1, receipt: rejected },
        { number: 2, state: "accepted" },
      ]);
      const inputs = harness.nativeInputs.map((input) =>
        z.object({ message: z.string(), idempotency_key: z.string() }).parse(input),
      );
      expect(inputs[0]?.message).toBe(inputs[1]?.message);
      expect(inputs[0]?.idempotency_key).toBe(message.id);
      expect(inputs[1]?.idempotency_key).not.toBe(message.id);
      expect(value(resultSchema(deliveryRecordSchema).parse(await send(message)))).toEqual(
        recovered,
      );
      expect(harness.executeCount).toBe(2);
      const registry = openRegistry(join(root, ".omo/state/registry.sqlite"));
      try {
        expect(registry.delivery(message.id)).toEqual({ ok: true, value: recovered });
      } finally {
        registry.close();
      }
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

  test("routes bound role questions with stable IDs, replay and actual delivery outcomes", async () => {
    await fixture(async ({ root, child, parent }) => {
      const harness = new Harness();
      registerInitiativeRuntime(harness, { root, hostRuntime: true });
      await harness.start()(context(child));
      const questions = {
        questions: [
          {
            id: "choice",
            question: "Choose?",
            options: [{ label: "Yes", description: "Proceed" }],
            multiSelect: false,
          },
        ],
      };
      for (const name of ["request_user_input", "ask_user_question"]) {
        expect(await harness.guard()(name, questions, context(child))).toEqual({
          block: true,
          reason: "OLW role: use olw_ask with the same questions; the answer arrives as a delivery",
        });
        expect(await harness.guard()(name, questions, context(parent))).toMatchObject({
          block: true,
        });
      }
      expect(harness.tools.has("olw_ask")).toBe(true);
      harness.receipt = {
        kind: "ok",
        thread_id: parent.durableSessionId,
        message_seq: 1,
        deduplicated: false,
        delivery: { kind: "started", turn_id: "turn" },
      };
      const first = await harness.callTool("olw_ask", "call-1", questions);
      expect(first).toMatchObject({
        state: "accepted",
        disposition: "new",
        id: `question:${child.id}:call-1`,
        instruction: "end your turn; the answer arrives as a message",
      });
      expect(await harness.callTool("olw_ask", "call-1", questions)).toMatchObject({
        state: "accepted",
        disposition: "replay",
      });
      expect(harness.executeCount).toBe(1);
      harness.receipt = {
        kind: "error",
        error: { code: "recipient_closed", message: "closed", next_action: "inspect" },
      };
      expect(await harness.callTool("olw_ask", "call-2", questions)).toMatchObject({
        state: "rejected",
        id: `question:${child.id}:call-2`,
      });
      const registry = openRegistry(join(root, ".omo/state/registry.sqlite"));
      try {
        value(registry.setContactState(parent.id, "paused"));
      } finally {
        registry.close();
      }
      expect(await harness.callTool("olw_ask", "call-3", questions)).toMatchObject({
        ok: false,
        error: { code: "contact_paused" },
      });
      expect(harness.executeCount).toBe(2);
    });
  });

  test("posts parent questions without a ready owner; manager and unbound sessions are untouched", async () => {
    await fixture(async ({ root, parent, supervisor }) => {
      const registry = openRegistry(join(root, ".omo/state/registry.sqlite"));
      try {
        value(registry.beginClose(supervisor.id));
        value(registry.finishClose(supervisor.id));
      } finally {
        registry.close();
      }
      const harness = new Harness();
      registerInitiativeRuntime(harness, { root, hostRuntime: true });
      await harness.start()(context(parent));
      const questions = {
        questions: [
          { id: "q", question: "Decision?", options: [{ label: "Yes" }], multiSelect: false },
        ],
      };
      expect(await harness.callTool("olw_ask", "parent-call", questions)).toMatchObject({
        state: "posted",
        id: `question:${parent.id}:parent-call`,
      });
      expect(harness.executeCount).toBe(0);
      expect(await harness.callTool("olw_ask", "parent-call", questions)).toMatchObject({
        state: "posted",
        disposition: "replay",
      });
      const unbound = context({ ...parent, durableSessionId: "unbound" });
      for (const name of ["request_user_input", "ask_user_question"])
        expect(await harness.guard()(name, {}, unbound)).toBeUndefined();
    });
  });

  test("posts a new parent question when its linked manager is paused and preserves replay", async () => {
    await fixture(async ({ root, parent }) => {
      const registry = openRegistry(join(root, ".omo/state/registry.sqlite"));
      try {
        const manager = linkReadyManager(registry, parent, root);
        value(registry.setContactState(manager.id, "paused"));
      } finally {
        registry.close();
      }
      const harness = new Harness();
      registerInitiativeRuntime(harness, { root, hostRuntime: true });
      await harness.start()(context(parent));
      const questions = {
        questions: [
          { id: "q", question: "Which way?", options: [{ label: "Yes" }], multiSelect: false },
        ],
      };
      expect(await harness.callTool("olw_ask", "paused-manager", questions)).toMatchObject({
        state: "posted",
        disposition: "new",
        id: `question:${parent.id}:paused-manager`,
      });
      expect(harness.executeCount).toBe(0);
      expect(await harness.callTool("olw_ask", "paused-manager", questions)).toMatchObject({
        state: "posted",
        disposition: "replay",
      });
      expect(harness.executeCount).toBe(0);
      const inbox = openRegistry(join(root, ".omo/state/registry.sqlite"));
      try {
        expect(value(inbox.postedQuestions({}))).toMatchObject([
          {
            record: {
              state: "posted",
              envelope: {
                id: `question:${parent.id}:paused-manager`,
                toBindingId: null,
              },
            },
            answered: false,
          },
        ]);
        value(inbox.setContactState("manager", "active"));
      } finally {
        inbox.close();
      }
      harness.receipt = {
        kind: "ok",
        thread_id: "session-manager",
        message_seq: 1,
        deduplicated: false,
        delivery: { kind: "started", turn_id: "turn" },
      };
      expect(await harness.callTool("olw_ask", "ready-manager", questions)).toMatchObject({
        state: "accepted",
        disposition: "new",
        id: `question:${parent.id}:ready-manager`,
      });
      expect(harness.executeCount).toBe(1);
    });
  });

  test("posts standalone parent's question to the user inbox", async () => {
    await fixture(async ({ root, parent }) => {
      const registry = openRegistry(join(root, ".omo/state/registry.sqlite"));
      try {
        value(registry.setOwner(parent.id, null));
      } finally {
        registry.close();
      }
      const harness = new Harness();
      registerInitiativeRuntime(harness, { root, hostRuntime: true });
      await harness.start()(context(parent));
      const result = await harness.callTool("olw_ask", "standalone-call", {
        questions: [
          { id: "q", question: "Which way?", options: [{ label: "Yes" }], multiSelect: false },
        ],
      });
      expect(result).toMatchObject({
        state: "posted",
        id: `question:${parent.id}:standalone-call`,
      });
      expect(harness.executeCount).toBe(0);
      const inbox = openRegistry(join(root, ".omo/state/registry.sqlite"));
      try {
        expect(value(inbox.postedQuestions({}))).toMatchObject([
          {
            record: {
              state: "posted",
              envelope: { id: `question:${parent.id}:standalone-call`, toBindingId: null },
            },
            answered: false,
          },
        ]);
      } finally {
        inbox.close();
      }
    });
  });

  test("manager does not intercept native asks or register olw_ask", async () => {
    await fixture(async ({ root }) => {
      const registry = openRegistry(join(root, ".omo/state/registry.sqlite"));
      let manager: Binding;
      try {
        const snapshot: ScopeSnapshot = {
          version: 1,
          source: "linear-export",
          initiative: null,
          projects: [],
          decisionRefs: [],
        };
        const digest = value(registry.importScope(snapshot)).digest;
        manager = value(
          registry.reserve({
            bindingId: "manager",
            durableSessionId: "session-manager",
            designation: {
              id: "manager-designation",
              snapshotDigest: digest,
              designatedBy: "test",
              designatedAt: "today",
              execute: true,
              create: true,
              contact: true,
            },
            snapshot,
            assignment: { role: "manager" },
            cwd: "/repo/manager",
            checkout: null,
            herdrSocket: join(root, "herdr.sock"),
            omoSocket: join(root, "omo.sock"),
          }),
        );
      } finally {
        registry.close();
      }
      const harness = new Harness();
      registerInitiativeRuntime(harness, { root, hostRuntime: true });
      for (const name of ["request_user_input", "ask_user_question"])
        expect(await harness.guard()(name, {}, context(manager))).toBeUndefined();
      await harness.start()(context(manager));
      expect(harness.tools.has("olw_ask")).toBe(false);
    });
  });

  test("publishes TUI readiness without duplicating Senpi's Herdr session report", async () => {
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
      expect(harness.reports).toEqual([]);
      const resources = harness.resources?.();
      expect(resources?.skillPaths).toEqual(
        ["define", "plan", "run", "check"].map((name) => join(root, "skills", name)),
      );
    });
  });
});
