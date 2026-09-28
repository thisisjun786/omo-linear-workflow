import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as settle } from "node:timers/promises";
import { RpcClient } from "@code-yeongyu/senpi";
import { z } from "zod";

const root = join(import.meta.dir, "..");
const count = z.coerce
  .number()
  .int()
  .min(1)
  .max(20)
  .parse(process.argv[2] ?? "10");
const megabytes = z.coerce
  .number()
  .int()
  .min(1)
  .max(128)
  .parse(process.argv[3] ?? "64");
const layer = z.enum(["eval", "extension"]).parse(process.env["QA_MEMORY_LAYER"] ?? "eval");
const runtimes = z
  .array(z.enum(["in-process", "worker"]))
  .parse(process.argv.length > 4 ? process.argv.slice(4) : ["in-process", "worker"]);

async function sample(pid: number, phase: string) {
  const status = await readFile(`/proc/${pid}/status`, "utf8");
  const inodes = new Set<string>();
  for (const fd of await readdir(`/proc/${pid}/fd`)) {
    try {
      const target = await readlink(`/proc/${pid}/fd/${fd}`);
      const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1];
      if (inode) inodes.add(inode);
    } catch (cause) {
      if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
    }
  }
  const listeners: { inode: string; address: string }[] = [];
  for (const table of ["tcp", "tcp6"]) {
    for (const row of (await readFile(`/proc/${pid}/net/${table}`, "utf8"))
      .trim()
      .split("\n")
      .slice(1)) {
      const fields = row.trim().split(/\s+/);
      const inode = fields[9];
      const address = fields[1];
      if (fields[3] === "0A" && inode && address && inodes.has(inode))
        listeners.push({ inode, address });
    }
  }
  const result = {
    phase,
    pid,
    at: new Date().toISOString(),
    rssKiB: Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1]),
    anonKiB: Number(/^RssAnon:\s+(\d+)/m.exec(status)?.[1]),
    listeners,
  };
  console.log(JSON.stringify(result));
  return result;
}

async function measure(runtime: "in-process" | "worker") {
  const scratch = await mkdtemp(join(tmpdir(), "olw-memory-"));
  const agent = join(scratch, "agent");
  const socket = join(scratch, "host.sock");
  await mkdir(agent);
  await mkdir(join(scratch, ".omo/state"), { recursive: true });
  await symlink(join(root, "dist"), join(scratch, "dist"));
  const clients: RpcClient[] = [];
  const { PATH, USER } = process.env;
  const environment = {
    PATH,
    HOME: scratch,
    USER,
    TERM: "dumb",
    OMO_NATIVE: "1",
    OMO_INITIATIVE_HOST: "1",
    OMO_INITIATIVE_EXTENSION_PROTOCOL_2: "1",
    OMO_INITIATIVE_ROOT: scratch,
    OMO_RPC_SOCKET: socket,
    OMO_CODING_AGENT_DIR: agent,
    SENPI_CODING_AGENT_DIR: agent,
    PI_CODING_AGENT_DIR: agent,
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(scratch, "bun-cache"),
    XDG_CACHE_HOME: join(scratch, "xdg-cache"),
    SENPI_RPC_CLIENT_CAPABILITIES: "extension_events",
  };
  const child = spawn(
    process.execPath,
    [
      join(root, "node_modules/@code-yeongyu/senpi/dist/cli.js"),
      "--mode",
      "rpc",
      "--listen",
      socket,
      "--session-runtime",
      runtime,
      "--no-approve",
      "--no-extensions",
      "--no-context-files",
      "--no-recommended-models",
      "--no-model-fallback",
      "--omo-senpi-builtin-mcps-disabled",
      "--omo-senpi-memory-disabled",
      "-e",
      join(root, "node_modules/omo-ai/plugin"),
      "-e",
      join(root, "node_modules/omo-ai/plugin/extensions/omo-member.js"),
      "-e",
      join(root, "dist/extension/index.js"),
      "-e",
      join(root, "scripts/qa-host-memory-extension.ts"),
    ],
    { cwd: scratch, env: environment, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  const pid = child.pid;
  assert.ok(pid);
  const exited = once(child, "exit");
  const ready = Promise.withResolvers<void>();
  let diagnostics = "";
  child.stdout.resume();
  child.stderr.on("data", (chunk: Buffer) => {
    diagnostics += chunk.toString();
    if (diagnostics.includes("senpi rpc listening on")) ready.resolve();
  });
  child.once("error", ready.reject);
  child.once("exit", (code, signal) =>
    ready.reject(new Error(`Host exit ${code}/${signal}: ${diagnostics}`)),
  );
  const deadline = setTimeout(
    () => ready.reject(new Error(`Host readiness deadline: ${diagnostics}`)),
    30000,
  );
  console.log(JSON.stringify({ runtime, scratch, pid, count, megabytes, layer }));
  try {
    await ready.promise;
    clearTimeout(deadline);
    await sample(pid, `${runtime}:baseline`);
    for (let index = 0; index < count; index++) {
      const client = new RpcClient({ socketPath: socket });
      clients.push(client);
      await client.start();
      const opened = await client.openSession({
        cwd: scratch,
        provider: "opencodex",
        modelId: "anthropic/claude-opus-5-5",
        retain_on_disconnect: true,
        auto_title: false,
      });
      const description = await client.requestExtension("omo.initiative.describe");
      const result = await client.requestExtension("qa.memory.allocate", { megabytes, layer });
      const parsed = z
        .object({ isError: z.boolean().optional(), content: z.unknown() })
        .parse(result);
      assert.notEqual(parsed.isError, true, JSON.stringify(result));
      console.log(
        JSON.stringify({
          runtime,
          index,
          sessionId: opened.sessionId,
          description,
          allocation: result,
        }),
      );
    }
    const active = await sample(pid, `${runtime}:allocated`);
    assert.ok(active.listeners.length >= count, "Every session must own a live loopback listener");
    // Time is the measured variable, not a test synchronizer. No cleanup or forced GC.
    await settle(5000);
    await sample(pid, `${runtime}:attached-idle-5s`);
    for (const client of clients) await client.closeSession();
    await sample(pid, `${runtime}:closed`);
    await settle(5000);
    await sample(pid, `${runtime}:closed-settled-5s`);
  } finally {
    clearTimeout(deadline);
    for (const client of clients) await client.stop();
    if (child.exitCode === null && child.signalCode === null) process.kill(-pid, "SIGTERM");
    const killDeadline = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) process.kill(-pid, "SIGKILL");
    }, 5000);
    await exited;
    clearTimeout(killDeadline);
    // The process group is ours, including any kernel subprocess orphaned on close.
    killOwnedGroup(pid);
    await rm(scratch, { recursive: true, force: true });
    console.log(
      JSON.stringify({
        cleanup: { runtime, pid, scratch, exited: true, removed: true },
        diagnostics,
      }),
    );
  }
}

function killOwnedGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) throw cause;
  }
}

for (const runtime of runtimes) await measure(runtime);
