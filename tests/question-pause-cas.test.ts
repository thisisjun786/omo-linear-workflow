import { expect, test } from "bun:test";
import type { RuntimePort } from "../src/extension/runtime";
import { registerInitiativeRuntime } from "../src/extension/runtime";
import { context, fixture, Harness } from "./runtime-harness";

test.each(["pause", "release"] as const)(
  "a %s CAS mismatch relinquishes authority durably",
  async (phase) =>
    fixture(async ({ root, child }) => {
      const harness = new Harness();
      const port: RuntimePort = harness;
      if (phase === "pause") port.pauseGoal = async () => false;
      else
        port.resumeGoal = async (_ctx, _pause, onOwnershipLost) => {
          onOwnershipLost?.();
        };
      const ctx = context(child);
      ctx.sessionManager.getBranch = () => harness.entries;
      registerInitiativeRuntime(port, { root, hostRuntime: true });
      await harness.start()(ctx);
      const questions = {
        questions: [
          { id: "q", question: "Decision?", options: [{ label: "yes" }], multiSelect: false },
        ],
      };
      await harness.callTool("olw_ask", "one", questions);
      if (phase === "release")
        await harness.rpc("omo.initiative.cancel-question")({ questionId: "question:child:one" });
      expect(harness.waitEvents.at(-1)).toMatchObject({ active: false });
      const calls = harness.pauseCalls;
      await harness.start()(ctx);
      await harness.callTool("olw_ask", "two", questions);
      expect(harness.waitEvents.at(-1)).toMatchObject({ active: false });
      expect(harness.pauseCalls).toBe(calls);
    }),
);
