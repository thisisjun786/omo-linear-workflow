import assert from "node:assert/strict";
import { existsSync, watch } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { RpcClient } from "@code-yeongyu/senpi";
import { z } from "zod";
import type { Binding, Registry, Result } from "../src/core/contracts";
import { bindingSchema, runtimeIdentitySchema } from "../src/core/schema";
import { openRegistry } from "../src/core/store";
import { createHerdrClient } from "../src/herdr";
import { planPaneExited } from "../src/orchestrator";
import { globalOmo } from "../src/proxy/routing-launch";
import { attach, idle } from "./qa-hierarchy";
import { prepareQaWorld } from "./qa-world";

// Native boundaries remain real. Only npm's read-only version lookup is offline.
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--official-offline") {
  await (await import("./qa-official-herdr")).runOfficialHerdrQa(
    "qa-two-stage-official-offline.json",
  );
  process.exit(0);
}
if (args.length === 1 && args[0] === "--manager-reattach") {
  await (await import("./qa-official-herdr")).runOfficialHerdrQa("qa-manager-reattach.json");
  process.exit(0);
}
assert.ok(args.length === 0 || (args.length === 1 && args[0] === "--break-answer"));
const breakAnswer = args.includes("--break-answer");
const root = resolve(import.meta.dir, "..");
const evidenceDir = join(root, ".omo/evidence/two-stage");
const evidencePath = join(
  evidenceDir,
  breakAnswer ? "qa-two-stage-break-answer.json" : "qa-two-stage.json",
);
const upstream = globalOmo();
const originalHome = process.env["HOME"];
assert.ok(originalHome);
const home = await mkdtemp(join(tmpdir(), "olw-two-stage-home-"));
const deadline = Date.now() + 1_800_000;
const evidence: Record<string, unknown> = {
  mode: breakAnswer ? "break-answer" : "happy",
  result: "FAILED",
  runId: crypto.randomUUID(),
  assertions: {},
  retries: [],
  commands: [],
  observations: [],
};
const assertions: Record<string, boolean> = {};
evidence["assertions"] = assertions;
const commands: unknown[] = [];
evidence["commands"] = commands;
const observations: unknown[] = [];
evidence["observations"] = observations;
const retries: unknown[] = [];
evidence["retries"] = retries;
const clients = new Map<string, RpcClient>();
const unsubscribes: Array<() => void> = [];
const modelFailures = new Map<RpcClient, string>();
const retryCounts = new Map<RpcClient, number>();
let world: Awaited<ReturnType<typeof prepareQaWorld>> | undefined;
let herdr: ReturnType<typeof createHerdrClient> | undefined;
let failure: unknown;
let currentStep = "isolation";
const activeProcesses = new Set<ReturnType<typeof Bun.spawn>>();
const receipt = {
  home,
  homeRemoved: false,
  scratchRemoved: false,
  worldClosed: false,
  processesExited: false,
};
evidence["cleanup"] = receipt;

