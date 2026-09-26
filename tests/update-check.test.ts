import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, watch } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CommandRunner,
  checkUpdates,
  runCommand,
  type UpdateTimer,
} from "../src/update/check";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "olw-update-check-"));
  roots.push(root);
  await Bun.write(
    join(root, "package.json"),
    JSON.stringify({
      dependencies: {
        "omo-ai": "5.0.0-0.beta.84",
        "@code-yeongyu/senpi": "2026.9.22-4",
      },
    }),
  );
  return root;
}

function runner(
  overrides: Partial<
    Record<string, (argv: readonly string[]) => Promise<{ code: number; stdout: string }>>
  > = {},
): CommandRunner {
  return async (argv) => {
    const key = argv[0] === "npm" ? argv[4] : argv[0];
    const override = key === undefined ? undefined : overrides[key];
    if (override) return override(argv);
    if (argv[0] === "npm" && argv.includes("omo-ai"))
      return { code: 0, stdout: JSON.stringify({ beta: "5.0.0-0.beta.90" }) };
    if (argv[0] === "npm") return { code: 0, stdout: JSON.stringify({ latest: "2026.9.25-1" }) };
    return { code: 0, stdout: "5.0.0-0.beta.90 (engine: senpi 2026.9.24-3)\n" };
  };
}

test("reports newer versions and preserves the exact pinned manifest string", async () => {
  const root = await fixture();
  const result = await checkUpdates(root, { run: runner() });
  expect(result.state).toBe("available");
  expect(result.packages).toMatchObject({
    "omo-ai": {
      state: "update_available",
      pinned: "5.0.0-0.beta.84",
      available: "5.0.0-0.beta.90",
      tag: "beta",
    },
    "@code-yeongyu/senpi": {
      state: "update_available",
      pinned: "2026.9.22-4",
      available: "2026.9.25-1",
      tag: "latest",
    },
  });
  const state = JSON.parse(await readFile(join(root, ".omo/state/update-check.json"), "utf8"));
  expect(state).toEqual(result);
});

test("equal versions are current", async () => {
  const root = await fixture();
  const same = runner();
  const result = await checkUpdates(root, {
    run: async (argv) => {
      if (argv[0] === "npm" && argv.includes("omo-ai"))
        return { code: 0, stdout: JSON.stringify({ beta: "5.0.0-0.beta.84" }) };
      if (argv[0] === "npm") return { code: 0, stdout: JSON.stringify({ latest: "2026.9.22-4" }) };
      return same(argv, 20_000);
    },
  });
  expect(Object.values(result.packages).map((p) => p.state)).toEqual(["current", "current"]);
});

