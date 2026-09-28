import { afterEach, expect, test } from "bun:test";
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadHostLaunchSpec } from "../node_modules/@code-yeongyu/senpi/dist/modes/rpc/host-launch-spec.js";
import { hostLaunchProfile } from "../node_modules/@code-yeongyu/senpi/dist/modes/rpc/protocol-identity.js";
import {
  createHostProfile,
  EXTENSION_PROTOCOL_MARKER,
  HostCommandTimeoutError,
  inspectHostHealth,
  observeEmptyHostSessions,
  RUNTIME_CACHE_MARKER,
  readHostStatusReadOnly,
  resolveOmoAgentDir,
  runtimeCacheEnvironment,
} from "../src/host-profile";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("an unreachable host reports no generation even when its registration remains", async () => {
  const root = await mkdtemp(join(tmpdir(), "olw-dead-host-"));
  roots.push(root);
  const socket = join(root, "absent.sock");
  const agentDir = join(root, "agent");
  const { daemonDirectoryName } = await import(
    "../node_modules/@code-yeongyu/senpi/dist/modes/rpc/host-daemon-paths.js"
  );
  const daemonDir = join(agentDir, "rpc-host-daemon", daemonDirectoryName(socket));
  await mkdir(join(daemonDir, "generations/dead"), { recursive: true });
  await writeFile(
    join(daemonDir, "host.pid"),
    JSON.stringify({ layout: 2, instance_id: "dead", generation_dir: "generations/dead" }),
  );
  await writeFile(
    join(daemonDir, "generations/dead/host.pid"),
    JSON.stringify({ pid: 2_147_483_647, processStartTime: "1", generation: 7 }),
  );

  const status = await readHostStatusReadOnly(socket, agentDir);

  expect(status.reachable).toBe(false);
  expect(status.reachability).toBe("unreachable");
  expect(status.generation).toBeNull();
});

test("read-only status classifies a silent protocol endpoint as unknown", async () => {
  const root = await mkdtemp(join(tmpdir(), "olw-host-silent-"));
  roots.push(root);
  const socket = join(root, "silent.sock");
  const server = createServer((connection) => connection.on("data", () => {}));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });
  try {
    const status = await readHostStatusReadOnly(socket, join(root, "agent"));
    expect(status).toMatchObject({ reachable: false, reachability: "unknown" });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "olw-host-profile-"));
  roots.push(root);
  const files = ["node_modules/omo-ai/plugin/extensions/omo-member.js", "dist/extension/index.js"];
  for (const file of files) {
    const path = join(root, file);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "");
  }
  const extensions = [join(root, "node_modules/omo-ai/plugin"), ...files.map((p) => join(root, p))];
  const status = {
    reachable: true,
    socket: join(root, ".omo/state/omo.sock"),
    generation: 4,
    launchProfile: hostLaunchProfile(
      [
        "--mode",
        "rpc",
        "--multi-session",
        "--session-runtime",
        "in-process",
        ...extensions.flatMap((path) => ["-e", path]),
      ],
      root,
    ),
    sessions: {
      total: 3,
      interactive: 2,
      worker: 1,
      retained: 0,
      foreign_attached: 0,
      foreign_retained: 0,
    },
    env_keys: [RUNTIME_CACHE_MARKER, "XDG_CACHE_HOME", EXTENSION_PROTOCOL_MARKER],
  };
  return { root, status };
}

