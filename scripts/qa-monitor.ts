import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { startQaRpc } from "./qa-rpc";

const root = resolve(import.meta.dir, "..");
const scratch = await mkdtemp(join(tmpdir(), "olw-native-monitor-"));
const agent = join(scratch, "agent");
const cwd = join(scratch, "fixture");
const sessionPath = join(scratch, "sessions", "native.jsonl");
const durableSessionId = randomUUID();
const evidence = join(root, ".omo/evidence/real-use-repairs/lina-146-native");
const log: unknown[] = [];
const eventSchema = z.object({
  type: z.literal("extension_event"),
  name: z.string(),
  data: z.unknown(),
});
const endedSchema = z
  .object({
    id: z.string(),
    description: z.string(),
    reason: z.enum(["exit", "killed", "timeout", "disposed"]),
    fireCount: z.number(),
  })
  .loose();
const notificationSchema = z.object({
  details: z.object({
    monitors: z.array(
      z.object({
        id: z.string(),
        description: z.string(),
        eventCount: z.number(),
        kinds: z.array(z.enum(["line", "summary"])),
      }),
    ),
  }),
});
const notificationFor = (description: string) => (data: unknown) => {
  const parsed = notificationSchema.safeParse(data);
  return (
    parsed.success &&
    parsed.data.details.monitors.some((monitor) => monitor.description === description)
  );
};
const stateSchema = z.object({
  activeCount: z.number(),
  monitors: z.array(
    z
      .object({
        id: z.string(),
        description: z.string(),
        persistent: z.boolean(),
        deadlineMs: z.number().nullable(),
      })
      .loose(),
  ),
});
type Rpc = ReturnType<typeof startQaRpc>;
let rpc: Rpc | undefined;
let sessionId: string | undefined;
let generation = 0;
const seen: z.infer<typeof eventSchema>[] = [];
const waiters = new Set<{
  predicate: (event: z.infer<typeof eventSchema>) => boolean;
  resolve: (event: z.infer<typeof eventSchema>) => void;
}>();
let detach: (() => void) | undefined;
const record = (raw: unknown) => {
  const parsed = eventSchema.safeParse(raw);
  if (!parsed.success) return;
  const event = parsed.data;
  seen.push(event);
  log.push({ generation, sessionId, event });
  for (const waiter of [...waiters])
    if (waiter.predicate(event)) {
      waiters.delete(waiter);
      waiter.resolve(event);
    }
};
function signal(predicate: (event: z.infer<typeof eventSchema>) => boolean, label: string) {
  const result = Promise.withResolvers<z.infer<typeof eventSchema>>();
  const waiter = { predicate, resolve: result.resolve };
  waiters.add(waiter);
  const timer = setTimeout(() => {
    waiters.delete(waiter);
    result.reject(new Error(`Missing exact event: ${label}`));
  }, 20000);
  return {
    promise: result.promise.finally(() => clearTimeout(timer)),
    cancel: () => {
      waiters.delete(waiter);
      clearTimeout(timer);
    },
  };
}
function match(name: string, test: (data: unknown) => boolean) {
  return (event: z.infer<typeof eventSchema>) =>
    event.name === `oi.qa.monitor.${name}` && test(event.data);
}
async function request(command: Record<string, unknown>) {
  assert.ok(rpc && sessionId);
  const result = await rpc.request({ ...command, sessionId });
  log.push({ generation, command, result });
  return result;
}
async function start() {
  generation++;
  const { PATH: path, USER: user } = process.env;
  rpc = startQaRpc(
    [
      join(root, "node_modules/.bin/omo"),
      "--mode",
      "rpc",
      "--multi-session",
      "--session-runtime",
      "in-process",
      "--no-approve",
      "--no-extensions",
      "--no-context-files",
      "--no-recommended-models",
      "--no-model-fallback",
      "--omo-senpi-builtin-mcps-disabled",
      "--omo-senpi-memory-disabled",
      "-e",
      join(root, "scripts/qa-monitor-extension.ts"),
    ],
    cwd,
    {
      PATH: path,
      HOME: agent,
      USER: user,
      TERM: "dumb",
      HERDR_ENV: "0",
      OMO_CODING_AGENT_DIR: agent,
      SENPI_CODING_AGENT_DIR: agent,
      PI_CODING_AGENT_DIR: agent,
      OMO_ENABLE_SHARED_HOST: "0",
      OMO_INITIATIVE_HOST: undefined,
      OMO_RPC_SOCKET: undefined,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(scratch, "bun-cache"),
      XDG_CACHE_HOME: join(scratch, "xdg-cache"),
      OMO_QA_MONITOR_PORT: String(server.port),
      SENPI_RPC_CLIENT_CAPABILITIES: "extension_events",
    },
  );
  detach = rpc.onEvent(record);
  const opened = z
    .object({ sessionId: z.string(), attached: z.boolean().optional() })
    .parse(await rpc.request({ type: "open_session", cwd, sessionPath, durableSessionId }));
  sessionId = opened.sessionId;
  log.push({ generation, opened, durableSessionId });
  assert.deepEqual(
    z
      .object({ disposition: z.literal("handled") })
      .parse(await request({ type: "prompt", message: "/mcp status" })).disposition,
    "handled",
  );
  await request({ type: "set_model", provider: "qa-monitor-local", modelId: "offline" });
}
async function stop() {
  if (!rpc || !sessionId) return;
  await request({ type: "close_session" });
  detach?.();
  detach = undefined;
  const stderr = await rpc.close();
  log.push({ generation, cleanup: { sessionId, stderr } });
  rpc = undefined;
  sessionId = undefined;
}
async function tool(toolName: "monitor" | "kill_bash", args: Record<string, unknown>) {
  const response = z
    .object({
      isError: z.boolean().optional(),
      details: z.object({ monitor_id: z.string(), bash_id: z.string() }).optional(),
      content: z.unknown(),
    })
    .parse(
      await request({
        type: "extension_request",
        name: "oi.qa.monitor.tool",
        data: { tool: toolName, arguments: args },
      }),
    );
  assert.notEqual(response.isError, true, JSON.stringify(response));
  return response;
}
async function register(
  description: string,
  path: string,
  event: "create" | "modify" = "create",
  timeout_ms?: number,
) {
  const state = signal(
    match(
      "terminal_monitor_state",
      (d) =>
        stateSchema.safeParse(d).success &&
        stateSchema
          .parse(d)
          .monitors.some(
            (m) => m.description === description && m.persistent && m.deadlineMs === null,
          ),
    ),
    `registered ${description}`,
  );
  try {
    const result = await tool("monitor", {
      description,
      path,
      event,
      persistent: true,
      ...(timeout_ms === undefined ? {} : { timeout_ms }),
    });
    const id = z.string().startsWith("mon_").parse(result.details?.monitor_id);
    await state.promise;
    log.push({
      generation,
      registered: { description, monitorId: id, runtimeId: result.details?.bash_id },
    });
    return id;
  } finally {
    state.cancel();
  }
}
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    assert.equal(new URL(req.url).pathname, "/v1/chat/completions");
    return new Response(
      'data: {"id":"qa","object":"chat.completion.chunk","created":1,"model":"offline","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\ndata: {"id":"qa","object":"chat.completion.chunk","created":1,"model":"offline","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { "Content-Type": "text/event-stream" } },
    );
  },
});
try {
  await mkdir(agent, { recursive: true, mode: 0o700 });
  await mkdir(cwd, { recursive: true });
  await mkdir(join(scratch, "sessions"), { recursive: true });
  await start();
  const cancelled = await register("cancel-control", join(cwd, "cancel.json"), "create", 1000);
  const killed = signal(
    match(
      "terminal_monitor_ended",
      (d) => endedSchema.safeParse(d).success && endedSchema.parse(d).reason === "killed",
    ),
    "killed",
  );
  try {
    await tool("kill_bash", { bash_id: cancelled });
    await killed.promise;
  } finally {
    killed.cancel();
  }
  assert.equal(seen.filter(match("notification", notificationFor("cancel-control"))).length, 0);
  const stable = await register("restart-control", join(cwd, "unchanged.json"));
  const arrival = await register("arrival", join(cwd, "arrival.json"));
  const before = z
    .object({ sessionId: z.string(), sessionFile: z.string() })
    .parse(await request({ type: "get_state" }));
  assert.equal(before.sessionId, durableSessionId);
  log.push({
    beforeShutdown: before,
    sessionFiles: await readdir(join(scratch, "sessions"), { recursive: true }),
  });
  await stop();
  const manifestPath = join(
    scratch,
    "sessions",
    "extensions",
    "terminal",
    `${durableSessionId}.json`,
  );
  const shutdownManifest = await readFile(manifestPath, "utf8");
  assert.ok(shutdownManifest.includes(stable) && shutdownManifest.includes(arrival));
  log.push({
    afterShutdownFiles: await readdir(join(scratch, "sessions"), { recursive: true }),
    shutdownManifest: JSON.parse(shutdownManifest),
  });
  const restoredGeneration = generation + 1;
  const restoreSignal = signal(
    match("terminal_monitor_state", (data) => {
      const parsed = stateSchema.safeParse(data);
      return (
        generation === restoredGeneration &&
        parsed.success &&
        parsed.data.monitors.some(
          (monitor) =>
            monitor.description === "arrival" && monitor.persistent && monitor.deadlineMs === null,
        )
      );
    }),
    "arrival restored",
  );
  try {
    await start();
    await restoreSignal.promise;
  } finally {
    restoreSignal.cancel();
  }
  const after = z
    .object({ sessionId: z.string(), sessionFile: z.string() })
    .parse(await request({ type: "get_state" }));
  assert.equal(after.sessionId, before.sessionId);
  assert.equal(after.sessionFile, before.sessionFile);
  const restoredManifest = await readFile(manifestPath, "utf8");
  assert.ok(restoredManifest.includes(stable) && restoredManifest.includes(arrival));
  log.push({ restoredManifest: JSON.parse(restoredManifest) });
  log.push({
    afterRestart: after,
    sessionFiles: await readdir(join(scratch, "sessions"), { recursive: true }),
  });
  assert.equal(seen.filter(match("notification", notificationFor("restart-control"))).length, 0);
  assert.equal(seen.filter(match("notification", notificationFor("arrival"))).length, 0);
  const complete = signal(
    match(
      "terminal_monitor_ended",
      (d) =>
        endedSchema.safeParse(d).success &&
        endedSchema.parse(d).reason === "exit" &&
        endedSchema.parse(d).description === "arrival",
    ),
    "arrival ended",
  );
  const notification = signal(
    match("notification", notificationFor("arrival")),
    "arrival notification",
  );
  try {
    await writeFile(join(cwd, "arrival.json"), "result");
    const ended = endedSchema.parse((await complete.promise).data);
    assert.equal(ended.fireCount, 2);
    const notice = notificationSchema.parse((await notification.promise).data);
    assert.equal(notice.details.monitors.length, 1);
    assert.equal(notice.details.monitors[0]?.eventCount, 2);
    assert.deepEqual(notice.details.monitors[0]?.kinds, ["line", "summary"]);
  } finally {
    complete.cancel();
    notification.cancel();
  }
  assert.equal(seen.filter(match("notification", notificationFor("arrival"))).length, 1);
  const modified = join(cwd, "modify.json");
  await writeFile(modified, "before");
  const modifyId = await register("modify", modified, "modify");
  const modifyEnd = signal(
    match(
      "terminal_monitor_ended",
      (d) =>
        endedSchema.safeParse(d).success &&
        endedSchema.parse(d).reason === "exit" &&
        endedSchema.parse(d).description === "modify",
    ),
    "modify ended",
  );
  const modifyNotice = signal(
    match("notification", notificationFor("modify")),
    "modify notification",
  );
  try {
    await writeFile(modified, "after");
    assert.equal(endedSchema.parse((await modifyEnd.promise).data).fireCount, 2);
    const notice = notificationSchema.parse((await modifyNotice.promise).data);
    assert.equal(notice.details.monitors.length, 1);
    assert.equal(notice.details.monitors[0]?.eventCount, 2);
    assert.deepEqual(notice.details.monitors[0]?.kinds, ["line", "summary"]);
  } finally {
    modifyEnd.cancel();
    modifyNotice.cancel();
  }
  const restoredKill = signal(
    match(
      "terminal_monitor_ended",
      (d) => endedSchema.safeParse(d).success && endedSchema.parse(d).reason === "killed",
    ),
    "restored stable monitor killed",
  );
  try {
    await tool("kill_bash", { bash_id: stable });
    await restoredKill.promise;
  } finally {
    restoredKill.cancel();
  }
  const endedEvents = seen
    .filter((event) => event.name === "oi.qa.monitor.terminal_monitor_ended")
    .map((event) => endedSchema.parse(event.data));
  assert.deepEqual(
    endedEvents.map(({ description, reason }) => [description, reason]),
    [
      ["cancel-control", "killed"],
      ["arrival", "exit"],
      ["modify", "exit"],
      ["restart-control", "killed"],
    ],
  );
  assert.equal(seen.filter(match("notification", notificationFor("restart-control"))).length, 0);
  assert.equal(seen.filter(match("notification", notificationFor("cancel-control"))).length, 0);
  log.push({
    pass: true,
    durableSessionId,
    cancelled,
    stable,
    arrival,
    modifyId,
    counts: {
      notifications: seen.filter((e) => e.name === "oi.qa.monitor.notification").length,
      ended: endedEvents.length,
    },
  });
  console.log("NATIVE_MONITOR_PASS", JSON.stringify(log.at(-1)));
} finally {
  try {
    if (rpc && sessionId) await stop();
  } finally {
    const serverPort = server.port;
    await server.stop(true);
    await rm(scratch, { recursive: true, force: true });
    log.push({
      cleanup: {
        scratch,
        removed: true,
        server: `127.0.0.1:${serverPort}`,
        stopped: true,
        rpc: "closed",
        agent,
        cwd,
        sessionPath,
      },
    });
    await mkdir(evidence, { recursive: true });
    await writeFile(join(evidence, "native-run.json"), `${JSON.stringify(log, null, 2)}\n`);
    console.log("CLEANUP", JSON.stringify(log.at(-1)));
  }
}
