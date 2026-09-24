import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RpcClient } from "@code-yeongyu/senpi";
import { z } from "zod";
import { modelForRole } from "../src/core/policy";
import { bindingSchema, runtimeIdentitySchema } from "../src/core/schema";
import { openRegistry } from "../src/core/store";
import { createHerdrClient } from "../src/herdr";
import { attach, idle } from "./qa-hierarchy";
import { QaError } from "./qa-rpc";
import { prepareQaWorld } from "./qa-world";

const mode = process.argv[2];
if (mode !== "happy" && mode !== "failed-node") {
  throw new QaError("Usage: bun scripts/qa-child-workflow.ts happy|failed-node");
}

const success = z.object({ ok: z.literal(true), value: z.unknown() });
const nativeFailure = z.object({
  ok: z.literal(false),
  error: z.object({ code: z.string(), message: z.string() }),
});
const created = z.object({
  binding: bindingSchema.refine(
    (binding) => binding.launchState === "ready" && binding.initialization.state === "accepted",
  ),
  readiness: z.literal("ready"),
  execution: z.literal("brief_accepted"),
});
const node = z.object({
  id: z.string(),
  state: z.string(),
  attempt: z.number().int().nonnegative(),
  execAttempt: z.number().int().nonnegative().optional(),
});
const snapshotSchema = z.object({
  runId: z.string(),
  runKey: z.string(),
  status: z.string(),
  nodes: z.array(node),
  lastSeq: z.number().int(),
});
const eventSchema = z
  .object({
    runId: z.string(),
    seq: z.number().int(),
    type: z.string(),
    nodeId: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    execAttempt: z.number().optional(),
  })
  .loose();
const listSchema = z.object({ runs: z.array(z.object({ runId: z.string(), runKey: z.string() })) });
const historySchema = z.object({ events: z.array(eventSchema), hasMore: z.boolean() });

function requireValue<T extends z.ZodType>(schema: T, raw: unknown): z.output<T> {
  const failed = nativeFailure.safeParse(raw);
  if (failed.success)
    throw new QaError(`Native extension request failed: ${JSON.stringify(failed.data.error)}`);
  return schema.parse(success.parse(raw).value);
}

function messageText(message: Awaited<ReturnType<RpcClient["getMessages"]>>[number]): string {
  if (!("content" in message)) return "";
  return typeof message.content === "string"
    ? message.content
    : message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
}