function check(name: string, condition: unknown): asserts condition {
  assertions[name] = Boolean(condition);
  assert.ok(condition, name);
}
function value<T>(result: Result<T>): T {
  assert.ok(result.ok, JSON.stringify(result));
  return result.value;
}
function registry<T>(action: (registry: Registry) => T): T {
  assert.ok(world);
  const registry = openRegistry(join(world.controlRoot, ".omo/state/registry.sqlite"), {
    readonly: true,
  });
  try {
    return action(registry);
  } finally {
    registry.close();
  }
}
function observe(step: string) {
  const bindings = registry((r) => value(r.list()));
  const owners = bindings.filter(
    (b) =>
      b.assignment.role === "child" &&
      b.assignment.issueId === "qa-issue-1" &&
      b.launchState !== "closed",
  );
  check(`oneLiveOwner:${step}`, owners.length === 1);
  observations.push({ step, bindings });
}
async function command(argv: string[], cwd = root, env: NodeJS.ProcessEnv = process.env) {
  const child = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  activeProcesses.add(child);
  const timer = setTimeout(
    () => child.kill("SIGKILL"),
    Math.min(120_000, Math.max(1, deadline - Date.now())),
  );
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const result = { code, stdout, stderr };
    commands.push({ step: currentStep, argv, ...result });
    return result;
  } finally {
    clearTimeout(timer);
    activeProcesses.delete(child);
  }
}
async function checked(argv: string[], cwd = root, env?: NodeJS.ProcessEnv) {
  const result = await command(argv, cwd, env);
  assert.equal(result.code, 0, `${argv.join(" ")}: ${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
async function cli(args: string[], env?: NodeJS.ProcessEnv) {
  assert.ok(world);
  return command(
    [
      "bun",
      join(world.controlRoot, "dist/cli.js"),
      "--root",
      world.controlRoot,
      "--herdr-socket",
      world.herdrSocket,
      ...args,
      "--json",
    ],
    world.controlRoot,
    { ...world.environment, HERDR_SOCKET_PATH: world.herdrSocket, ...env },
  );
}
const success = z.object({ ok: z.literal(true), value: z.unknown() });
async function invoke(args: string[], env?: NodeJS.ProcessEnv) {
  const result = await cli(args, env);
  assert.equal(result.code, 0, `${args.join(" ")}: ${result.stdout}\n${result.stderr}`);
  return success.parse(JSON.parse(result.stdout)).value;
}
const created = z.object({
  binding: bindingSchema,
  readiness: z.literal("ready"),
  execution: z.literal("brief_accepted"),
});
async function connect(binding: Binding) {
  const client = await attach(binding);
  clients.set(binding.id, client);
  unsubscribes.push(
    client.onEvent((event) => {
      if (
        event.type === "message_end" &&
        event.message.role === "assistant" &&
        event.message.stopReason === "error"
      )
        modelFailures.set(client, event.message.errorMessage ?? "Unspecified model failure");
    }),
  );
  await idle(client);
  return client;
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
// Subscribe before the action. Database change notifications and native events wake a
// state check; no polling or timing-based success. The timeout only bounds failure.
async function until(
  name: string,
  predicate: () => boolean | Promise<boolean>,
  trigger: () => Promise<unknown>,
  timeoutMs = 240_000,
) {
  assert.ok(world);
  currentStep = name;
  console.log("QA_STEP", name);
  const done = Promise.withResolvers<void>();
  let running = false;
  let dirty = false;
  let finished = false;
  const inspect = async () => {
    dirty = true;
    if (running || finished) return;
    running = true;
    try {
      while (dirty && !finished) {
        dirty = false;
        for (const [client, error] of modelFailures) {
          if ((await client.getState()).isStreaming) continue;
          modelFailures.delete(client);
          // OLW/tool failures are never retried or disguised as provider failures.
          assert.match(
            error,
            /429|50[0234]|rate.?limit|overload|provider|fetch failed|network|timeout|timed out|ECONN/i,
          );
          assert.equal(retryCounts.get(client) ?? 0, 0, `Provider retry exhausted: ${error}`);
          retryCounts.set(client, 1);
          retries.push({ step: name, error, attempt: 1 });
          await client.prompt(
            "The previous turn failed at the provider. Retry the unfinished step once. Inspect existing receipts first; do not duplicate completed messages or work.",
          );
        }
        if (await predicate()) {
          finished = true;
          done.resolve();
        }
      }
    } catch (error) {
      finished = true;
      done.reject(error);
    } finally {
      running = false;
    }
  };
  const notify = () => {
    void inspect();
  };
  const watcher = watch(join(world.controlRoot, ".omo/state"), notify);
  const stops = [...clients.values()].map((client) => client.onEvent(notify));
  const timeout = setTimeout(
    () => done.reject(new Error(`Timed out: ${name}`)),
    Math.min(timeoutMs, Math.max(1, deadline - Date.now())),
  );
  // Attach a rejection handler before the triggering CLI can itself fail.
  const outcome = done.promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  try {
    await trigger();
    notify();
    const error = await outcome;
    if (error !== undefined) throw error;
  } finally {
    finished = true;
    watcher.close();
    for (const stop of stops) stop();
    clearTimeout(timeout);
  }
}
async function textFile(name: string, text: string) {
  assert.ok(world);
  const path = join(world.scratch, `${name}.txt`);
  await writeFile(path, text);
  return path;
}
async function send(from: Binding, to: Binding, id: string, text: string) {
  return invoke([
    "send",
    "--from",
    from.id,
    "--to",
    to.id,
    "--id",
    id,
    "--kind",
    "instruction",
    "--text-file",
    await textFile(id, text),
  ]);
}
function delivery(id: string) {
  return registry((r) => {
    const result = r.delivery(id);
    if (!result.ok && result.error.code === "not_found") return undefined;
    return value(result);
  });
}
function questions() {
  return registry((r) => value(r.questions({})));
}
async function identity(binding: Binding, client: RpcClient, modelId: string, thinking: string) {
  const native = runtimeIdentitySchema.parse(
    success.parse(await client.requestExtension("omo.initiative.describe")).value,
  );
  check(
    `nativeModel:${binding.id}`,
    native.provider === "opencodex" &&
      native.modelId === modelId &&
      native.thinking === thinking &&
      native.cwd === binding.cwd &&
      native.durableSessionId === binding.durableSessionId &&
      native.sessionPath === binding.sessionPath,
  );
  observations.push({ nativeIdentity: native });
}

try {
  await mkdir(evidenceDir, { recursive: true });
  // Copy credentials/catalog, never link writable global state. No global settings mutation.
  const agent = join(home, ".omo/agent");
  await mkdir(agent, { recursive: true });
  // Herdr uses the login shell; an empty isolated home otherwise opens zsh's
  // first-run wizard and consumes the role launch command as wizard input.
  await writeFile(join(home, ".zshrc"), "# Isolated QA shell; no first-run wizard.\n");
  for (const file of ["models.json", "auth.json"])
    await cp(join(originalHome, ".omo/agent", file), join(agent, file));
  await cp(join(originalHome, ".omo/omo.jsonc"), join(home, ".omo/omo.jsonc"));
  const settings = z
    .object({
      defaultProvider: z.string(),
      defaultModel: z.string(),
      defaultThinkingLevel: z.string(),
    })
    .parse(JSON.parse(await readFile(join(originalHome, ".omo/agent/settings.json"), "utf8")));
  await writeFile(
    join(agent, "settings.json"),
    JSON.stringify({ ...settings, permissionPreset: "full-access" }),
  );
  const bin = join(home, "bin");
  await mkdir(bin);
  await symlink(upstream, join(bin, "omo"));
  const pins = z
    .object({ dependencies: z.record(z.string(), z.string()) })
    .parse(JSON.parse(await readFile(join(root, "package.json"), "utf8"))).dependencies;
  await writeFile(
    join(bin, "npm"),
    `#!/bin/sh\ncase "$*" in\n*'@code-yeongyu/senpi'*) printf '%s\\n' '${JSON.stringify({ latest: pins["@code-yeongyu/senpi"] })}';;\n*'omo-ai'*) printf '%s\\n' '${JSON.stringify({ beta: pins["omo-ai"] })}';;\n*) echo 'Unexpected QA npm command' >&2; exit 2;;\nesac\n`,
    { mode: 0o700 },
  );
  for (const key of Object.keys(process.env)) {
    if (
      key.startsWith("PI_") ||
      key.startsWith("HERDR_") ||
      key.startsWith("OLW_") ||
      key.startsWith("OMO_") ||
      key.startsWith("SENPI_")
    )
      delete process.env[key];
  }
  Object.assign(process.env, {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_STATE_HOME: join(home, ".local/state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    OMO_CODING_AGENT_DIR: agent,
    SENPI_CODING_AGENT_DIR: agent,
    HERDR_ENV: "1",
    PATH: `${bin}:${process.env["PATH"]}`,
    GIT_AUTHOR_NAME: "OLW QA",
    GIT_AUTHOR_EMAIL: "olw-qa@localhost",
    GIT_COMMITTER_NAME: "OLW QA",
    GIT_COMMITTER_EMAIL: "olw-qa@localhost",
  });
  await checked(["bun", "run", "build"]);
  await checked([
    "bun",
    join(root, "dist/proxy/routing.js"),
    "sync",
    "--adopt",
    "--upstream",
    join(bin, "omo"),
  ]);
  const qa = await prepareQaWorld();
  world = qa;
  await writeFile(join(agent, "trust.json"), JSON.stringify({ [qa.scratch]: true }));
  evidence["ownedCleanup"] = world.cleanup;
  evidence["scratch"] = world.scratch;
  evidence["controlRoot"] = world.controlRoot;
  console.log("QA_WORLD", world.scratch);
  herdr = createHerdrClient(world.herdrSocket);
  const fixture = world.repository;
  const fixtureGuidance = `# Isolated OLW QA\nOnly act on explicit issue packets. A role initialization brief is NOT a task: acknowledge it in one sentence and end the turn, without tools, discovery, planning, goals or todos. No onboarding or migration is needed.\nKeep this fixture run small. Do not print environment variables or secrets. Use absolute paths in the explicit packet, and set subprocess cwd to the assigned checkout. No live Linear, GitHub or network changes. No global settings changes.\nThe product-format question is a product decision for the manager, not the parent. Plan approval is a parent decision. Questions must use olw_ask; wait by ending the turn, never polling.\n`;
  await writeFile(join(qa.controlRoot, "AGENTS.md"), fixtureGuidance);
  await writeFile(join(fixture, "AGENTS.md"), fixtureGuidance);
  await writeFile(
    join(fixture, "package.json"),
    JSON.stringify({
      name: "qa-version",
      version: "1.2.3",
      type: "module",
      scripts: { test: "bun test" },
    }),
  );
  await writeFile(
    join(fixture, "cli.ts"),
    'console.error("Unknown command");\nprocess.exitCode = 2;\n',
  );
  await writeFile(
    join(fixture, "version.test.ts"),
    'import { expect, test } from "bun:test";\nimport pkg from "./package.json";\ntest("version prints the package version", async () => {\n  const child = Bun.spawn([process.execPath, "cli.ts", "version"], { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" });\n  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);\n  expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: pkg.version + "\\n", stderr: "" });\n});\n',
  );
  await checked(["git", "add", "."], fixture);
  await checked(["git", "commit", "-m", "test: version command fixture"], fixture);
  const remote = join(world.scratch, "fixture.git");
  await checked(["git", "clone", "--bare", fixture, remote]);
  const scopePath = join(world.scratch, "scope.json");
  const ref = (id: string, key: string) => ({
    id,
    key,
    url: key.startsWith("P-")
      ? "https://linear.app/qa/project/version-command-abcdef123456"
      : `https://linear.app/qa/issue/${key}/version-command`,
    revision: "1",
  });
  await writeFile(
    scopePath,
    JSON.stringify({
      version: 1,
      source: "fixture",
      initiative: null,
      projects: [
        {
          project: ref("qa-project", "P-QA-1"),
          issues: [ref("qa-issue-1", "QA-1"), ref("qa-issue-2", "QA-2")],
          repository: { remote: pathToFileURL(remote).href, defaultBranch: "main" },
        },
      ],
      decisionRefs: [ref("product-decision-version-format", "PRODUCT-DECISION")],
    }),
  );
  const imported = z
    .object({ digest: z.string() })
    .parse(await invoke(["scope", "import", "--file", scopePath, "--fixture"]));
  const manager = z.object({ binding: bindingSchema }).parse(await invoke(["manage"])).binding;
  const managerClient = await connect(manager);
  check(
    "managerLabelAndUpdateLine",
    manager.assignment.role === "manager" &&
      manager.initialization.text?.includes("update_check:") &&
      (await herdr.snapshot()).workspaces.some(
        (w) => w.workspaceId === manager.workspaceId && w.label === "manager",
      ),
  );
  const secondManager = z
    .object({ binding: bindingSchema })
    .parse(await invoke(["manage"])).binding;
  check(
    "manageIdempotent",
    secondManager.id === manager.id &&
      registry((r) => value(r.list())).filter((b) => b.assignment.role === "manager").length ===
        1 &&
      (await herdr.snapshot()).workspaces.filter((w) => w.label === "manager").length === 1,
  );
  const focus = (await herdr.snapshot()).focusedWorkspaceId;
  const parent = created.parse(
    await invoke(
      [
        "parent",
        "create",
        "--project",
        "qa-project",
        "--scope-digest",
        imported.digest,
        "--designation",
        "qa-two-stage",
        "--execute",
        "--fixture",
      ],
      { OLW_MANAGER_BINDING: manager.id },
    ),
  ).binding;
  const parentClient = await connect(parent);
  check(
    "autoLinkedToManager",
    parent.assignment.role === "parent" && parent.assignment.ownerBindingId === manager.id,
  );
  check(
    "ownedCloneNoUserRepo",
    parent.checkout?.kind === "owned-clone" &&
      parent.cwd.startsWith(`${world.controlRoot}/.omo/checkouts/`) &&
      parent.checkout.remote === pathToFileURL(remote).href &&
      (await checked(["git", "rev-parse", "--git-common-dir"], parent.cwd)).trim() === ".git",
  );
  const plan = created.parse(
    await invoke([
      "child",
      "create",
      "--parent",
      parent.id,
      "--issue",
      "qa-issue-1",
      "--mode",
      "planned",
      "--deliverable",
      "report",
    ]),
  ).binding;
  const planClient = await connect(plan);
  await identity(plan, planClient, "anthropic/claude-fable-5-1", "xhigh");
  observe("plan-created");
  const cliPrefix = `bun ${join(world.controlRoot, "dist/cli.js")} --root ${world.controlRoot} --herdr-socket ${world.herdrSocket}`;
  // Parent still performs real escalation/approval; only the product decision is
  // deliberately answered by the QA operator through the manager's CLI identity.
  await until(
    "parent-brief",
    async () =>
      (await parentClient.getMessages()).some(
        (m) => m.role === "assistant" && messageText(m).includes("PARENT_QA_READY"),
      ),
    () =>
      send(
        manager,
        parent,
        "parent-qa-brief",
        `QA coordination instructions for the explicit fixture scope. Do not implement or create roles, goals or workers. CLI: ${cliPrefix}. Your binding is ${parent.id}. On a child question whose question item id is product-format: this is PRODUCT-DECISION, beyond parent authority. Escalate with 'ask --from ${parent.id} --id product-escalation --text-file <file> --questions-file <file> --json'. The questions JSON must contain the same questions array and escalates equal to the child's envelope id. Tell the manager to wait for the QA operator's CLI answer, not use a question tool. Do not answer the child until the manager answers. On that answer, run 'answer --from ${parent.id} --question <original child question envelope id> --text-file <file> --json' forwarding the manager's decision. On a plan-approval question, read .omo/plans/QA-1.md in ${plan.cwd} then approve using answer, telling the child to stage complete. Never start execute yourself; the QA operator will call stage start in your identity. For any report just reply TWO_STAGE_REPORT_RECEIVED and stop; no forwarding. For now reply PARENT_QA_READY and stop.`,
      ),
  );
  await idle(parentClient);
  if (!breakAnswer) {
    const before = await checked(["git", "status", "--porcelain"], plan.cwd);
    await until(
      "mode-mismatch",
      () => delivery("report:qa-wrong-mode")?.state === "accepted",
      () =>
        send(
          parent,
          plan,
          "qa-wrong-mode",
          `Explicit issue packet qa-wrong-mode: mode direct, implement the version command immediately. If your bound mode/stage differs, do no work and report blocked once with id report:qa-wrong-mode via ${cliPrefix} report --from ${plan.id} --id report:qa-wrong-mode --outcome blocked --text-file <file outside the checkout, under ${qa.scratch}> --json. Parent: reply TWO_STAGE_REPORT_RECEIVED only.`,
        ),
    );
    await Promise.all([idle(planClient), idle(parentClient)]);
    check(
      "wrongModeBlockedWithoutWork",
      delivery("report:qa-wrong-mode")?.envelope.outcome === "blocked" &&
        (await checked(["git", "status", "--porcelain"], plan.cwd)) === before,
    );
  }
  const packet = `qa-plan-${crypto.randomUUID()}`;
  const planPath = join(plan.cwd, ".omo/plans/QA-1.md");
  await until(
    "product-question-escalated",
    () =>
      questions().some(
        (q) =>
          q.record.envelope.fromBindingId === parent.id &&
          q.record.envelope.question?.escalates !== null &&
          q.record.state === "accepted",
      ),
    () =>
      send(
        parent,
        plan,
        packet,
        `Explicit issue packet ${packet}. Mode planned; your current stage is plan, not execute. QA-1: add a version command printing package.json version. Read the existing cli.ts, package.json and version.test.ts. Create one explicit packet-bound goal before asking. Product decision: should output be the bare version or a v-prefixed version? Before planning call olw_ask with exactly one question item id product-format and options 'bare (recommended)' and 'v-prefixed'; say this is PRODUCT-DECISION for the manager. End your turn; do not implement while waiting. After the answer wakes you, write a tiny three-todo plan at ${planPath}, covering implementation, test and report. Read olw-run and ulw-plan; the fixture explicitly declines high-accuracy review, no review workers. Then request plan approval ONLY through olw_ask with item id plan-approval; end your turn. On approval call ${cliPrefix} stage complete --from ${plan.id} --plan ${planPath} --head <actual git HEAD> --id qa-plan-handoff --text-file <your handoff file under ${qa.scratch}> --json. Parent should reply TWO_STAGE_REPORT_RECEIVED only. No commits, implementation, extra roles or polling in plan stage. No live Linear or remote writes. Stop after accepted handoff.`,
      ),
  );
  await Promise.all([idle(planClient), idle(parentClient), idle(managerClient)]);
  const product = questions().find(
    (q) =>
      q.record.envelope.fromBindingId === plan.id &&
      q.record.envelope.question?.questions.some((q) => q.id === "product-format"),
  );
  assert.ok(product);
  const escalation = questions().find(
    (q) => q.record.envelope.question?.escalates === product.record.envelope.id,
  );
  assert.ok(escalation);
  evidence["productQuestion"] = product;
  evidence["escalation"] = escalation;
  check(
    "olwAskDelivered",
    product.record.state === "accepted" &&
      (await planClient.getMessages()).some(
        (m) =>
          m.role === "assistant" &&
          m.content.some((part) => part.type === "toolCall" && part.name === "olw_ask"),
      ),
  );
  check(
    "parentEscalatedToManager",
    escalation.record.state === "accepted" &&
      escalation.record.envelope.fromBindingId === parent.id &&
      escalation.record.envelope.toBindingId === manager.id,
  );
  observe("question-waiting");
  assert.ok(plan.sessionPath);
  const goalPath = join(
    dirname(plan.sessionPath),
    "extensions/goal",
    `${encodeURIComponent(plan.durableSessionId)}.json`,
  );
  const goal = z
    .object({ goal: z.object({ id: z.string(), status: z.string() }) })
    .parse(JSON.parse(await readFile(goalPath, "utf8")));
  check("questionPausedGoal", goal.goal.status === "paused");
  const messagesBeforeReload = await planClient.getMessages();
  check("reloadNotCancelled", !(await planClient.reload()).cancelled);
  await planClient.requestExtension("omo.initiative.describe");
  check(
    "reloadKeptQuestionWait",
    !(await planClient.getState()).isStreaming &&
      JSON.stringify(await planClient.getMessages()) === JSON.stringify(messagesBeforeReload),
  );
  const waitingStatus = await invoke(["status"]);
  evidence["waitingStatus"] = waitingStatus;
  const statusSchema = z.array(
    z.object({
      id: z.string(),
      mode: z.string().optional(),
      stage: z.string().optional(),
      stageBindings: z.array(z.unknown()).optional(),
      openQuestions: z.number().optional(),
    }),
  );
  check(
    "statusOpenQuestion",
    statusSchema
      .parse(waitingStatus)
      .some(
        (b) =>
          b.id === plan.id &&
          b.mode === "planned" &&
          b.stage === "plan" &&
          (b.openQuestions ?? 0) > 0,
      ),
  );
  const answerPath = await textFile(
    "product-answer",
    "Product decision: bare version only, with a trailing newline, no v prefix. Forward this decision to the original child question using olw answer. Do not implement. QA operator answered in the manager identity.",
  );
  if (breakAnswer) {
    const messagesBefore = await planClient.getMessages();
    const result = await cli([
      "answer",
      "--from",
      parent.id,
      "--question",
      `question:${plan.id}:does-not-exist`,
      "--text-file",
      answerPath,
    ]);
    evidence["wrongAnswer"] = result;
    check(
      "questionUnknownExit2",
      result.code === 2 &&
        z
          .object({
            ok: z.literal(false),
            error: z.object({ code: z.literal("question_unknown") }),
          })
          .safeParse(JSON.parse(result.stdout)).success,
    );
    check(
      "childStillWaitingNoReport",
      questions().some((q) => q.record.envelope.id === product.record.envelope.id && !q.answered) &&
        !(await planClient.getState()).isStreaming &&
        JSON.stringify(await planClient.getMessages()) === JSON.stringify(messagesBefore) &&
        delivery("qa-plan-handoff") === undefined &&
        !existsSync(planPath),
    );
    observe("wrong-answer-rejected");
  } else {
    evidence["answeringParty"] = {
      role: "manager",
      bindingId: manager.id,
      driver: "QA CLI operator",
      parentForwarding: "real model",
    };
    await until(
      "answer-approval-handoff",
      () => delivery("qa-plan-handoff")?.state === "accepted",
      () =>
        invoke([
          "answer",
          "--from",
          manager.id,
          "--question",
          escalation.record.envelope.id,
          "--text-file",
          answerPath,
        ]),
      420_000,
    );
    await Promise.all([idle(planClient), idle(parentClient)]);
    const approval = questions().find(
      (q) =>
        q.record.envelope.fromBindingId === plan.id &&
        q.record.envelope.question?.questions.some((q) => q.id === "plan-approval"),
    );
    assert.ok(approval);
    evidence["approval"] = approval;
    evidence["questions"] = questions();
    check(
      "approvalArrivedAsQuestion",
      approval.record.envelope.kind === "question" &&
        approval.record.envelope.toBindingId === parent.id &&
        approval.record.state === "accepted",
    );
    check("approvalAnswerAccepted", approval.answer?.state === "accepted");
    check(
      "escalationAnswerRoundTrip",
      delivery(`answer:${escalation.record.envelope.id}`)?.state === "accepted" &&
        delivery(`answer:${product.record.envelope.id}`)?.state === "accepted",
    );
    check(
      "answerWokeChild",
      delivery(`answer:${product.record.envelope.id}`)?.receipt?.kind === "ok" &&
        existsSync(planPath) &&
        (await planClient.getMessages()).filter(
          (m) =>
            m.role === "user" && messageText(m).includes(`answer:${product.record.envelope.id}`),
        ).length === 1 &&
        delivery(`answer:${product.record.envelope.id}`)?.attempts?.length === 1,
    );
    evidence["planTranscript"] = await planClient.getMessages();
    evidence["plan"] = await readFile(planPath, "utf8");
    observe("handoff-recorded");
    const herdrEvents: unknown[] = [];
    evidence["herdrEvents"] = herdrEvents;
    const stopHerdr = await herdr.subscribe((event) => herdrEvents.push(event));
    unsubscribes.push(stopHerdr);
    // The QA attachment must be gone before OLW verifies the plan engine is gone.
    await planClient.closeSession();
    await planClient.stop();
    clients.delete(plan.id);
    const execute = created.parse(
      await invoke([
        "stage",
        "start",
        "--from",
        plan.id,
        "--parent",
        parent.id,
        "--stage",
        "execute",
        "--id",
        "qa-execute-start",
      ]),
    ).binding;
    const executeClient = await connect(execute);
    await identity(execute, executeClient, "anthropic/claude-opus-5-5", "medium");
    observe("execute-created");
    evidence["herdrEvents"] = herdrEvents;
    check(
      "planTuiExitedAndEngineTerminated",
      herdrEvents.some((event) => planPaneExited(event, plan.paneId ?? "")) &&
        !(await executeClient.listSessions()).some(
          (s) => s.durableSessionId === plan.durableSessionId,
        ) &&
        (await herdr.snapshot()).panes.some(
          (p) => p.paneId === plan.paneId && p.sessionPath === null,
        ),
    );
    check(
      "sameWorktreeBranchWorkspace",
      execute.cwd === plan.cwd &&
        execute.checkout?.branch === plan.checkout?.branch &&
        execute.workspaceId === plan.workspaceId &&
        execute.paneId !== plan.paneId,
    );
    // Official CLI returns the full snapshot including tab labels (the client projection omits tabs).
    const snapshotResult = await checked(
      [
        world.environment.QA_HERDR_BINARY,
        "--session",
        world.environment.HERDR_SESSION,
        "api",
        "snapshot",
      ],
      world.controlRoot,
      world.environment,
    );
    evidence["fullSnapshot"] = JSON.parse(snapshotResult);
    check(
      "planThenExecuteTabs",
      snapshotResult.includes('"plan"') && snapshotResult.includes('"execute"'),
    );
    const status = statusSchema.parse(await invoke(["status"]));
    evidence["executeStatus"] = status;
    check(
      "statusPlannedExecuteTwoBindings",
      status.some(
        (b) =>
          b.id === execute.id &&
          b.mode === "planned" &&
          b.stage === "execute" &&
          b.stageBindings?.length === 2 &&
          b.openQuestions === 0,
      ),
    );
    const executePacket = `qa-execute-${crypto.randomUUID()}`;
    const reportId = `report:${executePacket}`;
    await until(
      "execute-report",
      () => delivery(reportId)?.state === "accepted",
      () =>
        send(
          parent,
          execute,
          executePacket,
          `Explicit issue packet ${executePacket}. Mode planned, stage execute. Implement the approved plan ${planPath} for QA-1: bun cli.ts version must print exactly package.json version plus newline (no v). Read olw-run, ulw-execute and mass-ulw. Tiny scope: cli.ts only, do not edit package.json or version.test.ts. Run bun test and bun cli.ts version. No remote writes, no Linear, no new OLW roles. Commit only the verified cli.ts implementation locally. Write a short report with actual HEAD, branch, test command/results under ${qa.scratch}; report exactly once using ${cliPrefix} report --from ${execute.id} --id ${reportId} --outcome completed --evidence ${planPath} --deliverable-path <report path> --text-file <report path> --json. Parent: reply TWO_STAGE_REPORT_RECEIVED only. Stop after accepted report.`,
        ),
      600_000,
    );
    await Promise.all([idle(executeClient), idle(parentClient)]);
    const report = delivery(reportId);
    assert.ok(report);
    evidence["report"] = report;
    const head = (await checked(["git", "rev-parse", "HEAD"], execute.cwd)).trim();
    check(
      "reportAtVerifiedHead",
      report.envelope.outcome === "completed" && report.envelope.text.includes(head),
    );
    await checked(["bun", "test"], execute.cwd);
    check(
      "versionCommandAndTest",
      (await checked(["bun", "cli.ts", "version"], execute.cwd)) === "1.2.3\n",
    );
    check(
      "reportDeliveredOnce",
      (await parentClient.getMessages()).filter(
        (m) => m.role === "user" && messageText(m).includes(`"id":"${reportId}"`),
      ).length === 1 && report.attempts?.length === 1,
    );
    observe("execute-reported");
    const direct = created.parse(
      await invoke([
        "child",
        "create",
        "--parent",
        parent.id,
        "--issue",
        "qa-issue-2",
        "--deliverable",
        "report",
      ]),
    ).binding;
    const directClient = await connect(direct);
    await identity(direct, directClient, "anthropic/claude-opus-5-5", "xhigh");
    await until(
      "direct-report",
      () => delivery("report:qa-direct")?.state === "accepted",
      () =>
        send(
          parent,
          direct,
          "qa-direct",
          `Explicit direct issue packet qa-direct for QA-2. Write qa-direct.txt containing exactly DIRECT\\n and verify its bytes. Read olw-run and mass-ulw. No other repository edits, commits, remote writes, Linear or roles. Report once via ${cliPrefix} report --from ${direct.id} --id report:qa-direct --outcome completed --deliverable-path <report file under ${qa.scratch}> --text-file <report file under ${qa.scratch}> --json. Parent reply TWO_STAGE_REPORT_RECEIVED only; stop.`,
        ),
      420_000,
    );
    await Promise.all([idle(directClient), idle(parentClient)]);
    check(
      "directModeUnchanged",
      (await readFile(join(direct.cwd, "qa-direct.txt"), "utf8")) === "DIRECT\n" &&
        delivery("report:qa-direct")?.envelope.outcome === "completed",
    );
    const final = await herdr.snapshot();
    evidence["snapshot"] = final;
    check(
      "readableLabels",
      ["manager", "P-QA-1", "QA-1", "QA-2"].every((key) =>
        final.workspaces.some((w) => w.label?.startsWith(key)),
      ),
    );
    check("focusUnchangedExceptManage", final.focusedWorkspaceId === focus);
  }
  evidence["result"] = "PASS";
} catch (error) {
  failure = error;
  evidence["failedStep"] = currentStep;
  evidence["error"] = error instanceof Error ? error.stack : String(error);
  if (world && herdr) {
    try {
      const snapshot = await herdr.snapshot();
      evidence["failureSnapshot"] = snapshot;
      evidence["failureBindings"] = registry((r) => value(r.list()));
      const panes: unknown[] = [];
      for (const pane of snapshot.panes) {
        panes.push({
          paneId: pane.paneId,
          output: await command(
            [
              world.environment.QA_HERDR_BINARY,
              "--session",
              world.environment.HERDR_SESSION,
              "pane",
              "read",
              pane.paneId,
              "--source",
              "recent",
              "--lines",
              "150",
            ],
            world.controlRoot,
            world.environment,
          ),
        });
      }
      evidence["failurePanes"] = panes;
    } catch (captureError) {
      evidence["captureError"] = String(captureError);
    }
  }
} finally {
  for (const stop of unsubscribes) stop();
  const transcripts: Record<string, unknown> = {};
  for (const [id, client] of clients) {
    try {
      transcripts[id] = await client.getMessages();
      if ((await client.getState()).isStreaming) await client.abort();
      await client.closeSession();
      await client.stop();
    } catch (error) {
      failure ??= error;
      transcripts[`${id}:cleanupError`] = String(error);
    }
  }
  evidence["transcripts"] = transcripts;
  herdr?.close();
  for (const child of activeProcesses) {
    child.kill("SIGKILL");
    await child.exited;
  }
  try {
    if (world) {
      await world.close();
      receipt.worldClosed = true;
      receipt.scratchRemoved = !existsSync(world.scratch);
    }
    await rm(home, { recursive: true, force: true });
    receipt.homeRemoved = !existsSync(home);
    receipt.processesExited = activeProcesses.size === 0 && receipt.worldClosed;
  } catch (error) {
    failure ??= error;
    evidence["cleanupError"] = String(error);
  }
  if (failure) evidence["result"] = "FAILED";
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
}
if (failure) throw failure;
console.log(`TWO_STAGE_QA_PASS ${breakAnswer ? "break-answer" : "happy"}: ${evidencePath}`);
