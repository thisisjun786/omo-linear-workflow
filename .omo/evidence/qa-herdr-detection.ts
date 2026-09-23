import { z } from "zod";
import { createReporter, sendSignal } from "/home/jun/.omo/agent/extensions/herdr-senpi-agent-state";
import { createHerdrClient } from "../../src/herdr";
import { checkedQaCommand, prepareQaWorld } from "../../scripts/qa-world";

const createdSchema = z.object({
  ok: z.literal(true),
  value: z.object({ binding: z.object({ paneId: z.string() }) }),
});
const importedSchema = z.object({
  ok: z.literal(true),
  value: z.object({ digest: z.string() }),
});
const agentSchema = z.object({
  result: z.object({
    agent: z.object({ agent: z.literal("omo"), agent_status: z.string() }),
  }),
});

const world = await prepareQaWorld();
const herdr = createHerdrClient(world.herdrSocket);
try {
  const anchor = await herdr.createWorkspace(world.repository, "QA detection focus anchor");
  world.workspaces.push(anchor.workspaceId);
  const before = await herdr.snapshot();
  const command = (args: readonly string[]) =>
    checkedQaCommand(["herdr", ...args], world.controlRoot, world.environment);
  const imported = await world.cli([
    "scope", "import", "--file", `${world.installRoot}/tests/fixtures/scope.json`, "--fixture",
  ]);
  if (imported.code !== 0) throw new Error(imported.stdout + imported.stderr);
  const digest = importedSchema.parse(JSON.parse(imported.stdout)).value.digest;
  const created = await world.cli([
    "supervisor", "create", "--initiative", "initiative-omo-1", "--scope-digest", digest,
    "--designation", "qa-detection", "--execute", "--fixture",
  ]);
  if (created.code !== 0) throw new Error(created.stdout + created.stderr);
  const pane = createdSchema.parse(JSON.parse(created.stdout)).value.binding.paneId;
  const inspect = async () => agentSchema.parse(JSON.parse(await command(["agent", "get", pane])));
  console.log("INITIAL_AGENT", JSON.stringify(await inspect()));

  // Herdr owns the screen state. Its wait/submit API subscribes before input;
  // native RPC agent_end alone does not prove the terminal finished repainting.
  await command(["agent", "wait", pane, "--until", "idle", "--until", "done", "--timeout", "90000"]);
  console.log("DETECTION_WORKING", await command([
    "agent", "prompt", pane,
    "QA only: Explain event-driven delivery in 400 words, then finish with DETECTION_READY. Do not use tools.",
    "--wait", "--until", "working", "--timeout", "90000",
  ]));
  console.log("WORKING_SCREEN", await command(["agent", "read", pane, "--source", "detection", "--format", "text"]));
  console.log("WORKING_EXPLAIN", await command(["agent", "explain", pane, "--json"]));
  console.log("DETECTION_SETTLED", await command([
    "agent", "wait", pane, "--until", "idle", "--until", "done", "--timeout", "90000",
  ]));
  console.log("SETTLED_AGENT", JSON.stringify(await inspect()));
  console.log("PROCESS_INFO", await command(["pane", "process-info", "--pane", pane]));
  console.log("HERDR_DETECTION_QA_PASS: real bundled OMO became working then idle/done");

  const reporter = createReporter((active, sequence) =>
    sendSignal(world.herdrSocket, pane, active, sequence));
  try {
    await reporter.start(true);
    await reporter.observe({ source: "senpi-codemode", activeCount: 1 });
    const reported = await inspect();
    console.log("REPORTER_WORKING", JSON.stringify(reported));
    if (reported.result.agent.agent_status !== "working") {
      throw new Error("Detached eval reporter did not claim working");
    }
    await reporter.observe({ source: "senpi-codemode", activeCount: 0 });
    console.log("REPORTER_RELEASED", await command([
      "agent", "wait", pane, "--until", "idle", "--until", "done", "--timeout", "10000",
    ]));
    console.log("DETACHED_REPORTER_QA_PASS: real reporter event and release accepted");
  } finally {
    await reporter.stop();
  }
  if ((await herdr.snapshot()).focusedWorkspaceId !== before.focusedWorkspaceId) {
    throw new Error("Detection QA stole focus");
  }
} finally {
  herdr.close();
  await world.close();
}
