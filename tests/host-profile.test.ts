import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHostProfile,
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
  const files = [
    "node_modules/omo-ai/plugin/extensions/omo-member.js",
    "dist/extension/index.js",
    "dist/proxy/index.js",
  ];
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
    sessions: { total: 3, worker: 1 },
    env_keys: [RUNTIME_CACHE_MARKER, "XDG_CACHE_HOME"],
  };
  return { root, status };
}

test("rejects a running host missing the proxy without replacing its profile or sessions", async () => {
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
      missingExtensions: [join(root, "dist/proxy/index.js")],
      generation: 4,
      sessions: { total: 3, worker: 1 },
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
  expect(old.launchProfile.core.extensions).toHaveLength(3);
});

test("accepts required effective extensions while retaining additional host extensions", async () => {
  const { root, status } = await fixture();
  status.launchProfile.core.extensions.push(join(root, "user-extension.js"));
  expect(await createHostProfile(root, status)).toBe(join(root, "omo-host.json"));
  expect(status.launchProfile.core.extensions).toHaveLength(5);
});

test("does not consider an unknown running launch profile ready", async () => {
  const { root, status } = await fixture();
  await expect(createHostProfile(root, { ...status, launchProfile: null })).rejects.toThrow();
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
      missingCapabilities: ["runtime_cache_isolation"],
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
      env_keys: ["OMO_INITIATIVE_CACHE_V1", "XDG_CACHE_HOME"],
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

test("prepares a new profile when no host is reachable", async () => {
  const { root, status } = await fixture();
  expect(await createHostProfile(root, { ...status, reachable: false, launchProfile: null })).toBe(
    join(root, "omo-host.json"),
  );
});
