import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHostLaunchSpec } from "../node_modules/@code-yeongyu/senpi/dist/modes/rpc/host-launch-spec.js";
import {
  createHostProfile,
  EXTENSION_PROTOCOL_MARKER,
  HostCommandTimeoutError,
  observeEmptyHostSessions,
  RUNTIME_CACHE_MARKER,
  runtimeCacheEnvironment,
} from "../src/host-profile";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
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
    launchProfile: { core: { session_runtime: "in-process", multi_session: true, extensions } },
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
  const old = {
    ...status,
    launchProfile: {
      core: {
        ...status.launchProfile.core,
        extensions: status.launchProfile.core.extensions.slice(0, -1),
      },
    },
  };
  const result = await createHostProfile(root, old).then(
    () => null,
    (cause: unknown) => cause,
  );
  expect(result).toMatchObject({
    name: "HostProfileMismatchError",
    details: {
      missingExtensions: [join(root, "dist/extension/index.js")],
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
  status.launchProfile.core.extensions.push(join(root, "user-extension.js"));
  expect(await createHostProfile(root, status)).toBe(join(root, "omo-host.json"));
  expect(status.launchProfile.core.extensions).toHaveLength(4);
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
});
