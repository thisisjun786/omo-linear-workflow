import assert from "node:assert/strict";
import { existsSync, watch } from "node:fs";
import { join } from "node:path";
import type { RpcClient } from "@code-yeongyu/senpi";
import { z } from "zod";
import type { Binding } from "../src/core/contracts";
import { openRegistry } from "../src/core/store";
import type { HerdrClient } from "../src/herdr";
import { planPaneExited } from "../src/orchestrator";
import { idle } from "./qa-hierarchy";
import { checkedQaCommand, type prepareQaWorld } from "./qa-world";

type World = Awaited<ReturnType<typeof prepareQaWorld>>;
export async function managerEntryQa(world: World, herdr: HerdrClient) {
  const first = await herdr.createWorkspace(world.repository, "entry-first");
  const second = await herdr.createWorkspace(world.repository, "entry-second");
  world.workspaces.push(first.workspaceId, second.workspaceId);
  const bin = join(world.scratch, "entry-bin");
  await Bun.write(
    join(bin, "olw"),
    `#!/bin/sh\nexec '${process.execPath}' '${join(world.controlRoot, "dist/cli.js")}' --root '${world.controlRoot}' "$@"\n`,
  );
  await checkedQaCommand(["chmod", "+x", join(bin, "olw")], world.scratch);
  const environment = {
    PATH: `${bin}:${process.env["PATH"]}`,
    HERDR_SOCKET_PATH: world.herdrSocket,
  };
  const wait = async (
    predicate: (snapshot: Awaited<ReturnType<HerdrClient["snapshot"]>>) => boolean,
    trigger: () => Promise<void>,
  ) => {
    const done = Promise.withResolvers<void>();
    const inspect = () => {
      void herdr.snapshot().then((snapshot) => {
        if (predicate(snapshot)) done.resolve();
      }, done.reject);
    };
    const stop = await herdr.subscribe(inspect);
    const timer = setTimeout(() => done.reject(new Error("Entry surface deadline")), 60000);
    try {
      await trigger();
      inspect();
      await done.promise;
    } finally {
      clearTimeout(timer);
      stop();
    }
  };
  const current = () => {
    const registry = openRegistry(join(world.controlRoot, ".omo/state/registry.sqlite"), {
      readonly: true,
    });
    try {
      const listed = registry.list();
      assert.ok(listed.ok);
      const manager = listed.value.find((b) => b.assignment.role === "manager");
      assert.ok(manager);
      return manager;
    } finally {
      registry.close();
    }
  };
  const live = (paneId: string) => (snapshot: Awaited<ReturnType<HerdrClient["snapshot"]>>) =>
    snapshot.panes.some((p) => p.paneId === paneId && (p.agent === "pi" || p.agent === "omo"));
  await wait(live(first.rootPaneId), () => herdr.run(first.rootPaneId, ["olw"], environment));
  // The foreground CLI initializes after TUI readiness. Observe the SQLite write before reading.
  await registryState(world, () => current().launchState === "ready");
  const initial = current();
  assert.equal(initial.paneId, first.rootPaneId);
  assert.equal(initial.workspaceId, first.workspaceId);
  assert.equal(initial.cwd, world.repository);
  assert.equal(initial.workspaceOwned, false);
  const before = await herdr.snapshot();
  await herdr.focusPane(second.rootPaneId);
  await wait(
    (s) => s.focusedPaneId === first.rootPaneId,
    () =>
      herdr.run(
        second.rootPaneId,
        ["sh", "-c", `olw; code=$?; printf '%s' "$code" > '${join(world.scratch, "focus-exit")}'`],
        environment,
      ),
  );
  const focusExit = join(world.scratch, "focus-exit");
  const finished = Promise.withResolvers<void>();
  const inspectExit = () => {
    if (existsSync(focusExit)) finished.resolve();
  };
  const exitWatcher = watch(world.scratch, inspectExit);
  const exitTimer = setTimeout(() => finished.reject(new Error("Focus CLI exit deadline")), 30000);
  try {
    inspectExit();
    await finished.promise;
  } finally {
    exitWatcher.close();
    clearTimeout(exitTimer);
  }
  assert.equal(await Bun.file(focusExit).text(), "0");
  const after = await herdr.snapshot();
  assert.equal(after.workspaces.length, before.workspaces.length);
  assert.equal(after.panes.length, before.panes.length);
  assert.equal(current().id, initial.id);
  const exited = Promise.withResolvers<void>();
  const stop = await herdr.subscribe((event) => {
    if (planPaneExited(event, first.rootPaneId)) exited.resolve();
  });
  const timer = setTimeout(() => exited.reject(new Error("Manager exit deadline")), 30000);
  try {
    await herdr.sendKeys(first.rootPaneId, "/quit", ["Enter"]);
    await exited.promise;
  } finally {
    stop();
    clearTimeout(timer);
  }
  const wrapperPid = join(world.scratch, "entry-wrapper.pid");
  const wrapperExit = join(world.scratch, "entry-wrapper.exit");
  await wait(live(second.rootPaneId), () =>
    herdr.run(
      second.rootPaneId,
      [
        "sh",
        "-c",
        `sh -c 'echo $$ > "${wrapperPid}"; exec olw'; printf '%s' "$?" > '${wrapperExit}'`,
      ],
      environment,
    ),
  );
  const reattached = current();
  assert.equal(reattached.id, initial.id);
  assert.equal(reattached.durableSessionId, initial.durableSessionId);
  assert.equal(reattached.sessionPath, initial.sessionPath);
  assert.equal(reattached.paneId, second.rootPaneId);
  assert.equal(reattached.workspaceId, second.workspaceId);
  const pid = z.coerce
    .number()
    .int()
    .positive()
    .parse((await Bun.file(wrapperPid).text()).trim());
  const cmdline = await Bun.file(`/proc/${pid}/cmdline`).text();
  assert.ok(cmdline.includes(world.controlRoot));
  const signalDone = Promise.withResolvers<void>();
  const signalWatcher = watch(world.scratch, () => {
    if (existsSync(wrapperExit)) signalDone.resolve();
  });
  const signalTimer = setTimeout(
    () => signalDone.reject(new Error("Signalled wrapper did not exit")),
    30000,
  );
  try {
    process.kill(pid, "SIGTERM");
    await signalDone.promise;
  } finally {
    signalWatcher.close();
    clearTimeout(signalTimer);
  }
  await wait(
    (snapshot) => !live(second.rootPaneId)(snapshot),
    async () => {},
  );
  await wait(live(first.rootPaneId), () => herdr.run(first.rootPaneId, ["olw"], environment));
  const recovered = current();
  assert.equal(recovered.id, initial.id);
  assert.equal(recovered.durableSessionId, initial.durableSessionId);
  assert.equal(recovered.paneId, first.rootPaneId);
  return {
    manager: recovered,
    evidence: {
      signalRecovery: {
        signal: "SIGTERM",
        wrapperPid: pid,
        wrapperExit: await Bun.file(wrapperExit).text(),
        recovered,
      },
      initial,
      reattached,
      before,
      after,
      samePaneLaunch: true,
      focusWithoutCreation: true,
      sameSessionReattach: true,
    },
  };
}