test("rejects a running host missing the OLW extension without replacing its profile or sessions", async () => {
  const { root, status } = await fixture();
  const oldExtensions = status.launchProfile.core.extensions.slice(0, -1);
  const old = {
    ...status,
    launchProfile: hostLaunchProfile(
      [
        "--mode",
        "rpc",
        "--multi-session",
        "--session-runtime",
        "in-process",
        ...oldExtensions.flatMap((path) => ["-e", path]),
      ],
      root,
    ),
  };
  const result = await createHostProfile(root, old).then(
    () => null,
    (cause: unknown) => cause,
  );
  expect(result).toMatchObject({
    name: "HostProfileMismatchError",
    details: {
      missingExtensions: status.launchProfile.core.extensions.filter(
        (extension) => !oldExtensions.includes(extension),
      ),
      generation: 4,
      sessions: { total: 3, interactive: 2, worker: 1 },
      recovery: {
        automatic: false,
        argv: [
          join(root, "node_modules/.bin/omo"),
          "host",
          "handoff",
          "--launch-spec",
          join(root, "omo-host.json"),
          "--socket",
          status.socket,
        ],
      },
    },
  });
  expect(old.launchProfile.core.extensions).toHaveLength(2);
});

test("accepts required effective extensions while retaining additional host extensions", async () => {
  const { root, status } = await fixture();
  const extensions = [...status.launchProfile.core.extensions, join(root, "user-extension.js")];
  const withExtra = {
    ...status,
    launchProfile: hostLaunchProfile(
      [
        "--mode",
        "rpc",
        "--multi-session",
        "--session-runtime",
        "in-process",
        ...extensions.flatMap((path) => ["-e", path]),
      ],
      root,
    ),
  };
  expect(await createHostProfile(root, withExtra)).toBe(join(root, "omo-host.json"));
  const health = await inspectHostHealth(root, withExtra, { agentDir: join(root, "agent") });
  expect(health.profile.matchesOlw).toBe(true);
  expect(withExtra.launchProfile.core.extensions).toHaveLength(4);
});

test("does not consider an unknown running launch profile ready", async () => {
  const { root, status } = await fixture();
  await expect(createHostProfile(root, { ...status, launchProfile: null })).rejects.toThrow();
});

test("rejects a host missing the extension protocol marker with handoff recovery", async () => {
  const { root, status } = await fixture();
  const result = await createHostProfile(root, {
    ...status,
    env_keys: status.env_keys.filter((key) => key !== EXTENSION_PROTOCOL_MARKER),
  }).then(
    () => null,
    (cause: unknown) => cause,
  );
  expect(result).toMatchObject({
    name: "HostProfileMismatchError",
    details: {
      missingCapabilities: ["olw_extension_protocol_2"],
      recovery: {
        automatic: false,
        argv: [
          join(root, "node_modules/.bin/omo"),
          "host",
          "handoff",
          "--launch-spec",
          join(root, "omo-host.json"),
          "--socket",
          status.socket,
        ],
      },
    },
  });
});

test("writes a launch spec accepted by Senpi's real loader", async () => {
  const { root } = await fixture();
  const path = await createHostProfile(root);
  const loaded = await loadHostLaunchSpec(path);
  expect(loaded.env[EXTENSION_PROTOCOL_MARKER]).toBe("1");
});

test("rejects a reused host without cache isolation and supplies scoped handoff environment", async () => {
  const { root, status } = await fixture();
  const result = await createHostProfile(root, { ...status, env_keys: [] }).then(
    () => null,
    (cause: unknown) => cause,
  );
  expect(result).toMatchObject({
    details: {
      missingExtensions: [],
      missingCapabilities: ["runtime_cache_isolation", "olw_extension_protocol_2"],
      recovery: {
        automatic: false,
        env: {
          XDG_CACHE_HOME: expect.stringMatching(
            new RegExp(`^${RegExp.escape(join(root, ".omo/cache"))}/[^/]+/host$`),
          ),
        },
      },
    },
  });
});

test("refuses the previous runtime even when extension paths still match", async () => {
  const { root, status } = await fixture();
  await expect(
    createHostProfile(root, {
      ...status,
      env_keys: ["OMO_INITIATIVE_CACHE_V1", "XDG_CACHE_HOME", EXTENSION_PROTOCOL_MARKER],
    }),
  ).rejects.toThrow();
});