test("runner timeout is unknown with a successful check result", async () => {
  const root = await fixture();
  const timers: Array<{ callback: () => void; delay: number }> = [];
  const timer: UpdateTimer = {
    now: () => 0,
    setTimeout(callback, delay) {
      timers.push({ callback, delay });
      return 0 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout() {},
  };
  let calls = 0;
  const allStarted = Promise.withResolvers<void>();
  const resultPromise = checkUpdates(root, {
    timeoutMs: 25,
    timer,
    run: async () => {
      calls += 1;
      if (calls === 3) allStarted.resolve();
      return new Promise(() => {});
    },
  });
  await allStarted.promise;
  const deadline = timers.find((entry) => entry.delay === 25);
  if (deadline === undefined) throw new Error("Update deadline was not scheduled");
  deadline.callback();
  const result = await resultPromise;
  expect(result.packages["omo-ai"]?.state).toBe("unknown");
  expect(result.state).not.toBe("unavailable");
});

test("offline check returns unavailable and persists its reason", async () => {
  const root = await fixture();
  const result = await checkUpdates(root, {
    run: async () => {
      throw new Error("offline");
    },
  });
  expect(result.state).toBe("unavailable");
  expect(result.reason).toContain("offline");
  expect(await readFile(join(root, ".omo/state/update-check.json"), "utf8")).toContain(
    "unavailable",
  );
});

test("rejects non-semver available or pinned versions as unknown", async () => {
  const root = await fixture();
  const forVersion = (available: string) =>
    runner({
      "omo-ai": async () => ({
        code: 0,
        stdout: JSON.stringify({ beta: available, latest: available }),
      }),
    });
  for (const version of ["05.0.0", "5.0.0-foo..bar"]) {
    const result = await checkUpdates(root, { run: forVersion(version) });
    expect(result.packages["omo-ai"]).toMatchObject({ state: "unknown", available: version });
    expect(result.packages["omo-ai"]?.reason).toBeDefined();
  }
  await Bun.write(
    join(root, "package.json"),
    JSON.stringify({
      dependencies: {
        "omo-ai": "05.0.0",
        "@code-yeongyu/senpi": "2026.9.22-4",
      },
    }),
  );
  const badPin = await checkUpdates(root, { run: runner() });
  expect(badPin.packages["omo-ai"]).toMatchObject({ state: "unknown", pinned: "05.0.0" });
});

test("uses semver prerelease ordering without rewriting valid pins", async () => {
  const root = await fixture();
  const result = await checkUpdates(root, {
    run: runner({
      "omo-ai": async () => ({
        code: 0,
        stdout: JSON.stringify({ beta: "5.0.0-beta.1", latest: "5.0.0-beta.1" }),
      }),
    }),
  });
  expect(result.packages["omo-ai"]).toMatchObject({
    state: "update_available",
    pinned: "5.0.0-0.beta.84",
    available: "5.0.0-beta.1",
  });
});

test("all commands run concurrently against one injected deadline", async () => {
  const root = await fixture();
  let now = 10;
  const timers: Array<{
    callback: () => void;
    delay: number;
    scheduledAt: number;
    cleared: boolean;
  }> = [];
  const timer: UpdateTimer = {
    now: () => now,
    setTimeout(callback, delay) {
      const item = { callback, delay, scheduledAt: now, cleared: false };
      timers.push(item);
      return item as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout(id) {
      (id as unknown as { cleared: boolean }).cleared = true;
    },
  };
  const started: string[] = [];
  const allStarted = Promise.withResolvers<void>();
  const resultPromise = checkUpdates(root, {
    timeoutMs: 20,
    timer,
    run: async (argv) => {
      started.push(argv[0] === "omo" ? "global" : (argv[4] ?? "npm"));
      if (started.length === 3) allStarted.resolve();
      return new Promise(() => {});
    },
  });
  await allStarted.promise;
  expect(started).toHaveLength(3);
  expect(timers.filter((entry) => entry.delay === 20)).toHaveLength(1);
  expect(timers.filter((entry) => entry.delay === 0)).toHaveLength(3);
  expect(timers.every((entry) => entry.scheduledAt === 10)).toBe(true);
  now = 30;
  for (const item of timers) item.callback();
  const result = await resultPromise;
  expect(result.state).toBe("unknown");
  expect(result.packages["omo-ai"]?.state).toBe("unknown");
});

test("default runner kills and reaps a SIGTERM-ignoring process group after READY", async () => {
  const root = await mkdtemp(join(tmpdir(), "olw-runner-timeout-"));
  roots.push(root);
  const script = join(root, "child.cjs");
  const readyPath = join(root, "ready");
  await Bun.write(
    script,
    `const { writeFileSync } = require("node:fs");
process.on("SIGTERM", () => {});
writeFileSync(${JSON.stringify(readyPath)}, "READY");
setInterval(() => {}, 1000);`,
  );
  const scheduled: Array<{
    callback: () => void;
    delay: number;
    cleared: boolean;
  }> = [];
  const timer: UpdateTimer = {
    now: () => 0,
    setTimeout(callback, delay) {
      const item = { callback, delay, cleared: false };
      scheduled.push(item);
      return item as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout(id) {
      (id as unknown as { cleared: boolean }).cleared = true;
    },
  };
  let childPid: number | undefined;
  const killChildGroup = () => {
    if (childPid === undefined) return;
    try {
      process.kill(-childPid, "SIGKILL");
    } catch (cause) {
      if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) throw cause;
    }
  };
  const readyEvents = watch(root);
  const ready = (async () => {
    for await (const event of readyEvents) {
      if (event.filename === "ready") return;
    }
  })();
  try {
    const resultPromise = runCommand([process.execPath, script], 20_000, timer, (pid) => {
      childPid = pid;
    });
    await ready;
    const deadline = scheduled.find((item) => item.delay === 20_000 && !item.cleared);
    if (deadline === undefined) throw new Error("Runner deadline was not scheduled");
    deadline.callback();
    const forceKill = scheduled.find((item) => item.delay === 250 && !item.cleared);
    if (forceKill === undefined) throw new Error("SIGKILL escalation was not scheduled");
    forceKill.callback();
    const reap = scheduled.find((item) => item.delay === 100 && !item.cleared);
    if (reap === undefined) throw new Error("Bounded reap was not scheduled");
    reap.callback();
    const result = await resultPromise;
    expect(result.timedOut).toBe(true);
    expect(result.code).not.toBe(0);
    if (childPid === undefined) throw new Error("Runner did not spawn a child");
    const pid = childPid;
    expect(() => process.kill(-pid, 0)).toThrow();
  } finally {
    await readyEvents.return?.();
    killChildGroup();
  }
});

test("uses configurable tags and never leaves a partial state on rename failure", async () => {
  const root = await fixture();
  const args: string[][] = [];
  const commandRunner: CommandRunner = async (argv) => {
    args.push([...argv]);
    return runner()(argv, 20_000);
  };
  await checkUpdates(root, {
    run: commandRunner,
    tags: { "omo-ai": "next", "@code-yeongyu/senpi": "beta" },
  });
  expect(args).toContainEqual([
    "npm",
    "--fetch-retries=0",
    "--fetch-timeout=5000",
    "view",
    "omo-ai",
    "dist-tags",
    "--json",
  ]);
  const stateDir = join(root, ".omo/state");
  await rm(join(stateDir, "update-check.json"));
  const fs = await import("node:fs/promises");
  const spy = spyOn(fs, "rename").mockRejectedValueOnce(new Error("crash before rename"));
  try {
    const result = await checkUpdates(root, { run: commandRunner });
    expect(result.state).toBe("unavailable");
    expect((await readdir(stateDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    let stateExists = true;
    try {
      await readFile(join(stateDir, "update-check.json"), "utf8");
    } catch (cause) {
      stateExists = !(cause instanceof Error && "code" in cause && cause.code === "ENOENT");
    }
    expect(stateExists).toBe(false);
  } finally {
    spy.mockRestore();
  }
});