async function registryState(world: World, predicate: () => boolean): Promise<void> {
  const done = Promise.withResolvers<void>();
  const inspect = () => {
    try {
      if (predicate()) done.resolve();
    } catch (cause) {
      done.reject(cause);
    }
  };
  const watcher = watch(join(world.controlRoot, ".omo/state"), inspect);
  const timer = setTimeout(() => done.reject(new Error("Registry transition deadline")), 30000);
  try {
    inspect();
    await done.promise;
  } finally {
    watcher.close();
    clearTimeout(timer);
  }
}

export async function managerBusyNoticeQa(
  world: World,
  manager: Binding,
  parent: Binding,
  client: RpcClient,
) {
  await idle(client);
  const gate = process.env["QA_OFFICIAL_GATE"];
  assert.ok(gate);
  const held = Promise.withResolvers<void>();
  const watcher = watch(gate, () => {
    if (existsSync(join(gate, "entered"))) held.resolve();
  });
  const heldTimer = setTimeout(() => held.reject(new Error("Provider hold deadline")), 30000);
  try {
    await client.prompt("OLW_ENTRY_BUSY_GATE");
    await held.promise;
  } finally {
    watcher.close();
    clearTimeout(heldTimer);
  }
  assert.equal((await client.getState()).isStreaming, true);
  const file = join(world.scratch, "busy-report.txt");
  await Bun.write(file, "completed QA-1\n" + "Full evidence payload. ".repeat(100));
  const id = "qa-entry-busy-report";
  const sendingSignal = registryState(world, () => {
    const registry = openRegistry(join(world.controlRoot, ".omo/state/registry.sqlite"), {
      readonly: true,
    });
    try {
      const record = registry.delivery(id);
      return record.ok && record.value.state === "sending";
    } finally {
      registry.close();
    }
  });
  const sending = world.cli([
    "report",
    "--from",
    parent.id,
    "--id",
    id,
    "--outcome",
    "completed",
    "--text-file",
    file,
  ]);
  await sendingSignal;
  assert.equal((await client.getState()).isStreaming, true);
  const before = JSON.stringify(await client.getMessages());
  assert.equal(before.includes(id), false);
  await Bun.write(join(gate, "release"), "release");
  const result = await sending;
  assert.equal(result.code, 0, result.stdout + result.stderr);
  await idle(client);
  const messages = z.array(z.unknown()).parse(await client.getMessages());
  const delivered = messages
    .map((message) => JSON.stringify(message))
    .find((message) => message.includes(id));
  assert.ok(delivered);
  const native = z
    .object({ content: z.array(z.object({ type: z.string(), text: z.string().optional() })) })
    .parse(JSON.parse(delivered));
  const noticeText = native.content.map((part) => part.text ?? "").join("");
  const noticeStart = noticeText.indexOf("[OLW] ");
  assert.ok(noticeStart >= 0);
  const [notice, encoded] = noticeText.slice(noticeStart).split("\n");
  assert.ok(notice && notice.length < 240);
  assert.equal(z.object({ id: z.string() }).parse(JSON.parse(encoded ?? "null")).id, id);
  const record = z
    .object({
      ok: z.literal(true),
      value: z.object({
        state: z.literal("accepted"),
        envelope: z.object({ toBindingId: z.string() }),
      }),
    })
    .parse(JSON.parse(result.stdout));
  assert.equal(record.value.envelope.toBindingId, manager.id);
  return {
    busyBeforeRelease: true,
    absentWhileBusy: true,
    deliveredAfterRelease: true,
    oneLineNotice: notice,
    nativeMessage: JSON.parse(delivered),
    receipt: record,
  };
}