test("separates cache namespaces by control root and installed runtime", () => {
  const first = runtimeCacheEnvironment("/control-a", "/sdk/version-a/index.js");
  const nextRuntime = runtimeCacheEnvironment("/control-a", "/sdk/version-b/index.js");
  const otherControl = runtimeCacheEnvironment("/control-b", "/sdk/version-a/index.js");
  expect(first["XDG_CACHE_HOME"]).not.toBe(nextRuntime["XDG_CACHE_HOME"]);
  expect(first["XDG_CACHE_HOME"]).not.toBe(otherControl["XDG_CACHE_HOME"]);
  expect(first["XDG_CACHE_HOME"]).not.toBe(first["BUN_RUNTIME_TRANSPILER_CACHE_PATH"]);
  expect(runtimeCacheEnvironment("/control-a", "/sdk/version-a/index.js")).toEqual(first);
});

test("requires a validated raw empty session list before idle handoff", async () => {
  await expect(
    observeEmptyHostSessions("/fixture.sock", 10, async () => undefined),
  ).rejects.toThrow("session list");
  await expect(
    observeEmptyHostSessions("/fixture.sock", 10, async () => ({ sessions: "invalid" })),
  ).rejects.toThrow("session list");
  await expect(
    observeEmptyHostSessions("/fixture.sock", 10, async () => ({ sessions: [{}] })),
  ).rejects.toThrow("not empty");
  await expect(
    observeEmptyHostSessions("/fixture.sock", 10, async () => ({ sessions: [] })),
  ).resolves.toBeUndefined();
});

test("bounded host commands kill and reap a timed-out child", async () => {
  const killed: NodeJS.Signals[] = [];
  let reaped = false;
  const exit = Promise.withResolvers<number>();
  const child = {
    exited: exit.promise,
    stdout: new Response("").body,
    stderr: new Response("").body,
    kill(signal?: NodeJS.Signals) {
      killed.push(signal ?? "SIGTERM");
      reaped = true;
      exit.resolve(137);
    },
  };
  await expect(
    import("../src/host-profile").then(({ runBoundedHostCommand }) =>
      runBoundedHostCommand(["fixture"], "/tmp", {}, 20, () => child),
    ),
  ).rejects.toBeInstanceOf(HostCommandTimeoutError);
  expect(killed).toEqual(["SIGKILL"]);
  expect(reaped).toBe(true);
});

test("an output read failure kills and reaps the child before preserving the read error", async () => {
  const exit = Promise.withResolvers<number>();
  const readError = new Error("injected stdout failure");
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(readError);
    },
  });
  const signals: NodeJS.Signals[] = [];
  const child = {
    exited: exit.promise,
    stdout,
    stderr: new Response("").body,
    kill(signal?: NodeJS.Signals) {
      signals.push(signal ?? "SIGTERM");
      exit.resolve(137);
    },
  };
  await expect(
    import("../src/host-profile").then(({ runBoundedHostCommand }) =>
      runBoundedHostCommand(["fixture"], "/tmp", {}, 1000, () => child),
    ),
  ).rejects.toBe(readError);
  expect(signals).toEqual(["SIGKILL"]);
  expect(await child.exited).toBe(137);
});

test("bounded host commands kill the group, reap, then reject when the deadline fires", async () => {
  const exit = Promise.withResolvers<number>();
  const deadline = Promise.withResolvers<never>();
  const events: string[] = [];
  const child = {
    exited: exit.promise.then((code) => {
      events.push("reap");
      return code;
    }),
    stdout: new ReadableStream<Uint8Array>(),
    stderr: new ReadableStream<Uint8Array>(),
    kill() {
      events.push("kill");
      exit.resolve(137);
    },
  };
  const timeout = new HostCommandTimeoutError("handoff", 100);
  const running = import("../src/host-profile")
    .then(({ runBoundedHostCommand }) =>
      runBoundedHostCommand(["fixture"], "/tmp", {}, 100, () => child, "handoff", deadline.promise),
    )
    .catch((cause: unknown) => {
      events.push("reject");
      throw cause;
    });
  deadline.reject(timeout);
  await expect(running).rejects.toBe(timeout);
  expect(events).toEqual(["kill", "reap", "reject"]);
});

