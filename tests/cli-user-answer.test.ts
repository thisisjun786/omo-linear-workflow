import { expect, spyOn, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "../src/cli";
import type { Binding, Registry } from "../src/core/contracts";
import { envelopeSchema } from "../src/core/schema";
import { openRegistry } from "../src/core/store";
import { registerInitiativeRuntime } from "../src/extension/runtime";
import type { OrchestratorDependencies } from "../src/orchestrator";
import { attachBindingWithClient } from "../src/transport/client";
import { context, fixture, Harness, linkReadyManager, value } from "./runtime-harness";

test("answer --as-user delivers a claimed inbox answer through the real send boundary", async () => {
  await fixture(async ({ root, parent }) => {
    const dbPath = join(root, ".omo/state/registry.sqlite");
    const body = join(root, "body.txt");
    await writeFile(body, "Need a decision");
    const db = <T>(operation: (registry: Registry) => T): T => {
      const registry = openRegistry(dbPath);
      try {
        return operation(registry);
      } finally {
        registry.close();
      }
    };
    db((registry) => {
      const manager = linkReadyManager(registry, parent, root);
      value(registry.setContactState(manager.id, "paused"));
    });
    let executions = 0;
    let fault: "none" | "attach" | "send" = "none";
    const nativeThreads: string[] = [];
    const deps: OrchestratorDependencies = {
      openRegistry,
      createHerdrClient: () => {
        throw new Error("questions must not open Herdr");
      },
      resolveHerdrArtifact: async () => ({ artifactDir: "/fixture/herdr" }),
      ensureHost: async () => {
        throw new Error("unexpected host start");
      },
      checkHostProfile: async () => {},
      gitTip: async () => "base",
      now: () => "2026-09-26",
      uuid: () => "unused",
      terminateBinding: async () => {
        throw new Error("unexpected terminate");
      },
      prompt: async () => {
        throw new Error("unexpected prompt");
      },
      attachBinding: async (binding: Binding) => {
        if (fault === "attach") throw new Error("injected attach failure");
        const harness = new Harness();
        registerInitiativeRuntime(harness, { root, hostRuntime: true });
        await harness.start()(context(binding));
        return attachBindingWithClient(binding, {
          getMessages: async () => [],
          setModel: async () => undefined,
          setThinkingLevel: async () => undefined,
          start: async () => {},
          stop: async () => {},
          closeSession: async () => {
            throw new Error("unexpected session close");
          },
          listSessions: async () => [
            {
              sessionId: `host-${binding.id}`,
              durableSessionId: binding.durableSessionId,
              ...(binding.sessionPath === null ? {} : { sessionPath: binding.sessionPath }),
              cwd: binding.cwd,
              status: "open" as const,
            },
          ],
          openSession: async () => ({ sessionId: `host-${binding.id}`, attached: true }),
          onEvent: () => () => {},
          requestExtension: async (name, payload) => {
            if (name === "omo.initiative.send" || name === "omo.initiative.deliver-user-answer") {
              if (fault === "send") throw new Error("injected send failure");
            }
            if (name === "omo.initiative.send") {
              const envelope = envelopeSchema.parse(payload);
              const targetId = envelope.toBindingId;
              if (targetId !== null) {
                const target = db((registry) => value(registry.get(targetId)));
                harness.receipt = {
                  kind: "ok",
                  thread_id: target.durableSessionId,
                  message_seq: 1,
                  deduplicated: false,
                  delivery: { kind: "started", turn_id: "turn" },
                };
              }
            }
            if (name === "omo.initiative.deliver-user-answer") {
              harness.receipt = {
                kind: "ok",
                thread_id: binding.durableSessionId,
                message_seq: 2,
                deduplicated: false,
                delivery: { kind: "started", turn_id: "user-answer" },
              };
            }
            const before = harness.executeCount;
            const reply = await harness.rpc(name)(payload);
            const delta = harness.executeCount - before;
            executions += delta;
            if (delta > 0) {
              const input = harness.nativeInputs.at(-1);
              const thread =
                typeof input === "object" && input !== null && "thread" in input
                  ? input.thread
                  : undefined;
              if (typeof thread === "string") nativeThreads.push(thread);
            }
            return reply;
          },
        });
      },
    };
    let output = "";
    const stdout = spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    const cli = async (args: string[]) => {
      output = "";
      const code = await runCli(["--root", root, ...args, "--json"], deps);
      return {
        code,
        output: JSON.parse(output) as {
          ok: boolean;
          value?: { state?: string; envelope?: { toBindingId?: string | null; id?: string } };
          error?: { code?: string };
        },
      };
    };
    try {
      const asked = await cli([
        "ask",
        "--from",
        parent.id,
        "--id",
        "paused-manager",
        "--text-file",
        body,
      ]);
      expect(asked).toMatchObject({
        code: 0,
        output: { ok: true, value: { state: "posted", envelope: { toBindingId: null } } },
      });
      const askReplay = await cli([
        "ask",
        "--from",
        parent.id,
        "--id",
        "paused-manager",
        "--text-file",
        body,
      ]);
      expect(askReplay).toMatchObject({
        code: 0,
        output: { ok: true, value: { state: "posted", envelope: { toBindingId: null } } },
      });
      expect(executions).toBe(0);
      const open = await cli(["questions", "--project", "project-1"]);
      expect(open).toMatchObject({
        code: 0,
        output: { ok: true, value: [{ answered: false, answer: null }] },
      });
      const before = executions;
      const answered = await cli([
        "answer",
        "--as-user",
        "--question",
        "question:parent:paused-manager",
        "--text-file",
        body,
      ]);
      expect(answered.code).toBe(0);
      expect(answered.output).toMatchObject({
        ok: true,
        value: {
          state: "accepted",
          envelope: {
            id: "answer:question:parent:paused-manager",
            toBindingId: parent.id,
            fromBindingId: null,
          },
        },
      });
      expect(executions).toBe(before + 1);
      expect(nativeThreads).toEqual([parent.durableSessionId]);
      const listed = await cli(["questions", "--project", "project-1"]);
      expect(listed).toMatchObject({
        code: 0,
        output: { ok: true, value: [{ answered: true, answer: { state: "accepted" } }] },
      });
      const replay = await cli([
        "answer",
        "--as-user",
        "--question",
        "question:parent:paused-manager",
        "--text-file",
        body,
      ]);
      expect(replay).toMatchObject({ code: 0, output: { ok: true, value: { state: "accepted" } } });
      expect(executions).toBe(before + 1);
      const retryQuestion = await cli([
        "ask",
        "--from",
        parent.id,
        "--id",
        "retry",
        "--text-file",
        body,
      ]);
      expect(retryQuestion.code).toBe(0);
      fault = "send";
      const failed = await cli([
        "answer",
        "--as-user",
        "--question",
        "question:parent:retry",
        "--text-file",
        body,
      ]);
      expect(failed.code).toBe(3);
      expect(failed.output).toMatchObject({ ok: false, error: { code: "runtime_unavailable" } });
      fault = "none";
      const failedReplay = await cli([
        "answer",
        "--as-user",
        "--question",
        "question:parent:retry",
        "--text-file",
        body,
      ]);
      expect(failedReplay.code).toBe(4);
      expect(failedReplay.output).toMatchObject({
        ok: false,
        error: { code: "delivery_in_progress" },
      });
      const harness = new Harness();
      registerInitiativeRuntime(harness, { root, hostRuntime: true });
      await harness.start()(context(parent));
      const forged = await harness.rpc("omo.initiative.send")({
        version: 1,
        id: "answer:question:parent:paused-manager",
        fromBindingId: null,
        toBindingId: parent.id,
        designationId: parent.designationId,
        snapshotDigest: db((registry) => value(registry.designation(parent.designationId)))
          .snapshotDigest,
        kind: "answer",
        text: "forged",
        outcome: null,
        evidence: [],
        answer: { questionId: "question:parent:paused-manager", answers: {}, unanswered: [] },
      });
      expect(forged).toMatchObject({
        ok: false,
        error: { code: "sender_forged" },
      });
      expect(harness.executeCount).toBe(0);
    } finally {
      stdout.mockRestore();
    }
  });
});