const world = await prepareQaWorld();
console.log("QA_WORLD", mode, world.scratch);
const herdr = createHerdrClient(world.herdrSocket);
const clients: RpcClient[] = [];
const evidenceDir = join(world.installRoot, ".omo/evidence/child-mass-ulw");
const evidencePath = join(evidenceDir, `${mode}.json`);
const evidence: {
  mode: string;
  result: string;
  scratch: string;
  cleanup: string;
  bindings?: unknown;
  packet?: unknown;
  key?: unknown;
  reportId?: unknown;
  artifacts?: unknown;
  events?: unknown;
  runId?: unknown;
  snapshot?: unknown;
  history?: unknown;
  childEvidence?: unknown;
  firstVerification?: unknown;
  goal?: unknown;
  error?: unknown;
  cleanupError?: unknown;
} = {
  mode,
  result: "FAILED",
  scratch: world.scratch,
  cleanup: "pending",
};
let failure: unknown;
let stopEvents: (() => void) | undefined;
let stopParent: (() => void) | undefined;
const invoke = async (args: readonly string[]): Promise<unknown> => {
  const result = await world.cli(args);
  if (result.code !== 0)
    throw new QaError(
      `CLI ${args.join(" ")} exited ${result.code}: ${result.stdout} ${result.stderr}`,
    );
  return success.parse(JSON.parse(result.stdout)).value;
};
try {
  const anchor = await herdr.createWorkspace(world.repository, "QA focus anchor");
  world.workspaces.push(anchor.workspaceId);
  const baseline = await herdr.snapshot();
  const fixturePath = join(world.scratch, "scope.json");
  await writeFile(
    fixturePath,
    await readFile(join(world.installRoot, "tests/fixtures/scope.json"), "utf8"),
  );
  const { digest } = z
    .object({ digest: z.string() })
    .parse(await invoke(["scope", "import", "--file", fixturePath, "--fixture"]));
  const supervisor = created.parse(
    await invoke([
      "supervisor",
      "create",
      "--initiative",
      "initiative-omo-1",
      "--scope-digest",
      digest,
      "--designation",
      "qa-child-workflow",
      "--execute",
      "--fixture",
    ]),
  ).binding;
  const parent = created.parse(
    await invoke([
      "parent",
      "create",
      "--supervisor",
      supervisor.id,
      "--project",
      "project-omo-1",
      "--repo",
      world.repository,
      "--base",
      "main",
    ]),
  ).binding;
  const child = created.parse(
    await invoke(["child", "create", "--parent", parent.id, "--issue", "issue-omo-1"]),
  ).binding;
  evidence.bindings = [supervisor.id, parent.id, child.id];
  const supervisorClient = await attach(supervisor);
  clients.push(supervisorClient);
  const parentClient = await attach(parent);
  clients.push(parentClient);
  const childClient = await attach(child);
  clients.push(childClient);
  await Promise.all(clients.map(idle));
  if (child.assignment.role !== "child") throw new QaError("Wrong child assignment");
  z.object({
    qa_standby: z.literal(true),
    behavior: z.object({
      execution_mode: z.literal("mass-ulw"),
      execution_trigger: z.literal("explicit_issue_packet"),
      issue_goal: z.literal("packet_bound"),
    }),
  }).parse(Bun.YAML.parse(child.initialization.text ?? ""));
  const goalPaths = new Map(
    [supervisor, parent, child].map((binding) => {
      if (!binding.sessionPath) throw new QaError("Missing role session path");
      return [
        binding.id,
        join(
          dirname(binding.sessionPath),
          "extensions/goal",
          `${encodeURIComponent(binding.durableSessionId)}.json`,
        ),
      ] as const;
    }),
  );
  for (const path of goalPaths.values()) {
    if (existsSync(path)) throw new QaError("Fixture startup unexpectedly created a goal");
  }
  const beforeRuns = requireValue(
    listSchema,
    await childClient.requestExtension("omo.dag.list", {}),
  );
  if (beforeRuns.runs.length !== 0) throw new QaError("Fixture startup created a workflow");
  const expected = (["supervisor", "parent", "child"] as const).map((role) => {
    const { provider, modelId, thinking } = modelForRole(role);
    return [provider, modelId, thinking];
  });
  for (const [index, binding] of [supervisor, parent, child].entries()) {
    const client = [supervisorClient, parentClient, childClient][index];
    const tuple = expected[index];
    if (!client || !tuple) throw new QaError("Missing role RPC client");
    const state = await client.getState();
    if (
      state.isStreaming ||
      state.model?.provider !== tuple[0] ||
      state.model?.id !== tuple[1] ||
      state.thinkingLevel !== tuple[2]
    ) {
      throw new QaError(`Wrong startup model or non-idle role: ${binding.assignment.role}`);
    }
    const identity = requireValue(
      runtimeIdentitySchema,
      await client.requestExtension("omo.initiative.describe"),
    );
    if (
      identity.durableSessionId !== binding.durableSessionId ||
      identity.sessionPath !== binding.sessionPath ||
      identity.cwd !== binding.cwd ||
      identity.provider !== tuple[0] ||
      identity.modelId !== tuple[1] ||
      identity.thinking !== tuple[2]
    ) {
      throw new QaError(`Wrong runtime identity: ${binding.assignment.role}`);
    }
  }
  const commands = await childClient.getCommands();
  for (const name of ["mass-ulw", "olw-run"]) {
    if (
      !commands.some((command) => command.name === `skill:${name}` && command.source === "skill")
    ) {
      throw new QaError(`Child missing skill command: ${name}`);
    }
  }
  const packet = `qa-child-${crypto.randomUUID()}`;
  const key = `olw:${child.id}:${packet}:p1`;
  const reportId = `report:${packet}`;
  if (!child.checkout) throw new QaError("Child has no checkout");
  const directory = join(world.controlRoot, ".omo/evidence/olw", child.id, packet);
  const a = join(child.cwd, "qa/a.txt");
  const b = join(child.cwd, "qa/b.txt");
  const verifierPath = join(world.scratch, "verify.mjs");
  const receiptsPath = join(world.scratch, "verification.jsonl");
  const verifierSource = `import { readFile, appendFile } from "node:fs/promises";
const paths = ${JSON.stringify([a, b])};
const bytes = [];
for (const path of paths) {
  try { bytes.push((await readFile(path)).toString("hex")); }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    bytes.push(null);
  }
}
const result = { aHex: bytes[0], bHex: bytes[1], pass: bytes[0] === "410a" && bytes[1] === "420a" };
await appendFile(${JSON.stringify(receiptsPath)}, JSON.stringify(result) + "\\n", { mode: 0o600 });
console.log(JSON.stringify(result));
process.exitCode = result.pass ? 0 : 1;
`;
  await writeFile(verifierPath, verifierSource, { mode: 0o400 });
  evidence.packet = packet;
  evidence.key = key;
  evidence.reportId = reportId;
  evidence.artifacts = { a, b, directory };
  const observed: unknown[] = [];
  evidence.events = observed;
  const deadline = Promise.withResolvers<never>();
  stopEvents = childClient.onEvent((event) => {
    if (
      event.type === "message_end" &&
      event.message.role === "assistant" &&
      event.message.stopReason === "error"
    ) {
      deadline.reject(new QaError(event.message.errorMessage ?? "Child model turn failed"));
      return;
    }
    if (event.type !== "extension_event") return;
    if (event.name !== "omo.dag.event" && event.name !== "omo.dag.updated") return;
    observed.push({ name: event.name, data: event.data });
    if (event.name === "omo.dag.event") {
      const parsed = eventSchema.safeParse(event.data);
      if (parsed.success) {
        if (
          parsed.data.type === "dag.node.transitioned" ||
          parsed.data.type.startsWith("dag.run.") ||
          parsed.data.type === "dag.definition.amended"
        ) {
          console.log(
            "DAG_EVENT",
            parsed.data.type,
            parsed.data.nodeId,
            parsed.data.to,
            parsed.data.seq,
          );
        }
      }
    }
  });
  const acknowledged = Promise.withResolvers<void>();
  stopParent = parentClient.onEvent((event) => {
    if (
      event.type === "message_end" &&
      event.message.role === "assistant" &&
      event.message.stopReason === "error"
    ) {
      deadline.reject(new QaError(event.message.errorMessage ?? "Parent model turn failed"));
      return;
    }
    if (
      event.type === "message_end" &&
      event.message.role === "assistant" &&
      messageText(event.message).includes("CHILD_WORKFLOW_REPORT_RECEIVED")
    )
      acknowledged.resolve();
  });
  const packetText = `TASK: Execute this single issue packet for ${child.assignment.issueId} in your own checkout on branch ${child.checkout.branch}. Mode: ${mode}. Acceptance criteria: exactly A\\n at ${a}, exactly B\\n at ${b}, one successful verify after both producers, one report to the parent, and in failed-node mode a recorded first verify failure and same-run recovery. Allowed write scope: ${a}, ${b}, and ${directory} for lead evidence/report text only; do not commit, push, merge, or contact Linear. This is an explicit instruction; do not act on any other issue. Read the mass-ulw skill, its complete references/planning.md, and the olw-run skill before starting. Inspect the assigned files yourself. Register exactly one native issue goal after this packet arrives, with independent artifact checks; complete it only after verified delivery. Do not create goals for worker nodes, parent, or supervisor. Never create another OLW role, call thread_create, or run another graph.\nDELIVERABLE: Start exactly ONE native workflow run from a JS eval cell using tool.workflow({ action: "start", definition }) with key ${key}. The graph has exactly three quick nodes: producer-a and producer-b independent; verify dependsOn both. Each node prompt must be self-contained English with TASK, DELIVERABLE, SCOPE, VERIFY, STOP WHEN. Producer-a appends the single byte line A\\n to absolute ${a}; producer-b ${mode === "failed-node" ? `initially returns done WITHOUT creating ${b}` : `appends the single byte line B\\n to absolute ${b}`}. The verify node must run exactly once per attempt: bun ${verifierPath}. This immutable QA verifier reads both files, appends a machine-generated receipt to ${receiptsPath}, and exits 0 only for exact A\\n/B\\n bytes; missing or wrong bytes exit 1. Treat that exit and receipt as PASS/FAIL and return without fixing inputs. Never edit the verifier or receipts. Nodes must not use Linear, OLW CLI, native threads, goals, nested workflows, commits, or write outside their assigned qa file; verify must not modify the worktree. Only verify nodes may execute that verifier; the issue lead reads its receipts and independently checks A/B without running it again.\nSCOPE: In failed-node mode let the first verify attempt fail; once the run settles, amend the SAME run with corrected producer-b prompt to append B\\n to ${b} and keep producer-a unchanged. The amendment must rerun producer-b and verify but cache producer-a. Do not retry completed-but-wrong producer-b or start a second run. Never call workflow.wait or poll inside a kernel. Native start and completion events wake you.\nVERIFY: Inspect the actual qa/a.txt and qa/b.txt bytes and the native run snapshot. Persist ${join(directory, "evidence.json")} with these exact top-level JSON fields: binding_id ${child.id}, issue_id ${child.assignment.issueId}, packet_id ${packet}, and runs (an array containing exactly one object with run_id equal to the actual native run_id and key equal to ${key}). Also record the issue goal, node states and attempts, artifact paths and byte checks, first_failed_verification as a top-level field in failed-node mode, amended recovery, branch and HEAD. Write the report text file in ${directory}; it must include HEAD and branch, checked criteria and evidence, and any unverified or running work. Do not rely on node PASS prose. Report exactly once to your parent with: bun ${join(world.controlRoot, "dist/cli.js")} --root ${world.controlRoot} --herdr-socket ${world.herdrSocket} report --from ${child.id} --id ${reportId} --outcome completed --evidence ${join(directory, "evidence.json")} --text-file <absolute path to a file you wrote containing 'Reply exactly CHILD_WORKFLOW_REPORT_RECEIVED. Do not take other actions.'> --json. Use that evidence file as the reported JSON record. Complete the packet goal after confirmed CLI delivery. Do not take other actions.\nSTOP WHEN: The single run completed, exact files and evidence exist, and the single report was sent.`;
  const packetPath = join(world.scratch, "packet.txt");
  await writeFile(packetPath, packetText);
  const timeout = setTimeout(
    () => deadline.reject(new QaError("Child workflow/report timed out after 900s")),
    900000,
  );
  try {
    const send = invoke([
      "send",
      "--from",
      parent.id,
      "--to",
      child.id,
      "--id",
      packet,
      "--kind",
      "instruction",
      "--text-file",
      packetPath,
    ]);
    await Promise.race([
      (async () => {
        z.object({ state: z.literal("accepted") }).parse(await send);
        await acknowledged.promise;
      })(),
      deadline.promise,
    ]);
  } finally {
    clearTimeout(timeout);
  }
  await Promise.all([idle(childClient), idle(parentClient)]);
  for (const [bindingId, path] of goalPaths) {
    if (bindingId !== child.id) {
      if (existsSync(path)) throw new QaError("A coordination role created a goal");
      continue;
    }
    evidence.goal = z
      .object({
        version: z.literal(1),
        goal: z.object({
          threadId: z.literal(child.durableSessionId),
          status: z.literal("complete"),
        }),
      })
      .parse(JSON.parse(await readFile(path, "utf8")));
  }
  evidence.events = observed;
  const runs = requireValue(
    listSchema,
    await childClient.requestExtension("omo.dag.list", { limit: 100 }),
  );
  const matching = runs.runs.filter((run) => run.runKey === key);
  if (runs.runs.length !== 1 || matching.length !== 1)
    throw new QaError(`Expected one native run: ${JSON.stringify(runs)}`);
  const runId = matching[0]?.runId;
  if (!runId) throw new QaError("Missing native run id");
  const snapshot = requireValue(
    snapshotSchema,
    await childClient.requestExtension("omo.dag.snapshot", { runId }),
  );
  const history = requireValue(
    historySchema,
    await childClient.requestExtension("omo.dag.history", { runId, sinceSeq: 0, limit: 1000 }),
  );
  evidence.runId = runId;
  evidence.snapshot = snapshot;
  evidence.history = history;
  if (
    history.hasMore ||
    snapshot.status !== "completed" ||
    snapshot.runKey !== key ||
    snapshot.runId !== runId ||
    snapshot.nodes.length !== 3 ||
    snapshot.nodes.some((entry) => entry.state !== "completed") ||
    ["producer-a", "producer-b", "verify"].some(
      (id) => !snapshot.nodes.some((entry) => entry.id === id),
    )
  ) {
    throw new QaError("Wrong native graph or incomplete history");
  }
  const attempts = new Map(snapshot.nodes.map((entry) => [entry.id, entry.attempt]));
  if (
    attempts.get("producer-a") !== 1 ||
    attempts.get("producer-b") !== (mode === "failed-node" ? 2 : 1) ||
    attempts.get("verify") !== (mode === "failed-node" ? 2 : 1)
  ) {
    throw new QaError(`Wrong task attempts: ${JSON.stringify([...attempts])}`);
  }
  const transitions = history.events.filter((event) => event.type === "dag.node.transitioned");
  const firstVerifyEvent = transitions.find(
    (event) => event.nodeId === "verify" && (event.to === "failed" || event.to === "completed"),
  );
  const receipts = z
    .array(
      z.object({ aHex: z.string().nullable(), bHex: z.string().nullable(), pass: z.boolean() }),
    )
    .parse(
      (await readFile(receiptsPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    );
  const lastReceipt = receipts.at(-1);
  if (
    receipts.length !== (mode === "failed-node" ? 2 : 1) ||
    lastReceipt?.aHex !== "410a" ||
    lastReceipt.bHex !== "420a" ||
    !lastReceipt.pass ||
    (await readFile(verifierPath, "utf8")) !== verifierSource
  ) {
    throw new QaError("Independent verifier receipts or source do not match the attempts");
  }
  evidence.firstVerification = { event: firstVerifyEvent, receipts };
  const completed = (id: string) =>
    transitions.filter((event) => event.nodeId === id && event.to === "completed").length;
  if (
    completed("producer-a") !== 1 ||
    completed("producer-b") !== (mode === "failed-node" ? 2 : 1) ||
    completed("verify") !==
      (mode === "failed-node" && firstVerifyEvent?.to === "completed" ? 2 : 1) ||
    !history.events.some((event) => event.type === "dag.run.completed")
  ) {
    throw new QaError("Native completion transitions/events do not match the workflow");
  }
  if (
    mode === "failed-node" &&
    (receipts[0]?.aHex !== "410a" ||
      receipts[0].bHex !== null ||
      receipts[0].pass ||
      !history.events.some(
        (event) =>
          event.type === "dag.definition.amended" &&
          event.seq > (firstVerifyEvent?.seq ?? Number.POSITIVE_INFINITY),
      ) ||
      transitions.filter(
        (event) => event.nodeId === "verify" && (event.to === "failed" || event.to === "completed"),
      ).length !== 2)
  ) {
    throw new QaError("No actual first failed verification and amended recovery");
  }
  if (
    !(await readFile(a)).equals(Buffer.from("A\n")) ||
    !(await readFile(b)).equals(Buffer.from("B\n"))
  ) {
    throw new QaError("Producer output bytes differ from A/B single lines");
  }
  const reported: unknown = JSON.parse(await readFile(join(directory, "evidence.json"), "utf8"));
  evidence.childEvidence = reported;
  const record = z
    .object({
      runs: z.array(z.object({ run_id: z.literal(runId), key: z.literal(key) })).length(1),
      binding_id: z.literal(child.id),
      issue_id: z.literal(child.assignment.issueId),
      packet_id: z.literal(packet),
    })
    .loose()
    .parse(reported);
  if (mode === "failed-node" && !("first_failed_verification" in record)) {
    throw new QaError("Child did not retain its first failed verification");
  }
  const messages = await parentClient.getMessages();
  const deliveries = messages.filter(
    (message) => message.role === "user" && messageText(message).includes(`"id":"${reportId}"`),
  );
  if (deliveries.length !== 1)
    throw new QaError(`Expected one delivered parent report; got ${deliveries.length}`);
  const registry = openRegistry(join(world.controlRoot, ".omo/state/registry.sqlite"));
  try {
    const bindings = registry.list();
    if (
      !bindings.ok ||
      bindings.value.length !== 3 ||
      [supervisor, parent, child].some(
        (binding) =>
          !bindings.value.some(
            (entry) =>
              entry.id === binding.id && entry.durableSessionId === binding.durableSessionId,
          ),
      )
    ) {
      throw new QaError("Registry role bindings changed");
    }
  } finally {
    registry.close();
  }
  const after = await herdr.snapshot();
  if (
    after.focusedWorkspaceId !== baseline.focusedWorkspaceId ||
    after.workspaces.length !== baseline.workspaces.length + 3
  ) {
    throw new QaError("Herdr focus/workspace count changed unexpectedly");
  }
  for (const [index, binding] of [supervisor, parent, child].entries()) {
    const client = [supervisorClient, parentClient, childClient][index];
    const tuple = expected[index];
    if (!client || !tuple) throw new QaError("Missing final role");
    const state = await client.getState();
    const identity = requireValue(
      runtimeIdentitySchema,
      await client.requestExtension("omo.initiative.describe"),
    );
    if (
      state.model?.provider !== tuple[0] ||
      state.model?.id !== tuple[1] ||
      state.thinkingLevel !== tuple[2] ||
      identity.durableSessionId !== binding.durableSessionId ||
      identity.provider !== tuple[0] ||
      identity.modelId !== tuple[1] ||
      identity.thinking !== tuple[2] ||
      identity.cwd !== binding.cwd ||
      identity.sessionPath !== binding.sessionPath
    ) {
      throw new QaError(`Changed role identity: ${binding.assignment.role}`);
    }
  }
  evidence.result = "PASS";
} catch (error) {
  failure = error;
  evidence.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  for (const client of clients) {
    console.error(
      "QA_LAST_ASSISTANT",
      JSON.stringify(
        (await client.getMessages())
          .filter((message) => message.role === "assistant")
          .slice(-3)
          .map((message) => ({
            stopReason: message.stopReason,
            errorMessage: message.errorMessage,
            text: message.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join(""),
          })),
      ),
    );
  }
} finally {
  stopEvents?.();
  stopParent?.();
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  for (const client of clients) {
    try {
      if ((await client.getState()).isStreaming) await client.abort();
      await client.closeSession();
      await client.stop();
    } catch (error) {
      failure ??= error;
      evidence.cleanupError = error instanceof Error ? error.message : String(error);
    }
  }
  herdr.close();
  try {
    await world.close();
    evidence.cleanup = "owned sessions, workspaces, host, server and scratch removed";
  } catch (error) {
    failure ??= error;
    evidence.cleanup = error instanceof Error ? error.message : String(error);
  }
  if (failure) evidence.result = "FAILED";
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
}
if (failure) throw failure;
console.log(`CHILD_WORKFLOW_QA_PASS ${mode}: ${evidencePath}`);
