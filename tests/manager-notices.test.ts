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
        expect(input.delivery).toBe("follow_up");
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
