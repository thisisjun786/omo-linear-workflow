import { expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { z } from "zod";
import { runCli } from "../src/cli";
import { deliveryRecordSchema, resultSchema } from "../src/core/schema";
import { openRegistry } from "../src/core/store";
import {
  ManagerNoticeDeliveryError,
  managerNoticeReplySchema,
} from "../src/extension/manager-notice-client";
import { registerInitiativeRuntime } from "../src/extension/runtime";
import { context, envelope, fixture, Harness, linkReadyManager, value } from "./runtime-harness";

test("reports defaults to posted user inbox; --all explicitly includes manager delivery states", async () => {
  await fixture(async ({ root, parent, digest }) => {
    const registry = openRegistry(join(root, ".omo/state/registry.sqlite"));
    const stdout = spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      const manager = linkReadyManager(registry, parent, root);
      const report = envelope(parent, manager, digest, "manager-sending", "report");
      value(registry.claim(parent.durableSessionId, report));
      const posted = { ...report, id: "inbox-posted", toBindingId: null };
      value(registry.post(parent.durableSessionId, posted));
      expect(await runCli(["--root", root, "reports", "--project", "project-1", "--json"])).toBe(0);
      expect(JSON.parse(String(stdout.mock.calls.at(-1)?.[0]))).toMatchObject({
        ok: true,
        value: [{ envelope: { id: posted.id }, state: "posted" }],
      });
      expect(JSON.parse(String(stdout.mock.calls.at(-1)?.[0])).value).toHaveLength(1);
      expect(
        await runCli(["--root", root, "reports", "--project", "project-1", "--all", "--json"]),
      ).toBe(0);
      expect(JSON.parse(String(stdout.mock.calls.at(-1)?.[0])).value).toHaveLength(2);
    } finally {
      stdout.mockRestore();
      registry.close();
    }
  });
});

test.each(["report", "question"] as const)(
  "manager %s carries authorized sender data through a failed lookup boundary and same-ID replay sends once",
  async (kind) => {
    await fixture(async ({ root, parent, digest }) => {
      const registry = openRegistry(join(root, ".omo/state/registry.sqlite"));
      try {
        const manager = linkReadyManager(registry, parent, root);
        const harness = new Harness();
        harness.receipt = {
          kind: "ok",
          thread_id: manager.durableSessionId,
          message_seq: 1,
          deduplicated: false,
          delivery: { kind: "started", turn_id: "notice" },
        };
        registerInitiativeRuntime(harness, { root, hostRuntime: true });
        await harness.start()(context(parent));
        const exec = harness.exec.bind(harness);
        let failedLookups = 0;
        let authorizedClaims = 0;
        let nativeAuthorizations = 0;
        harness.exec = async (command, args, options) => {
          const request = z
            .object({
              action: z.string(),
              input: z.object({ durableSessionId: z.string().optional() }).passthrough(),
            })
            .parse(JSON.parse(args[1] ?? "null"));
          if (
            request.action === "lookup-session" &&
            request.input.durableSessionId === parent.durableSessionId
          ) {
            failedLookups++;
            return {
              stdout: "",
              stderr: "injected sender lookup worker failure",
              code: 1,
              killed: false,
            };
          }
          const reply = await exec(command, args, options);
          if (request.action === "claim") authorizedClaims++;
          if (request.action === "authorize") nativeAuthorizations++;
          return reply;
        };
        const message = {
          ...envelope(
            parent,
            manager,
            digest,
            kind === "question" ? `question:${parent.id}:lookup-failure` : "report-lookup-failure",
            kind,
          ),
          ...(kind === "question" ? { question: { questions: [], escalates: null } } : {}),
        };
        const send = harness.rpc("omo.initiative.send");
        const first = value(resultSchema(deliveryRecordSchema).parse(await send(message)));
        expect(first.state).toBe("accepted");
        const replay = value(resultSchema(deliveryRecordSchema).parse(await send(message)));
        expect(replay).toEqual(first);
        expect(authorizedClaims).toBe(2);
        expect(nativeAuthorizations).toBe(1);
        // A failing secondary worker cannot strand the claim because it is never consulted.
        expect(failedLookups).toBe(0);
        expect(harness.executeCount).toBe(1);
        expect(first.attempts).toMatchObject([
          { number: 1, nativeKey: message.id, state: "accepted" },
        ]);
        expect(value(registry.delivery(message.id)).envelope).toEqual(message);
        expect(
          z.object({ idempotency_key: z.string() }).parse(harness.nativeInputs[0]).idempotency_key,
        ).toBe(message.id);
      } finally {
        registry.close();
      }
    });
  },
);

