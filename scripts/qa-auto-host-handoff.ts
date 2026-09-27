import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RpcClient, SessionManager } from "@code-yeongyu/senpi";
import type { HerdrClient } from "../src/herdr";
import { runtimeCacheEnvironment } from "../src/host-profile";
import { checkedQaCommand, type prepareQaWorld, runQaCommand } from "./qa-world";

type World = Awaited<ReturnType<typeof prepareQaWorld>>;

async function waitFor(
  herdr: HerdrClient,
  predicate: (snapshot: Awaited<ReturnType<HerdrClient["snapshot"]>>) => boolean,
  trigger: () => Promise<void>,
): Promise<void> {
  const done = Promise.withResolvers<void>();
  const inspect = () =>
    void herdr.snapshot().then((snapshot) => {
      if (predicate(snapshot)) done.resolve();
    }, done.reject);
  const stop = await herdr.subscribe(inspect);
  const timeout = setTimeout(() => done.reject(new Error("auto-handoff QA deadline")), 60_000);
  try {
    await trigger();
    inspect();
    await done.promise;
  } finally {
    clearTimeout(timeout);
    stop();
  }
}

export async function autoHostHandoffQa(world: World, herdr: HerdrClient) {
  const workspace = await herdr.createWorkspace(world.repository, "auto-handoff");
  world.workspaces.push(workspace.workspaceId);
  const bin = join(world.scratch, "auto-handoff-bin");
  await Bun.write(
    join(bin, "olw"),
    `#!/bin/sh\nexec '${process.execPath}' '${join(world.controlRoot, "dist/cli.js")}' --root '${world.controlRoot}' "$@"\n`,
  );
  await checkedQaCommand(["chmod", "+x", join(bin, "olw")], world.scratch);
  const socket = join(world.controlRoot, ".omo/state/omo.sock");
  const oldSpec = join(world.controlRoot, "old-omo-host.json");
  await writeFile(
    oldSpec,
    JSON.stringify({
      spec_version: 1,
      core: {
        session_runtime: "in-process",
        multi_session: true,
        extensions: ["./node_modules/omo-ai/plugin"],
      },
      tunables: { coldStart: "persistent" },
      env: { OMO_NATIVE: "1", OMO_INITIATIVE_HOST: "1", OMO_RPC_SOCKET: socket },
    }),
  );
  await chmod(oldSpec, 0o600);
  const omo = join(world.controlRoot, "node_modules/.bin/omo");
  const hostEnv = { ...world.environment, ...runtimeCacheEnvironment(world.controlRoot) };
  await checkedQaCommand(
    [omo, "host", "ensure", "--socket", socket, "--launch-spec", oldSpec, "--policy", "never"],
    world.controlRoot,
    hostEnv,
  );
  const before = JSON.parse(
    await checkedQaCommand(
      [omo, "host", "status", "--socket", socket, "--include-workers"],
      world.controlRoot,
      hostEnv,
    ),
  ) as { generation: number; sessions: { total: number } };
  assert.equal(before.sessions.total, 0);
  const manager = SessionManager.create(
    world.controlRoot,
    join(world.controlRoot, ".omo/state/sessions"),
    { id: crypto.randomUUID() },
  );
  const sessionPath = manager.getSessionFile();
  assert.ok(sessionPath);
  await mkdir(join(world.controlRoot, ".omo/state/sessions"), { recursive: true });
  await writeFile(sessionPath, `${JSON.stringify(manager.getHeader())}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  const native = new RpcClient({ socketPath: socket });
  await native.start();
  const attached = await native.openSession({
    sessionPath,
    cwd: world.controlRoot,
    retain_on_disconnect: true,
  });
  const environment = {
    PATH: `${bin}:${process.env["PATH"] ?? ""}`,
    HERDR_SOCKET_PATH: world.herdrSocket,
  };
  const refused = await runQaCommand(
    ["script", "-qec", "olw manage", "/dev/null"],
    world.controlRoot,
    environment,
  );
  assert.equal(refused.code, 3, refused.stdout + refused.stderr);
  assert.match(refused.stdout, /session(?:s)? attached/);
  assert.match(refused.stdout, /omo host handoff --launch-spec/);
  assert.equal(refused.stdout.includes('{"ok":false'), false);
  await native.closeSession(attached.sessionId);
  await native.stop();

  const live = (snapshot: Awaited<ReturnType<HerdrClient["snapshot"]>>) =>
    snapshot.panes.some(
      (pane) =>
        pane.paneId === workspace.rootPaneId && (pane.agent === "pi" || pane.agent === "omo"),
    );
  await waitFor(herdr, live, () => herdr.run(workspace.rootPaneId, ["olw"], environment));
  const after = JSON.parse(
    await checkedQaCommand(
      [omo, "host", "status", "--socket", socket, "--include-workers"],
      world.controlRoot,
      hostEnv,
    ),
  ) as { generation: number; sessions: { total: number } };
  assert.ok(after.generation > before.generation);
  assert.ok(after.sessions.total > 0);
  assert.ok(existsSync(join(world.controlRoot, "omo-host.json")));
  return { before, refused: { code: refused.code, stdout: refused.stdout }, after };
}
