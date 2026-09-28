import { expect, test } from "bun:test";
import { join } from "node:path";
import { deliveryRecordSchema, resultSchema } from "../src/core/schema";
import { openRegistry } from "../src/core/store";
import { managerNoticeReplySchema } from "../src/extension/manager-notice-client";
import { registerInitiativeRuntime } from "../src/extension/runtime";
import { context, envelope, fixture, Harness, linkReadyManager, value } from "./runtime-harness";

test.each(["idle", "busy", "race"] as const)(
  "manager owns admission without shared contexts: %s",
  async (mode) =>
    fixture(async ({ root, parent, digest }) => {
      const registry = openRegistry(join(root, ".omo/state/registry.sqlite"));
      try {
        const manager = linkReadyManager(registry, parent, root);
        const sender = new Harness();
        const recipient = new Harness();
        let idle = mode !== "busy";
        recipient.isIdle = () => idle;
        recipient.waitForIdle = async () => {
          if (!idle) throw new Error("Manager remains busy");
        };
        recipient.receipt = {
          kind: "ok",
          thread_id: manager.durableSessionId,
          message_seq: 1,
          deduplicated: false,
          delivery: { kind: "started", turn_id: "notice" },
        };
        const execute = recipient.executeTool.bind(recipient);
        recipient.executeTool = async (name, input) => {
          if (mode === "race") idle = false;
          return execute(name, input);
        };
        // Two independent extension instances. The sender cannot read recipient state.
        sender.isIdle = () => {
          throw new Error("Cross-isolate global access");
        };
        Object.assign(sender, {
          sendManagerNotice: async (_target: unknown, request: unknown) =>
            managerNoticeReplySchema.parse(
              await recipient.rpc("omo.initiative.admit-manager-notice")(request),
            ),
        });
        registerInitiativeRuntime(sender, { root, hostRuntime: true });
        registerInitiativeRuntime(recipient, { root, hostRuntime: true });
        await sender.start()(context(parent));
        await recipient.start()(context(manager));
        const message = envelope(parent, manager, digest, `isolated-${mode}`, "report");
        const delivered = value(
          resultSchema(deliveryRecordSchema).parse(
            await sender.rpc("omo.initiative.send")(message),
          ),
        );
        expect(delivered.state).toBe(mode === "idle" ? "accepted" : "rejected");
        expect(sender.executeCount).toBe(0);
        expect(recipient.executeCount).toBe(mode === "idle" ? 1 : 0);
        if (mode === "idle") {
          await sender.rpc("omo.initiative.send")(message);
          expect(recipient.executeCount).toBe(1);
        } else {
          expect(delivered.receipt).toMatchObject({
            kind: "error",
            error: { code: "turn_conflict_before_delivery" },
          });
        }
      } finally {
        registry.close();
      }
    }),
);

test("recipient rejects wrong keys and concurrent admission without another native call", async () =>
  fixture(async ({ root, parent, digest }) => {
    const registry = openRegistry(join(root, ".omo/state/registry.sqlite"));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    try {
      const manager = linkReadyManager(registry, parent, root);
      const recipient = new Harness();
      recipient.receipt = {
        kind: "ok",
        thread_id: manager.durableSessionId,
        message_seq: 1,
        deduplicated: false,
        delivery: { kind: "started", turn_id: "once" },
      };
      recipient.afterNative = async () => {
        entered.resolve();
        await release.promise;
      };
      registerInitiativeRuntime(recipient, { root, hostRuntime: true });
      await recipient.start()(context(manager));
      const message = envelope(parent, manager, digest, "concurrent-admission", "report");
      value(registry.claim(parent.durableSessionId, message));
      const admit = recipient.rpc("omo.initiative.admit-manager-notice");
      expect(await admit({ messageId: message.id, nativeKey: "wrong" })).toMatchObject({
        phase: "delivery_result",
        result: { ok: false, error: { code: "stale_attempt" } },
      });
      const pending = admit({ messageId: message.id, nativeKey: message.id });
      const timer = setTimeout(
        () => entered.reject(new Error("Native admission never entered")),
        3000,
      );
      try {
        await entered.promise;
      } finally {
        clearTimeout(timer);
      }
      expect(await admit({ messageId: message.id, nativeKey: message.id })).toMatchObject({
        phase: "delivery_result",
        result: { ok: false, error: { code: "delivery_in_progress" } },
      });
      release.resolve();
      const completed = managerNoticeReplySchema.parse(await pending);
      if (completed.phase !== "delivery_result")
        throw new Error(`Unexpected manager admission phase: ${completed.phase}`);
      expect(value(resultSchema(deliveryRecordSchema).parse(completed.result)).state).toBe(
        "accepted",
      );
      expect(await admit({ messageId: message.id, nativeKey: message.id })).toMatchObject({
        phase: "delivery_result",
        result: { ok: false, error: { code: "stale_attempt" } },
      });
      expect(recipient.executeCount).toBe(1);
    } finally {
      release.resolve();
      registry.close();
    }
  }));

test("recipient proves a thrown pre-native worker failure as admission_failed", async () =>
  fixture(async ({ root, parent, digest }) => {
    const registry = openRegistry(join(root, ".omo/state/registry.sqlite"));
    try {
      const manager = linkReadyManager(registry, parent, root);
      const recipient = new Harness();
      registerInitiativeRuntime(recipient, { root, hostRuntime: true });
      await recipient.start()(context(manager));
      recipient.exec = async () => {
        throw new Error("registry worker transport failed");
      };
      const message = envelope(parent, manager, digest, "pre-native-worker-throw", "report");
      value(registry.claim(parent.durableSessionId, message));

      expect(
        await recipient.rpc("omo.initiative.admit-manager-notice")({
          messageId: message.id,
          nativeKey: message.id,
        }),
      ).toMatchObject({
        phase: "admission_failed",
        cause: { code: "admission_failed", message: expect.stringContaining("worker transport") },
      });
      expect(recipient.executeCount).toBe(0);
    } finally {
      registry.close();
    }
  }));