test.each([
  ["manager", "report"],
  ["manager", "question"],
  ["parent", "report"],
  ["parent", "question"],
] as const)(
  "%s-bound %s retries the same ID after authorization fails before native delivery",
  async (targetRole, kind) => {
    await fixture(async ({ root, parent, child, digest }) => {
      const registry = openRegistry(join(root, ".omo/state/registry.sqlite"));
      try {
        const manager =
          targetRole === "manager" ? linkReadyManager(registry, parent, root) : undefined;
        const sender = targetRole === "manager" ? parent : child;
        const target = manager ?? parent;
        const harness = new Harness();
        harness.receipt = {
          kind: "ok",
          thread_id: target.durableSessionId,
          message_seq: 1,
          deduplicated: false,
          delivery: { kind: "started", turn_id: "notice" },
        };
        registerInitiativeRuntime(harness, { root, hostRuntime: true });
        await harness.start()(context(sender));
        const exec = harness.exec.bind(harness);
        let failAuthorization = true;
        harness.exec = async (command, args, options) => {
          const request = z.object({ action: z.string() }).parse(JSON.parse(args[1] ?? "null"));
          if (request.action === "authorize" && failAuthorization) {
            failAuthorization = false;
            return {
              stdout: "",
              stderr: "injected authorization worker failure",
              code: 1,
              killed: false,
            };
          }
          return exec(command, args, options);
        };
        const message = {
          ...envelope(
            sender,
            target,
            digest,
            kind === "question"
              ? `question:${sender.id}:authorization-retry:${targetRole}`
              : `report-authorization-retry:${targetRole}`,
            kind,
          ),
          ...(kind === "question" ? { question: { questions: [], escalates: null } } : {}),
        };
        const send = harness.rpc("omo.initiative.send");
        const first = value(resultSchema(deliveryRecordSchema).parse(await send(message)));
        expect(first).toMatchObject({
          state: "rejected",
          receipt: { kind: "error", error: { code: "turn_conflict_before_delivery" } },
          attempts: [{ number: 1, nativeKey: message.id, state: "rejected" }],
        });
        expect(harness.executeCount).toBe(0);

        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        harness.afterNative = async () => {
          entered.resolve();
          await release.promise;
        };
        const recovered = send(message);
        await entered.promise;
        const concurrent = await send(message);
        expect(concurrent).toMatchObject({
          ok: false,
          error: { code: "delivery_in_progress" },
        });
        release.resolve();
        const accepted = value(resultSchema(deliveryRecordSchema).parse(await recovered));
        expect(accepted.state).toBe("accepted");
        expect(accepted.attempts).toMatchObject([
          { number: 1, nativeKey: message.id, state: "rejected" },
          { number: 2, state: "accepted" },
        ]);
        expect(accepted.attempts?.[1]?.nativeKey).not.toBe(message.id);
        expect(harness.executeCount).toBe(1);
        expect(value(resultSchema(deliveryRecordSchema).parse(await send(message)))).toEqual(
          accepted,
        );
        expect(harness.executeCount).toBe(1);
        expect(value(registry.delivery(message.id))).toEqual(accepted);
      } finally {
        registry.close();
      }
    });
  },
);

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
          expect(
            value(registry.postedReports({ projectId: "project-1" }, true))[0]?.envelope,
          ).toEqual(message);
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

