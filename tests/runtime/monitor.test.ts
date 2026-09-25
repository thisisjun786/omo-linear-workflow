import { afterEach, expect, jest, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TerminalMonitorEndedEvent } from "../../node_modules/@code-yeongyu/senpi/dist/core/extensions/builtin/monitor-state-event.js";
import { createCheckpointedFileRestoreHandler } from "../../node_modules/@code-yeongyu/senpi/dist/core/extensions/builtin/terminal/durable-file.js";
import { TerminalManager } from "../../node_modules/@code-yeongyu/senpi/dist/core/extensions/builtin/terminal/manager.js";
import {
  type MonitorEvent,
  MonitorRegistry,
} from "../../node_modules/@code-yeongyu/senpi/dist/core/extensions/builtin/terminal/monitor-registry.js";
import type { ManifestMonitor } from "../../node_modules/@code-yeongyu/senpi/dist/core/extensions/builtin/terminal/terminal-manifest.js";
import { createKillBashTool } from "../../node_modules/@code-yeongyu/senpi/dist/core/extensions/builtin/terminal/tools/kill-bash.js";
import {
  createMonitorTool,
  DEFAULT_MONITOR_TIMEOUT_MS,
} from "../../node_modules/@code-yeongyu/senpi/dist/core/extensions/builtin/terminal/tools/monitor.js";

const owned: { root: string; manager: TerminalManager }[] = [];
const registries: MonitorRegistry[] = [];
afterEach(async () => {
  for (const registry of registries.splice(0)) registry.dispose();
  jest.useRealTimers();
  for (const item of owned.splice(0)) {
    await item.manager.teardown();
    await rm(item.root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "olw-monitor-"));
  const events: MonitorEvent[] = [];
  const ended: TerminalMonitorEndedEvent[] = [];
  const settled = Promise.withResolvers<TerminalMonitorEndedEvent>();
  const registry = new MonitorRegistry((event) => events.push(event), {
    onEnded: (event) => {
      ended.push(event);
      settled.resolve(event);
    },
  });
  const manager = new TerminalManager();
  owned.push({ root, manager });
  registries.push(registry);
  const context = {
    manager,
    monitorRegistry: registry,
    cwd: root,
    defaultCols: 80,
    defaultRows: 24,
    getEnv: () => ({}),
  };
  return { root, registry, manager, context, events, ended, settled };
}

test("persistent file tool ignores the default live timeout", async () => {
  jest.useFakeTimers();
  const f = await fixture();
  const result = await createMonitorTool(f.context).execute("register", {
    description: "result",
    path: "result.json",
    persistent: true,
  });
  expect(result.isError).not.toBe(true);
  jest.advanceTimersByTime(DEFAULT_MONITOR_TIMEOUT_MS + 1);
  expect(f.registry.snapshot()).toMatchObject([{ persistent: true, deadlineMs: null }]);
  expect(f.ended).toEqual([]);
});

test("persistent file still ends at its recorded durability expiry", async () => {
  jest.useFakeTimers();
  const f = await fixture();
  await createMonitorTool(f.context).execute("register", {
    description: "result",
    path: "result.json",
    persistent: true,
  });
  const expiry = f.registry.snapshot()[0]?.expiresAt;
  if (expiry === undefined) throw new Error("Missing durability expiry");
  jest.advanceTimersByTime(expiry - Date.now() + 1);
  expect(f.registry.snapshot()).toEqual([]);
  expect(f.ended).toMatchObject([{ reason: "timeout" }]);
});

test("ephemeral file tool retains its default timeout", async () => {
  jest.useFakeTimers();
  const f = await fixture();
  const result = await createMonitorTool(f.context).execute("register", {
    description: "result",
    path: "result.json",
  });
  expect(result.isError).not.toBe(true);
  jest.advanceTimersByTime(DEFAULT_MONITOR_TIMEOUT_MS + 1);
  expect(f.registry.snapshot()).toEqual([]);
  expect(f.ended).toMatchObject([{ reason: "timeout" }]);
});

test("persistent file ignores an explicit timeout but remains cancellable", async () => {
  jest.useFakeTimers();
  const f = await fixture();
  await createMonitorTool(f.context).execute("register", {
    description: "result",
    path: "result.json",
    persistent: true,
    timeout_ms: 1000,
  });
  const entry = f.registry.snapshot()[0];
  if (!entry?.monitorId) throw new Error("Missing registered monitor");
  jest.advanceTimersByTime(1001);
  const cancelled = await createKillBashTool(f.context).execute("cancel", {
    bash_id: entry.monitorId,
  });
  expect(cancelled.isError).not.toBe(true);
  expect(f.ended).toMatchObject([{ reason: "killed" }]);
});

test.each(["create", "modify"] as const)(
  "real persistent %s emits once and settles",
  async (event) => {
    const f = await fixture();
    const path = join(f.root, "result.json");
    if (event === "modify") await writeFile(path, "before");
    const result = await createMonitorTool(f.context).execute("register", {
      description: "result",
      path,
      event,
      persistent: true,
    });
    expect(result.isError).not.toBe(true);
    await writeFile(path, "after");
    expect((await f.settled.promise).reason).toBe("exit");
    expect(f.events.filter((item) => item.type === "line")).toHaveLength(1);
    expect(f.registry.snapshot()).toEqual([]);
  },
);

test("restored persistent watch preserves identity and cancellation", async () => {
  jest.useFakeTimers();
  const f = await fixture();
  await createMonitorTool(f.context).execute("register", {
    description: "result",
    path: "result.json",
    persistent: true,
  });
  const entry = f.registry.snapshot()[0];
  if (!entry?.monitorId || entry.expiresAt === undefined)
    throw new Error("Missing durable monitor");
  const checkpoint = f.registry.fileCheckpoint(entry.id);
  if (!checkpoint) throw new Error("Missing checkpoint");
  const manifest: ManifestMonitor = {
    monitorId: entry.monitorId,
    sessionId: "fixture",
    description: "result",
    runtimeKind: "file",
    durabilityClass: "checkpointed-file",
    path: "result.json",
    event: "create",
    cwd: f.root,
    createdAt: entry.startedAtMs,
    expiresAt: entry.expiresAt,
    persistent: true,
    suspended: true,
    lastCheckpoint: checkpoint,
    deliveryPaused: false,
    fireWindow: { startMs: entry.startedAtMs, count: 0 },
  };
  f.registry.dispose();
  const resumed = new MonitorRegistry(() => {}, { onEnded: (event) => f.ended.push(event) });
  registries.push(resumed);
  expect(await createCheckpointedFileRestoreHandler({ registry: resumed })(manifest)).toEqual({
    outcome: "restored",
  });
  jest.advanceTimersByTime(DEFAULT_MONITOR_TIMEOUT_MS + 1);
  expect(resumed.snapshot()).toMatchObject([
    { monitorId: entry.monitorId, persistent: true, deadlineMs: null },
  ]);
  const resumedEntry = resumed.snapshot()[0];
  if (!resumedEntry) throw new Error("Missing restored monitor");
  await resumed.stopFile(resumedEntry.id);
  expect(f.ended.at(-1)?.reason).toBe("killed");
});
