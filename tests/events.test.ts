import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { z } from "zod";
import type { NativeReceipt } from "../src/core/contracts";
import { modelForRole } from "../src/core/policy";
import { deliveryRecordSchema, resultSchema } from "../src/core/schema";
import { openRegistry } from "../src/core/store";
import { registerInitiativeRuntime } from "../src/extension/runtime";
import { context, envelope, fixture, Harness, value } from "./runtime-harness";

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

  test("publishes the bound TUI readiness receipt and discovers four skills", async () => {
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
      const resources = harness.resources?.();
      expect(resources?.skillPaths).toEqual(
        ["define", "plan", "run", "check"].map((name) => join(root, "skills", name)),
      );
    });
  });
});
