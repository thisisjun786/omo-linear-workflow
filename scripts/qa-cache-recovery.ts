import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { RpcClient } from "@code-yeongyu/senpi";
import { z } from "zod";
import type { Binding } from "../src/core/contracts";
import { initializationMessageId } from "../src/core/policy";
import { bindingSchema } from "../src/core/schema";
import { createHerdrClient } from "../src/herdr";
import { readHostStatus } from "../src/host-profile";
import { exercise } from "./qa-cache-isolation";
import { attach, idle } from "./qa-hierarchy";
import { checkedQaCommand, prepareQaWorld } from "./qa-world";

const success = z.object({ ok: z.literal(true), value: z.unknown() });
const created = z.object({ binding: bindingSchema });
const evidence = join(import.meta.dir, "../.omo/evidence/real-use-repairs/host-recovery");

async function settledPrompt(client: RpcClient, text: string) {
  const done = Promise.withResolvers<void>();
  const timer = setTimeout(() => done.reject(new Error("Recovery turn did not settle")), 120_000);
  const off = client.onEvent((event) => {
    if (event.type === "agent_settled") done.resolve();
  });
  try {
    await Promise.all([client.prompt(text), done.promise]);
  } finally {
    off();
    clearTimeout(timer);
  }
}

async function closeOwnedFrontend(
  qa: Awaited<ReturnType<typeof prepareQaWorld>>,
  binding: Binding,
) {
  const paneId = binding.paneId;
  assert.ok(paneId && binding.sessionPath);
  const session = basename(dirname(qa.herdrSocket));
  const schema = z.object({
    result: z.object({
      process_info: z.object({
        pane_id: z.literal(binding.paneId),
        shell_pid: z.number(),
        foreground_processes: z
          .array(
            z.object({
              pid: z.number(),
              argv: z.array(z.string()).optional(),
              cwd: z.string().optional(),
            }),
          )
          .default([]),
      }),
    }),
  });
  const info = async () =>
    schema.parse(
      JSON.parse(
        await checkedQaCommand(
          ["herdr", "--session", session, "pane", "process-info", "--pane", paneId],
          qa.repository,
          qa.environment,
        ),
      ),
    ).result.process_info;
  const before = await info();
  const path = binding.sessionPath;
  const targets = before.foreground_processes.filter(
    (process) => process.cwd === binding.cwd && process.argv?.includes(path),
  );
  assert.ok(targets.length > 0, JSON.stringify(before));
  const waiters = await Promise.all(
    targets.map(async (target) => {
      const pidFile = join(qa.scratch, `frontend-${target.pid}.pid`);
      await writeFile(pidFile, `${target.pid}\n`, { flag: "wx", mode: 0o600 });
      const process = Bun.spawn(["pidwait", "-F", pidFile], { stdout: "pipe", stderr: "pipe" });
      return {
        pid: target.pid,
        process,
        stderr: new Response(process.stderr).text(),
        stdout: new Response(process.stdout).text(),
      };
    }),
  );
  const deadline = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => deadline.reject(new Error("Owned TUI did not exit after Ctrl-D")),
    30_000,
  );
  try {
    await checkedQaCommand(
      ["herdr", "--session", session, "pane", "send-keys", paneId, "ctrl+d"],
      qa.repository,
      qa.environment,
    );
    const codes = await Promise.race([
      Promise.all(waiters.map((waiter) => waiter.process.exited)),
      deadline.promise,
    ]);
    for (const [index, waiter] of waiters.entries()) {
      assert.ok(codes[index] === 0 || codes[index] === 1, await waiter.stderr);
      assert.equal(await waiter.stderr, "");
    }
    const after = await info();
    assert.equal(after.shell_pid, before.shell_pid);
    assert.ok(after.foreground_processes.every((process) => !process.argv?.includes(path)));
    return {
      paneId,
      before,
      after,
      waiterExits: codes,
      outputs: await Promise.all(waiters.map((waiter) => waiter.stdout)),
    };
  } finally {
    clearTimeout(timer);
    for (const waiter of waiters) {
      if (waiter.process.exitCode === null) waiter.process.kill("SIGTERM");
      await waiter.process.exited;
    }
  }
}

