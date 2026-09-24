import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { RpcClient } from "@code-yeongyu/senpi";
import { z } from "zod";
import { modelForRole } from "../src/core/policy";
import { bindingSchema } from "../src/core/schema";
import { attach, idle } from "./qa-hierarchy";
import { checkedQaCommand, prepareQaWorld } from "./qa-world";

const success = z.object({ ok: z.literal(true), value: z.unknown() });
const created = z.object({ binding: bindingSchema });
const root = join(import.meta.dir, "..");
const evidence = join(root, ".omo/evidence/real-use-repairs/host-recovery");

async function toolTurn(client: RpcClient, path: string) {
  const ended = Promise.withResolvers<void>();
  const timer = setTimeout(() => ended.reject(new Error("Cache QA tool turn timed out")), 120_000);
  const off = client.onEvent((event) => {
    if (event.type === "agent_end") ended.resolve();
  });
  try {
    await Promise.all([
      client.prompt(
        `Read ${join(path, "README.md")} with the native read tool. Then use eval to run tool.bash({command: "pwd"}) and print its result. Do not edit files or create work.`,
      ),
      ended.promise,
    ]);
  } finally {
    clearTimeout(timer);
    off();
  }
}

export async function exercise(cache: string | undefined) {
  const qa = await prepareQaWorld();
  const clients: RpcClient[] = [];
  const result: {
    root: string;
    cache: string | null;
    sessions: {
      role: string;
      id: string;
      model: string | undefined;
      thinking: string;
      errors: string[];
      tools: string[];
    }[];
    cleanup?: string;
    cleanupError?: string;
    error?: string;
  } = { root: qa.controlRoot, cache: cache ?? null, sessions: [] };
  let failure: unknown;
  const invoke = async (args: string[]) => {
    const reply = await qa.cli(args);
    assert.equal(reply.code, 0, JSON.stringify(reply));
    return success.parse(JSON.parse(reply.stdout)).value;
  };
  try {
    const builderPath = join(qa.controlRoot, "qa-profile-builder.ts");
    await cp(join(qa.installRoot, "src/host-profile.ts"), builderPath);
    const builder: typeof import("../src/host-profile") = await import(
      pathToFileURL(builderPath).href
    );
    const profile = await builder.createHostProfile(qa.controlRoot);
    const cacheEnv = cache
      ? {
          XDG_CACHE_HOME: join(cache, "host"),
          BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(cache, "cli"),
        }
      : builder.runtimeCacheEnvironment(qa.controlRoot);
    await checkedQaCommand(
      [
        join(qa.controlRoot, "node_modules/.bin/omo"),
        "host",
        "ensure",
        "--launch-spec",
        profile,
        "--socket",
        join(qa.controlRoot, ".omo/state/omo.sock"),
        "--policy",
        "never",
      ],
      qa.controlRoot,
      { ...qa.environment, ...cacheEnv },
    );
    const path = join(qa.scratch, "scope.json");
    await cp(join(root, "tests/fixtures/scope.json"), path);
    const { digest } = z
      .object({ digest: z.string() })
      .parse(await invoke(["scope", "import", "--file", path, "--fixture"]));
    const supervisor = created.parse(
      await invoke([
        "supervisor",
        "create",
        "--initiative",
        "initiative-omo-1",
        "--scope-digest",
        digest,
        "--designation",
        "cache-cause-qa",
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
    const child = created.parse(
      await invoke(["child", "create", "--parent", parent.id, "--issue", "issue-omo-1"]),
    ).binding;
    for (const binding of [supervisor, parent, child]) {
      const client = await attach(binding);
      clients.push(client);
      await idle(client);
      const existing = await client.getMessages();
      const alreadyFailed = existing.some(
        (message) => message.role === "assistant" && message.stopReason === "error",
      );
      if (binding.assignment.role !== "supervisor" && !alreadyFailed) {
        await toolTurn(client, binding.cwd);
        await idle(client);
      }
      const state = await client.getState();
      const messages = await client.getMessages();
      const assistants = messages.filter((message) => message.role === "assistant");
      const errors = assistants
        .filter((message) => message.stopReason === "error")
        .map((message) => message.errorMessage ?? "");
      const tools = assistants.flatMap((message) =>
        message.content.filter((part) => part.type === "toolCall").map((call) => call.name),
      );
      assert.equal(state.model?.provider, modelForRole(binding.assignment.role).provider);
      assert.equal(state.model.id, modelForRole(binding.assignment.role).modelId);
      result.sessions.push({
        role: binding.assignment.role,
        id: state.sessionId,
        model: state.model.id,
        thinking: state.thinkingLevel,
        errors,
        tools,
      });
    }
  } catch (error) {
    failure = error;
    result.error = String(error);
  } finally {
    for (const client of clients) await client.stop();
    try {
      await qa.close();
      result.cleanup = "owned world removed";
    } catch (error) {
      failure ??= error;
      result.cleanupError = String(error);
    }
  }
  if (failure) throw new Error(JSON.stringify(result));
  return result;
}

async function main() {
  await mkdir(evidence, { recursive: true });
  const shared = await mkdtemp(join(evidence, "cache-cause-"));
  const log: {
    result: string;
    warm?: unknown;
    shared?: unknown;
    isolated?: unknown;
    error?: string;
    cleanup?: string;
  } = { result: "incomplete" };
  let failure: unknown;
  try {
    const warm = await exercise(shared);
    log.warm = warm;
    assert.equal(
      warm.sessions.flatMap((session) => session.errors).length,
      0,
      JSON.stringify(warm),
    );
    assert.equal(await Bun.file(join(warm.root, "dist/extension/index.js")).exists(), false);
    console.log("QA_PHASE cache warmed and first root removed");
    const contaminated = await exercise(shared);
    log.shared = contaminated;
    const matched = contaminated.sessions
      .flatMap((session) => session.errors)
      .filter(
        (message) => message.includes(warm.root) && message.includes("extension-runtime-module"),
      );
    assert.ok(
      matched.length > 0,
      "Shared-cache negative control did not reproduce a deleted warm-root import",
    );
    console.log("QA_PHASE actual deleted-root import reproduced with shared cache");
    const isolated = await exercise(undefined);
    log.isolated = isolated;
    assert.equal(
      isolated.sessions.flatMap((session) => session.errors).length,
      0,
      JSON.stringify(isolated),
    );
    for (const session of isolated.sessions.filter((session) => session.role !== "supervisor")) {
      assert.ok(session.tools.includes("read") && session.tools.includes("eval"));
    }
    log.result = "pass";
  } catch (error) {
    failure = error;
    log.result = "failed";
    log.error = String(error);
  } finally {
    await rm(shared, { recursive: true });
    log.cleanup = "owned shared cache removed; each world's cleanup is recorded in its result";
    await writeFile(join(evidence, "cache-cause.json"), `${JSON.stringify(log, null, 2)}\n`);
  }
  if (failure) throw failure;
  console.log("PASS: shared-cache deleted-root failure; isolated native tool turns succeed");
}

if (import.meta.main) await main();