test("a failure after native execution remains uncertain and never resends", async () => {
  await fixture(async ({ root, parent, digest }) => {
    const registry = openRegistry(join(root, ".omo/state/registry.sqlite"));
    try {
      const manager = linkReadyManager(registry, parent, root);
      const harness = new Harness();
      harness.afterNative = async () => {
        throw new Error("receipt channel failed after native acceptance");
      };
      registerInitiativeRuntime(harness, { root, hostRuntime: true });
      await harness.start()(context(parent));
      const send = harness.rpc("omo.initiative.send");
      const message = envelope(parent, manager, digest, "post-native-uncertain", "report");
      const first = value(resultSchema(deliveryRecordSchema).parse(await send(message)));
      expect(first).toMatchObject({
        state: "uncertain",
        attempts: [{ number: 1, nativeKey: message.id, state: "uncertain" }],
      });
      expect(harness.executeCount).toBe(1);
      expect(await send(message)).toMatchObject({
        ok: false,
        error: { code: "delivery_in_progress" },
      });
      expect(harness.executeCount).toBe(1);
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

test.each([
  [
    "returned admission error",
    async () => ({
      phase: "admission_failed" as const,
      cause: { code: "identity_mismatch", message: "manager path changed" },
    }),
  ],
  [
    "pre-request transport error",
    async () => {
      throw new ManagerNoticeDeliveryError("before_request", "manager native session is not open");
    },
  ],
] as const)("manager %s rejects terminally and same-ID retry sends once", async (_case, fail) => {
  await fixture(async ({ root, parent, digest }) => {
    const registry = openRegistry(join(root, ".omo/state/registry.sqlite"));
    try {
      const manager = linkReadyManager(registry, parent, root);
      const harness = new Harness();
      let first = true;
      const deliver = harness.sendManagerNotice.bind(harness);
      harness.sendManagerNotice = async (target, request) => {
        if (first) {
          first = false;
          return fail();
        }
        return deliver(target, request);
      };
      harness.receipt = {
        kind: "ok",
        thread_id: manager.durableSessionId,
        message_seq: 1,
        deduplicated: false,
        delivery: { kind: "started", turn_id: "retry" },
      };
      registerInitiativeRuntime(harness, { root, hostRuntime: true });
      await harness.start()(context(parent));
      const send = harness.rpc("omo.initiative.send");
      const message = envelope(parent, manager, digest, `manager-terminal-${_case}`, "report");

      const rejected = value(resultSchema(deliveryRecordSchema).parse(await send(message)));
      expect(rejected).toMatchObject({
        state: "rejected",
        receipt: {
          kind: "error",
          error: {
            code: "turn_conflict_before_delivery",
            details: "idle_admission_failed",
          },
        },
      });
      expect(value(registry.delivery(message.id)).state).toBe("rejected");

      const accepted = value(resultSchema(deliveryRecordSchema).parse(await send(message)));
      expect(accepted.state).toBe("accepted");
      expect(accepted.attempts).toHaveLength(2);
      expect(harness.executeCount).toBe(1);
      expect(value(resultSchema(deliveryRecordSchema).parse(await send(message)))).toEqual(
        accepted,
      );
      expect(harness.executeCount).toBe(1);
    } finally {
      registry.close();
    }
  });
});

test("manager lost reply after requestExtension remains uncertain and never retries", async () => {
  await fixture(async ({ root, parent, digest }) => {
    const registry = openRegistry(join(root, ".omo/state/registry.sqlite"));
    try {
      const manager = linkReadyManager(registry, parent, root);
      const harness = new Harness();
      harness.sendManagerNotice = async () => {
        throw new ManagerNoticeDeliveryError(
          "request_uncertain",
          "manager admission reply was lost",
        );
      };
      registerInitiativeRuntime(harness, { root, hostRuntime: true });
      await harness.start()(context(parent));
      const send = harness.rpc("omo.initiative.send");
      const message = envelope(parent, manager, digest, "manager-lost-reply", "report");

      const uncertain = value(resultSchema(deliveryRecordSchema).parse(await send(message)));
      expect(uncertain.state).toBe("uncertain");
      expect(value(registry.delivery(message.id)).state).toBe("uncertain");
      expect(await send(message)).toMatchObject({
        ok: false,
        error: { code: "delivery_in_progress" },
      });
      expect(harness.executeCount).toBe(0);
    } finally {
      registry.close();
    }
  });
});

test.each(["delivery_in_progress", "stale_attempt"] as const)(
  "manager ambiguous admission %s remains uncertain and never retries",
  async (code) => {
    await fixture(async ({ root, parent, digest }) => {
      const registry = openRegistry(join(root, ".omo/state/registry.sqlite"));
      try {
        const manager = linkReadyManager(registry, parent, root);
        const harness = new Harness();
        let admissionCalls = 0;
        harness.sendManagerNotice = async () => {
          admissionCalls++;
          return {
            phase: "delivery_result" as const,
            result: {
              ok: false as const,
              error: { code, message: `manager admission returned ${code}` },
            },
          };
        };
        registerInitiativeRuntime(harness, { root, hostRuntime: true });
        await harness.start()(context(parent));
        const send = harness.rpc("omo.initiative.send");
        const message = envelope(parent, manager, digest, `manager-ambiguous-${code}`, "report");

        const uncertain = value(resultSchema(deliveryRecordSchema).parse(await send(message)));
        expect(uncertain.state).toBe("uncertain");
        expect(value(registry.delivery(message.id)).state).toBe("uncertain");
        expect(await send(message)).toMatchObject({
          ok: false,
          error: { code: "delivery_in_progress" },
        });
        expect(admissionCalls).toBe(1);
        expect(harness.executeCount).toBe(0);
      } finally {
        registry.close();
      }
    });
  },
);

test.each(["idle", "guard", "guard-throw", "setup"] as const)(
  "manager %s rejection survives recipient finish failure and retries once",
  async (boundary) => {
    await fixture(async ({ root, parent, digest }) => {
      const registry = openRegistry(join(root, ".omo/state/registry.sqlite"));
      try {
        const manager = linkReadyManager(registry, parent, root);
        const sender = new Harness();
        const recipient = new Harness();
        let rejecting = true;
        recipient.receipt = {
          kind: "ok",
          thread_id: manager.durableSessionId,
          message_seq: 1,
          deduplicated: false,
          delivery: { kind: "started", turn_id: "retry-once" },
        };
        recipient.waitForIdle = async () => {
          if (rejecting && boundary === "idle") throw new Error("idle admission refused");
        };
        const setActive = recipient.setActiveTools.bind(recipient);
        recipient.setActiveTools = (tools) => {
          if (rejecting && boundary === "setup") throw new Error("tool setup failed");
          setActive(tools);
        };
        const exec = recipient.exec.bind(recipient);
        recipient.exec = async (command, args, options) => {
          const request = z.object({ action: z.string() }).parse(JSON.parse(args[1] ?? "null"));
          if (rejecting && request.action === "authorize" && boundary === "guard-throw")
            throw new Error("guard worker transport failed");
          if (
            rejecting &&
            (request.action === "finish" ||
              (request.action === "authorize" && boundary === "guard"))
          )
            return {
              stdout: "",
              stderr: "injected pre-native persistence failure",
              code: 1,
              killed: false,
            };
          return exec(command, args, options);
        };
        sender.sendManagerNotice = async (_target, request) =>
          managerNoticeReplySchema.parse(
            await recipient.rpc("omo.initiative.admit-manager-notice")(request),
          );
        registerInitiativeRuntime(sender, { root, hostRuntime: true });
        registerInitiativeRuntime(recipient, { root, hostRuntime: true });
        await sender.start()(context(parent));
        await recipient.start()(context(manager));
        const send = sender.rpc("omo.initiative.send");
        const message = envelope(
          parent,
          manager,
          digest,
          `pre-native-finish-${boundary}`,
          "report",
        );
        const rejected = value(resultSchema(deliveryRecordSchema).parse(await send(message)));
        expect(rejected.state).toBe("rejected");
        expect(value(registry.delivery(message.id)).state).toBe("rejected");
        expect(recipient.executeCount).toBe(0);
        rejecting = false;
        const accepted = value(resultSchema(deliveryRecordSchema).parse(await send(message)));
        expect(accepted.state).toBe("accepted");
        expect(accepted.attempts).toHaveLength(2);
        expect(recipient.executeCount).toBe(1);
        expect(value(resultSchema(deliveryRecordSchema).parse(await send(message)))).toEqual(
          accepted,
        );
        expect(recipient.executeCount).toBe(1);
      } finally {
        registry.close();
      }
    });
  },
);

test("manager post-native finish failure remains uncertain and never retries", async () => {
  await fixture(async ({ root, parent, digest }) => {
    const registry = openRegistry(join(root, ".omo/state/registry.sqlite"));
    try {
      const manager = linkReadyManager(registry, parent, root);
      const sender = new Harness();
      const recipient = new Harness();
      recipient.receipt = {
        kind: "ok",
        thread_id: manager.durableSessionId,
        message_seq: 1,
        deduplicated: false,
        delivery: { kind: "started", turn_id: "post-native-finish" },
      };
      const exec = recipient.exec.bind(recipient);
      recipient.exec = async (command, args, options) => {
        const request = z.object({ action: z.string() }).parse(JSON.parse(args[1] ?? "null"));
        if (request.action === "finish") {
          return {
            stdout: "",
            stderr: "injected finish worker failure",
            code: 1,
            killed: false,
          };
        }
        return exec(command, args, options);
      };
      sender.sendManagerNotice = async (_target, request) =>
        managerNoticeReplySchema.parse(
          await recipient.rpc("omo.initiative.admit-manager-notice")(request),
        );
      registerInitiativeRuntime(sender, { root, hostRuntime: true });
      registerInitiativeRuntime(recipient, { root, hostRuntime: true });
      await sender.start()(context(parent));
      await recipient.start()(context(manager));
      const send = sender.rpc("omo.initiative.send");
      const message = envelope(parent, manager, digest, "manager-post-native-finish", "report");

      const uncertain = value(resultSchema(deliveryRecordSchema).parse(await send(message)));
      expect(uncertain.state).toBe("uncertain");
      expect(recipient.executeCount).toBe(1);
      expect(await send(message)).toMatchObject({
        ok: false,
        error: { code: "delivery_in_progress" },
      });
      expect(recipient.executeCount).toBe(1);
    } finally {
      registry.close();
    }
  });
});
