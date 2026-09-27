import { expect, test } from "bun:test";
import { join } from "node:path";
import { z } from "zod";
import { deliveryRecordSchema, resultSchema } from "../src/core/schema";
import { openRegistry } from "../src/core/store";
import { registerInitiativeRuntime } from "../src/extension/runtime";
import { context, envelope, fixture, Harness, linkReadyManager, value } from "./runtime-harness";

test.each(["report", "question"] as const)(
  "manager %s waits for idle, sends one-line notice and preserves its envelope",
  async (kind) => {
    await fixture(async ({ root, parent, digest }) => {
      const registry = openRegistry(join(root, ".omo/state/registry.sqlite"));
      try {
        const manager = linkReadyManager(registry, parent, root);
        const harness = new Harness();
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const deadline = setTimeout(
          () => entered.reject(new Error("Idle admission was not entered")),
          2000,
        );
        harness.waitForIdle = async () => {
          entered.resolve();
          await release.promise;
        };
        harness.receipt = {
          kind: "ok",
          thread_id: manager.durableSessionId,
          message_seq: 1,
          deduplicated: false,
          delivery: { kind: "started", turn_id: "notice" },
        };
        registerInitiativeRuntime(harness, { root, hostRuntime: true });
        await harness.start()(context(parent));
        const message = {
          ...envelope(
            parent,
            manager,
            digest,
            kind === "question" ? `question:${parent.id}:notice` : "manager-report",
            kind,
          ),
          text: "completed ISSUE-1\n" + "details ".repeat(100),
          ...(kind === "question" ? { question: { questions: [], escalates: null } } : {}),
        };
        const send = harness.rpc("omo.initiative.send");
        const sending = send(message);
        try {
          await entered.promise;
          expect(harness.executeCount).toBe(0);
          expect(value(registry.delivery(message.id)).state).toBe("sending");
        } finally {
          clearTimeout(deadline);
          release.resolve();
        }
        expect(value(resultSchema(deliveryRecordSchema).parse(await sending)).state).toBe(
          "accepted",
        );
        const input = z
          .object({ message: z.string(), delivery: z.string() })
          .parse(harness.nativeInputs[0]);
        const [notice, encoded, ...extra] = input.message.split("\n");
        expect(notice?.startsWith("[OLW] ")).toBe(true);
        expect(notice?.length).toBeLessThan(240);
        expect(extra).toEqual([]);
        expect(JSON.parse(encoded ?? "null")).toEqual(message);
        expect(input.delivery).toBe("auto");
        expect(value(registry.delivery(message.id)).envelope).toEqual(message);
        if (kind === "report")
          expect(value(registry.postedReports({ projectId: "project-1" }))[0]?.envelope).toEqual(
            message,
          );
        else
          expect(value(registry.questions({ projectId: "project-1" }))[0]?.record.envelope).toEqual(
            message,
          );
        await send(message);
        expect(harness.executeCount).toBe(1);
      } finally {
        registry.close();
      }
    });
  },
);

test("manager admission rechecks synchronous idle state and waits for the next event without sending", async () => {
  await fixture(async ({ root, parent, digest }) => {
    const registry = openRegistry(join(root, ".omo/state/registry.sqlite"));
    const manager = linkReadyManager(registry, parent, root);
    const harness = new Harness();
    let idle = false;
    let waits = 0;
    const rewaiting = Promise.withResolvers<void>();
    const nextIdle = Promise.withResolvers<void>();
    Object.assign(harness, { isIdle: () => idle });
    harness.waitForIdle = async () => {
      waits++;
      if (waits > 1) {
        rewaiting.resolve();
        await nextIdle.promise;
      }
    };
    harness.receipt = {
      kind: "ok",
      thread_id: manager.durableSessionId,
      message_seq: 1,
      deduplicated: false,
      delivery: { kind: "started", turn_id: "notice" },
    };
    registerInitiativeRuntime(harness, { root, hostRuntime: true });
    await harness.start()(context(parent));
    const send = harness.rpc("omo.initiative.send")(
      envelope(parent, manager, digest, "busy-race", "report"),
    );
    const timer = setTimeout(
      () => rewaiting.reject(new Error("Did not reenter event admission")),
      2000,
    );
    try {
      await rewaiting.promise;
      expect(harness.executeCount).toBe(0);
      idle = true;
      nextIdle.resolve();
      expect(value(resultSchema(deliveryRecordSchema).parse(await send)).state).toBe("accepted");
      expect(harness.executeCount).toBe(1);
    } finally {
      clearTimeout(timer);
      nextIdle.resolve();
      registry.close();
    }
  });
});

test("preflight idle rejection remains proven pre-delivery even when executeTool throws", async () => {
  await fixture(async ({ root, parent, digest }) => {
    const registry = openRegistry(join(root, ".omo/state/registry.sqlite"));
    try {
      const manager = linkReadyManager(registry, parent, root);
      const harness = new Harness();
      let idle = true;
      harness.isIdle = () => idle;
      harness.waitForIdle = async () => {
        if (!idle) throw new Error("preflight idle deadline");
      };
      const execute = harness.executeTool.bind(harness);
      harness.executeTool = async (name, input) => {
        idle = false;
        return execute(name, input);
      };
      registerInitiativeRuntime(harness, { root, hostRuntime: true });
      await harness.start()(context(parent));
      const result = value(
        resultSchema(deliveryRecordSchema).parse(
          await harness.rpc("omo.initiative.send")(
            envelope(parent, manager, digest, "preflight-rejection", "report"),
          ),
        ),
      );
      expect(result.state).toBe("rejected");
      expect(result.receipt).toMatchObject({
        kind: "error",
        error: { code: "turn_conflict_before_delivery" },
      });
      expect(harness.executeCount).toBe(0);
    } finally {
      registry.close();
    }
  });
});

test("manager idle rejection permits same-ID retry; uncertain never resends", async () => {
  await fixture(async ({ root, parent, digest }) => {
    const registry = openRegistry(join(root, ".omo/state/registry.sqlite"));
    try {
      const manager = linkReadyManager(registry, parent, root);
      const harness = new Harness();
      harness.waitForIdle = async () => {
        throw new Error("bounded admission deadline");
      };
      registerInitiativeRuntime(harness, { root, hostRuntime: true });
      await harness.start()(context(parent));
      const send = harness.rpc("omo.initiative.send");
      const message = envelope(parent, manager, digest, "retry-report", "report");
      expect(value(resultSchema(deliveryRecordSchema).parse(await send(message))).state).toBe(
        "rejected",
      );
      expect(harness.executeCount).toBe(0);
      harness.waitForIdle = async () => {};
      harness.receipt = { malformed: true };
      const uncertain = value(resultSchema(deliveryRecordSchema).parse(await send(message)));
      expect(uncertain.state).toBe("uncertain");
      expect(uncertain.attempts).toHaveLength(2);
      await send(message);
      expect(harness.executeCount).toBe(1);
    } finally {
      registry.close();
    }
  });
});