async function main() {
  await mkdir(evidence, { recursive: true });
  const shared = await mkdtemp(join(evidence, "cache-recovery-"));
  let world: Awaited<ReturnType<typeof prepareQaWorld>> | undefined;
  const clients: RpcClient[] = [];
  const log: {
    result: string;
    warm?: unknown;
    root?: string;
    failure?: unknown;
    handoff?: unknown;
    recovery?: unknown;
    frontendExits?: unknown;
    cleanup?: string;
    cleanupError?: string;
    error?: string;
  } = { result: "incomplete" };
  let failure: unknown;
  try {
    const warm = await exercise(shared);
    log.warm = warm;
    assert.equal(warm.sessions.flatMap((session) => session.errors).length, 0);
    assert.equal(await Bun.file(join(warm.root, "dist/proxy/index.js")).exists(), false);
    console.log("QA_PHASE warm root removed; shared cache retained as negative control");
    world = await prepareQaWorld();
    const qa = world;
    log.root = qa.controlRoot;
    const invoke = async (args: string[]) => {
      const result = await qa.cli(args);
      assert.equal(result.code, 0, JSON.stringify(result));
      return success.parse(JSON.parse(result.stdout)).value;
    };
    const builderPath = join(qa.controlRoot, "qa-profile-builder.ts");
    await cp(join(qa.installRoot, "src/host-profile.ts"), builderPath);
    const builder: typeof import("../src/host-profile") = await import(
      pathToFileURL(builderPath).href
    );
    const profile = await builder.createHostProfile(qa.controlRoot);
    const socket = join(qa.controlRoot, ".omo/state/omo.sock");
    const executable = join(qa.controlRoot, "node_modules/.bin/omo");
    await checkedQaCommand(
      [
        executable,
        "host",
        "ensure",
        "--launch-spec",
        profile,
        "--socket",
        socket,
        "--policy",
        "never",
      ],
      qa.controlRoot,
      {
        ...qa.environment,
        XDG_CACHE_HOME: join(shared, "host"),
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(shared, "cli"),
      },
    );
    const scopePath = join(qa.scratch, "scope.json");
    await cp(join(qa.installRoot, "tests/fixtures/scope.json"), scopePath);
    const { digest } = z
      .object({ digest: z.string() })
      .parse(await invoke(["scope", "import", "--file", scopePath, "--fixture"]));
    const supervisor = created.parse(
      await invoke([
        "supervisor",
        "create",
        "--initiative",
        "initiative-omo-1",
        "--scope-digest",
        digest,
        "--designation",
        "cache-recovery-qa",
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
        qa.repository,
        "--base",
        "main",
      ]),
    ).binding;
    const supervisorRpc = await attach(supervisor);
    const parentRpc = await attach(parent);
    clients.push(supervisorRpc, parentRpc);
    await idle(supervisorRpc);
    await idle(parentRpc);
    let errors = (await parentRpc.getMessages()).filter(
      (message) => message.role === "assistant" && message.stopReason === "error",
    );
    if (errors.length === 0) {
      await settledPrompt(
        parentRpc,
        `For owned cache QA, use read on ${join(parent.cwd, "README.md")} and acknowledge.`,
      );
      errors = (await parentRpc.getMessages()).filter(
        (message) => message.role === "assistant" && message.stopReason === "error",
      );
    }
    assert.ok(
      errors.some(
        (message) =>
          message.role === "assistant" &&
          message.errorMessage?.includes(warm.root) &&
          message.errorMessage.includes("extension-runtime-module"),
      ),
      JSON.stringify(errors),
    );
    const before = await parentRpc.getState();
    assert.equal(before.model?.id, "claude-opus-5-5");
    assert.equal(before.thinkingLevel, "xhigh");
    const briefCount = (messages: Awaited<ReturnType<RpcClient["getMessages"]>>) =>
      messages.filter((message) => {
        if (message.role !== "user") return false;
        const text =
          typeof message.content === "string"
            ? message.content
            : message.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("");
        return (
          text.includes(`"id":${JSON.stringify(initializationMessageId(parent.id))}`) &&
          text.includes(`"text":${JSON.stringify(parent.initialization.text)}`)
        );
      }).length;
    const countBefore = briefCount(await parentRpc.getMessages());
    log.failure = { supervisor, parent, before, errors, countBefore };
    assert.equal(countBefore, 1);
    const herdr = createHerdrClient(qa.herdrSocket);
    const layoutBefore = await herdr.snapshot();
    herdr.close();
    log.failure = { supervisor, parent, before, errors, countBefore, layoutBefore };
    console.log("QA_PHASE real deleted warm-root import reproduced in the parent");
    const frontendExits = [];
    for (const binding of [supervisor, parent])
      frontendExits.push(await closeOwnedFrontend(qa, binding));
    log.frontendExits = frontendExits;
    for (const client of clients.splice(0)) await client.stop();
    const beforeHost = await readHostStatus(qa.controlRoot, socket, qa.environment);
    const handoff = await checkedQaCommand(
      [executable, "host", "handoff", "--launch-spec", profile, "--socket", socket],
      qa.controlRoot,
      {
        ...qa.environment,
        ...builder.runtimeCacheEnvironment(qa.controlRoot),
      },
    );
    const afterHost = await readHostStatus(qa.controlRoot, socket, qa.environment);
    assert.ok(
      afterHost.generation !== null &&
        beforeHost.generation !== null &&
        afterHost.generation > beforeHost.generation,
    );
    let recovered: RpcClient | undefined;
    for (const binding of [supervisor, parent]) {
      const client = new RpcClient({ socketPath: socket });
      clients.push(client);
      await client.start();
      assert.ok(binding.sessionPath);
      const opened = await client.openSession({
        sessionPath: binding.sessionPath,
        cwd: binding.cwd,
        retain_on_disconnect: true,
      });
      assert.equal(opened.state.sessionId, binding.durableSessionId);
      if (binding.id === parent.id) recovered = client;
    }
    assert.ok(recovered);
    const reconciled = await invoke(["reconcile", "--initiative", "initiative-omo-1"]);
    const artifact = join(parent.cwd, "cache-recovery.txt");
    assert.equal(await Bun.file(artifact).exists(), false);
    const prior = (await recovered.getMessages()).length;
    await settledPrompt(
      recovered,
      `The owned cache QA fault is removed. Read ${join(parent.cwd, "README.md")} with native read, then use eval to call tool.bash({command: "pwd"}). Write exactly RECOVERED followed by one newline to ${artifact}. Do not edit other files, create children, commit, contact Linear, or report business completion.`,
    );
    const messages = await recovered.getMessages();
    const added = messages.slice(prior).filter((message) => message.role === "assistant");
    assert.ok(added.every((message) => message.stopReason !== "error"));
    const names = added.flatMap((message) =>
      message.content.filter((part) => part.type === "toolCall").map((part) => part.name),
    );
    assert.ok(names.includes("read") && names.includes("eval"), JSON.stringify(names));
    assert.equal(await readFile(artifact, "utf8"), "RECOVERED\n");
    assert.equal(briefCount(messages), 1);
    const after = await recovered.getState();
    assert.equal(after.sessionId, before.sessionId);
    assert.equal(after.sessionFile, before.sessionFile);
    assert.equal(after.cwd, before.cwd);
    assert.equal(after.model?.id, "claude-opus-5-5");
    assert.equal(after.thinkingLevel, "xhigh");
    const layoutClient = createHerdrClient(qa.herdrSocket);
    const layoutAfter = await layoutClient.snapshot();
    layoutClient.close();
    assert.equal(layoutAfter.focusedWorkspaceId, layoutBefore.focusedWorkspaceId);
    assert.deepEqual(layoutAfter.workspaces, layoutBefore.workspaces);
    log.handoff = { raw: JSON.parse(handoff), beforeHost, afterHost };
    log.recovery = {
      reconciled,
      after,
      artifact,
      artifactBytes: "RECOVERED\n",
      tools: names,
      countAfter: briefCount(messages),
      layoutAfter,
    };
    log.result = "pass";
  } catch (error) {
    failure = error;
    log.error = String(error);
    log.result = "failed";
  } finally {
    for (const client of clients) await client.stop();
    try {
      await world?.close();
      await rm(shared, { recursive: true });
      log.cleanup = "owned worlds and shared cache removed";
    } catch (error) {
      failure ??= error;
      log.cleanupError = String(error);
      log.result = "failed";
    }
    await writeFile(
      join(evidence, "same-parent-recovery.json"),
      `${JSON.stringify(log, null, 2)}\n`,
    );
  }
  if (failure) throw failure;
  console.log(
    "PASS: real shared-cache failure, official isolated handoff, same parent/native tools/worktree progress",
  );
}

await main();