test("a pending custom deadline never disables the timeoutMs bound", async () => {
  const exit = Promise.withResolvers<number>();
  const pendingDeadline = Promise.withResolvers<never>();
  const events: string[] = [];
  const child = {
    exited: exit.promise.then((code) => {
      events.push("reap");
      return code;
    }),
    stdout: new ReadableStream<Uint8Array>(),
    stderr: new ReadableStream<Uint8Array>(),
    kill() {
      events.push("kill");
      exit.resolve(137);
    },
  };
  const scheduled = Promise.withResolvers<{ readonly fire: () => void; readonly ms: number }>();
  const running = import("../src/host-profile").then(({ runBoundedHostCommand }) =>
    runBoundedHostCommand(
      ["fixture"],
      "/tmp",
      {},
      250,
      () => child,
      "status",
      pendingDeadline.promise,
      (fire, ms) => {
        scheduled.resolve({ fire, ms });
        return () => {};
      },
    ),
  );
  const timeoutTimer = await scheduled.promise;
  expect(timeoutTimer.ms).toBe(250);
  timeoutTimer.fire();
  await expect(running).rejects.toBeInstanceOf(HostCommandTimeoutError);
  expect(events).toEqual(["kill", "reap"]);
});

test("successful host commands empty their detached process group before returning", async () => {
  const marker = join(tmpdir(), `olw-host-group-${crypto.randomUUID()}.pid`);
  roots.push(marker);
  const result = await import("../src/host-profile").then(({ runBoundedHostCommand }) =>
    runBoundedHostCommand(
      [
        "python3",
        "-c",
        `import os,signal; r,w=os.pipe(); pid=os.fork();\nif pid:\n os.close(w); os.read(r,1); os._exit(0)\nos.close(r); open(${JSON.stringify(marker)},'w').write(str(os.getpid())); os.close(1); os.close(2); os.write(w,b'1'); os.close(w); signal.pause()`,
      ],
      "/tmp",
      process.env,
      3000,
    ),
  );
  expect(result.code).toBe(0);
  const descendant = Number((await readFile(marker, "utf8")).trim());
  expect(() => process.kill(descendant, 0)).toThrow();
});

test("prepares a new profile when no host is reachable", async () => {
  const { root, status } = await fixture();
  expect(await createHostProfile(root, { ...status, reachable: false, launchProfile: null })).toBe(
    join(root, "omo-host.json"),
  );
  await rm(join(root, "omo-host.json"));
  const health = await inspectHostHealth(
    root,
    { ...status, reachable: false, launchProfile: null },
    { agentDir: join(root, "agent") },
  );
  expect(health.profile.matchesOlw).toBe(false);
  expect(health.profile.recovery).toMatchObject({
    ready: false,
    preparation: ["olw", "manage", "--root", root],
  });
});

test("reports generation, profile, sessions, RSS warnings, and local-only roles", async () => {
  const { root, status } = await fixture();
  const health = await inspectHostHealth(
    root,
    {
      ...status,
      rss_mb: 9_001,
      sessions: { ...status.sessions, total: 0, interactive: 0, worker: 0, retained: 0 },
    },
    {
      agentDir: join(root, "agent"),
      readyBindings: 2,
      rssWarningMb: 8_192,
    },
  );
  expect(health).toMatchObject({
    reachable: true,
    generation: 4,
    profile: { matchesOlw: true },
    sessions: { total: 0 },
    rssMb: 9_001,
    warnings: [
      expect.stringContaining("RSS 9001 MiB exceeds 8192 MiB"),
      expect.stringContaining("run olw status for per-binding state"),
    ],
  });
});

test("resolves the OMO agent directory with launcher precedence and cwd-relative overrides", () => {
  expect(
    resolveOmoAgentDir(
      {
        HOME: "/fallback",
        SENPI_CODING_AGENT_DIR: "senpi-state",
        PI_CODING_AGENT_DIR: "/pi-state",
      },
      "/fixture/cwd",
    ),
  ).toBe("/fixture/cwd/senpi-state");
  expect(
    resolveOmoAgentDir({ HOME: "/fallback", SENPI_CODING_AGENT_DIR: "relative" }, process.cwd()),
  ).toBe(join(process.cwd(), "relative"));
  expect(
    resolveOmoAgentDir({ HOME: "/fallback", OMO_CODING_AGENT_DIR: " /omo-state " }, "/fixture/cwd"),
  ).toBe("/omo-state");
  expect(resolveOmoAgentDir({ HOME: "/fallback" }, "/fixture/cwd")).toBe("/fallback/.omo/agent");
  expect(resolveOmoAgentDir({ HOME: "", USERPROFILE: "/fixture/profile" }, "/fixture/cwd")).toBe(
    "/fixture/profile/.omo/agent",
  );
  expect(resolveOmoAgentDir({ HOME: "", USERPROFILE: "" }, "/fixture/cwd")).toBe(
    join(homedir(), ".omo/agent"),
  );
});

test("reads only recent crashes for this socket and labels SIGKILL as likely OOM", async () => {
  const { root, status } = await fixture();
  const agentDir = join(root, "agent");
  const { daemonDirectoryName } = await import(
    "../node_modules/@code-yeongyu/senpi/dist/modes/rpc/host-daemon-paths.js"
  );
  const daemonDir = join(agentDir, "rpc-host-daemon", daemonDirectoryName(status.socket));
  await mkdir(daemonDir, { recursive: true });
  await writeFile(
    join(daemonDir, "crashes.jsonl"),
    [
      JSON.stringify({ at: "2026-09-20T23:59:59.999Z", signal: "SIGBUS", uptimeMs: 1 }),
      JSON.stringify({ at: "2026-09-21T00:00:00.000Z", signal: "SIGKILL", uptimeMs: 2 }),
      JSON.stringify({ at: "2026-09-27T17:54:32.119Z", signal: "SIGKILL", uptimeMs: 14_398_708 }),
      "not-json",
      JSON.stringify({ at: "2026-09-28T01:00:00.000Z", code: 1, uptimeMs: 50 }),
    ].join("\n"),
  );
  const health = await inspectHostHealth(
    root,
    { ...status, rss_mb: 512 },
    {
      agentDir,
      now: () => new Date("2026-09-28T02:00:00.000Z"),
    },
  );
  expect(health.crashes).toEqual([
    {
      at: "2026-09-27T17:54:32.119Z",
      signal: "SIGKILL",
      uptimeMs: 14_398_708,
      likelyOom: true,
    },
    { at: "2026-09-28T01:00:00.000Z", code: 1, uptimeMs: 50, likelyOom: false },
  ]);
});

test("preserves host diagnostics when the crash journal cannot be read", async () => {
  const { root, status } = await fixture();
  const agentDir = join(root, "agent");
  const { daemonDirectoryName } = await import(
    "../node_modules/@code-yeongyu/senpi/dist/modes/rpc/host-daemon-paths.js"
  );
  const journal = join(
    agentDir,
    "rpc-host-daemon",
    daemonDirectoryName(status.socket),
    "crashes.jsonl",
  );
  await mkdir(journal, { recursive: true });
  const health = await inspectHostHealth(root, { ...status, rss_mb: 512 }, { agentDir });
  expect(health.reachable).toBe(true);
  expect(health.crashes).toEqual([]);
  expect(health.crashHistoryError).toContain("crashes.jsonl");
});

test("flags a default crash-restart profile and provides the exact safe handoff command", async () => {
  const { root, status } = await fixture();
  const health = await inspectHostHealth(
    root,
    {
      ...status,
      generation: 0,
      rss_mb: 300,
      launchProfile: hostLaunchProfile(
        ["--mode", "rpc", "--multi-session", "--session-runtime", "in-process"],
        root,
      ),
    },
    { agentDir: join(root, "agent") },
  );
  expect(health.profile).toMatchObject({
    matchesOlw: false,
    recovery: {
      argv: [
        join(root, "node_modules/.bin/omo"),
        "host",
        "handoff",
        "--launch-spec",
        join(root, "omo-host.json"),
        "--socket",
        status.socket,
      ],
    },
  });
  expect(health.warnings).toEqual([expect.stringContaining("does not match OLW")]);
  expect(health.profile.recovery).toMatchObject({
    ready: false,
    preparation: expect.any(Array),
    env: runtimeCacheEnvironment(root),
    argv: expect.any(Array),
  });
});

test("doctor leaves the endpoint daemon tree byte-identical", async () => {
  const { root, status } = await fixture();
  await mkdir(join(root, "node_modules/.bin"), { recursive: true });
  await Bun.write(join(root, "node_modules/.bin/omo"), "#!/bin/sh\nexit 91\n");
  await chmod(join(root, "node_modules/.bin/omo"), 0o700);
  await cp(join(import.meta.dir, "../herdr-release.json"), join(root, "herdr-release.json"));
  await cp(join(import.meta.dir, "../.omo/herdr"), join(root, ".omo/herdr"), { recursive: true });
  await mkdir(join(root, ".omo/state"), { recursive: true });
  const agentDir = join(root, "agent");
  const { daemonDirectoryName } = await import(
    "../node_modules/@code-yeongyu/senpi/dist/modes/rpc/host-daemon-paths.js"
  );
  const daemonDir = join(agentDir, "rpc-host-daemon", daemonDirectoryName(status.socket));
  await mkdir(join(daemonDir, "generations/dead/scratch"), { recursive: true });
  await mkdir(join(daemonDir, "reservations"), { recursive: true });
  await writeFile(
    join(daemonDir, "host.pid"),
    JSON.stringify({ layout: 2, instance_id: "dead", generation_dir: "generations/dead" }),
  );
  await writeFile(
    join(daemonDir, "generations/dead/host.pid"),
    JSON.stringify({ pid: 2_147_483_647, processStartTime: "1", generation: 7 }),
  );
  await writeFile(
    join(daemonDir, "reservations/old-session.json"),
    JSON.stringify({ sessionPath: "/old/session.jsonl", attached: true }),
  );
  const commands: string[] = [];
  const server = createServer((client) => {
    client.on("data", (chunk) => {
      const request = JSON.parse(chunk.toString("utf8").trim());
      commands.push(request.type);
      client.write(
        `${JSON.stringify({
          id: request.id,
          success: true,
          data: {
            protocolVersion: 1,
            serverVersion: "fixture",
            capabilities: [],
            generation: 7,
            launch_profile: status.launchProfile,
          },
        })}\n`,
      );
    });
  });
  const listening = Promise.withResolvers<void>();
  server.once("listening", () => listening.resolve());
  server.once("error", (cause) => listening.reject(cause));
  server.listen(status.socket);
  await Promise.race([
    listening.promise,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("fixture socket did not listen")), 1_000),
    ),
  ]);
  const snapshot = async () => {
    const files = (await readdir(daemonDir, { recursive: true })).sort();
    return Promise.all(
      files.map(async (file) => {
        const path = join(daemonDir, file);
        return [file, (await Bun.file(path).exists()) && (await Bun.file(path).text())] as const;
      }),
    );
  };
  const before = await snapshot();
  const proc = Bun.spawn(
    [process.execPath, join(import.meta.dir, "../src/cli.ts"), "--root", root, "doctor", "--json"],
    {
      cwd: root,
      env: { ...process.env, HOME: root, SENPI_CODING_AGENT_DIR: agentDir },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]).finally(() => server.close());
  const output = JSON.parse(stdout);
  expect([code, stderr]).toEqual([3, ""]);
  expect(output).toMatchObject({
    ok: false,
    error: { details: { sideEffects: false } },
  });
  expect(commands).toEqual(["get_protocol_info"]);
  expect(await snapshot()).toEqual(before);
});
