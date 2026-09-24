import assert from "node:assert/strict";
import { watch } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { RpcClient } from "@code-yeongyu/senpi";
import { z } from "zod";
import type { Binding, DeliveryRecord } from "../src/core/contracts";
import { modelForRole } from "../src/core/policy";
import { bindingSchema, deliveryRecordSchema } from "../src/core/schema";
import { openRegistry } from "../src/core/store";
import { createHerdrClient, type Snapshot } from "../src/herdr";
import { runtimeCacheEnvironment } from "../src/host-profile";
import { attach, idle } from "./qa-hierarchy";
import { captureTui } from "./qa-tui-capture";
import { checkedQaCommand, prepareQaWorld } from "./qa-world";

const success = z.object({ ok: z.literal(true), value: z.unknown() });
const created = z.object({
  binding: bindingSchema.refine(
    (binding) => binding.launchState === "ready" && binding.initialization.state === "accepted",
  ),
});
const projectRef = (id: string) => ({ id, url: `linear://project/${id}`, revision: "qa-r1" });
const project = (id: string) => ({
  project: projectRef(id),
  issues: [{ id: `${id}-issue`, url: `linear://issue/${id}-issue`, revision: "qa-r1" }],
});

function changed(path: string) {
  const signal = Promise.withResolvers<void>();
  const timer = setTimeout(() => signal.reject(new Error(`No readiness update: ${path}`)), 30_000);
  const watcher = watch(dirname(path), (_event, name) => {
    if (name === basename(path)) signal.resolve();
  });
  watcher.on("error", signal.reject);
  return {
    promise: signal.promise,
    close() {
      clearTimeout(timer);
      watcher.close();
    },
  };
}
function text(message: Awaited<ReturnType<RpcClient["getMessages"]>>[number]) {
  if (!("content" in message)) return "";
  return typeof message.content === "string"
    ? message.content
    : message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
}
function grouped(snapshot: Snapshot, parents: Binding[], children: Binding[]) {
  for (const [index, parent] of parents.entries()) {
    const child = children[index];
    assert.ok(child);
    assert.equal(
      snapshot.workspaces.find((entry) => entry.workspaceId === parent.workspaceId)
        ?.groupHeadWorkspaceId,
      parent.workspaceId,
    );
    assert.equal(
      snapshot.workspaces.find((entry) => entry.workspaceId === child.workspaceId)
        ?.groupHeadWorkspaceId,
      parent.workspaceId,
    );
  }
  assert.notEqual(parents[0]?.workspaceId, parents[1]?.workspaceId);
}

async function main() {
  const qa = await prepareQaWorld();
  const evidence = join(qa.installRoot, ".omo/evidence/real-use-repairs/standalone-groups");
  await mkdir(evidence, { recursive: true });
  let herdr = createHerdrClient(qa.herdrSocket);
  const clients: RpcClient[] = [];
  const log: {
    result: string;
    root: string;
    roles?: unknown;
    workflow?: unknown;
    reports?: unknown;
    management?: unknown;
    restart?: unknown;
    captures: unknown[];
    error?: string;
    cleanup?: string;
    cleanupError?: string;
  } = { result: "incomplete", root: qa.scratch, captures: [] };
  let failure: unknown;
  const invoke = async (args: string[]) => {
    const result = await qa.cli(args);
    assert.equal(result.code, 0, JSON.stringify(result));
    return success.parse(JSON.parse(result.stdout)).value;
  };
  const bindings = () => {
    const registry = openRegistry(join(qa.controlRoot, ".omo/state/registry.sqlite"), {
      readonly: true,
    });
    try {
      const result = registry.list();
      assert.ok(result.ok);
      return result.value;
    } finally {
      registry.close();
    }
  };
  try {
    const anchor = await herdr.createWorkspace(qa.repository, "unrelated-anchor");
    qa.workspaces.push(anchor.workspaceId);
    const initial = await herdr.snapshot();
    const parents: Binding[] = [];
    const children: Binding[] = [];
    for (const id of ["qa-project-a", "qa-project-b"]) {
      const path = join(qa.scratch, `${id}.json`);
      await writeFile(
        path,
        JSON.stringify({
          version: 1,
          source: "fixture",
          initiative: null,
          projects: [project(id)],
          decisionRefs: [],
        }),
      );
      const { digest } = z
        .object({ digest: z.string() })
        .parse(await invoke(["scope", "import", "--file", path, "--fixture"]));
      const parent = created.parse(
        await invoke([
          "parent",
          "create",
          "--project",
          id,
          "--scope-digest",
          digest,
          "--designation",
          id,
          "--execute",
          "--fixture",
          "--repo",
          qa.repository,
          "--base",
          "main",
        ]),
      ).binding;
      parents.push(parent);
      const child = created.parse(
        await invoke(["child", "create", "--parent", parent.id, "--issue", `${id}-issue`]),
      ).binding;
      children.push(child);
    }
    assert.equal(bindings().length, 4);
    assert.ok(bindings().every((binding) => binding.assignment.role !== "supervisor"));
    for (const binding of [...parents, ...children]) {
      const client = await attach(binding);
      clients.push(client);
      await idle(client);
      const state = await client.getState();
      const expected = modelForRole(binding.assignment.role);
      assert.equal(state.model?.provider, expected.provider);
      assert.equal(state.model?.id, expected.modelId);
      assert.equal(state.thinkingLevel, expected.thinking);
      assert.ok(binding.sessionPath);
      assert.equal(
        await Bun.file(
          join(dirname(binding.sessionPath), "extensions/goal", `${binding.durableSessionId}.json`),
        ).exists(),
        false,
      );
    }
    for (const [index, binding] of [...parents, ...children].entries()) {
      assert.ok(binding.workspaceId);
      const label =
        index < 2 ? `parent-${index === 0 ? "A" : "B"}` : `child-${index === 2 ? "A" : "B"}`;
      await checkedQaCommand(
        [
          "herdr",
          "--session",
          basename(dirname(qa.herdrSocket)),
          "workspace",
          "rename",
          binding.workspaceId,
          label,
        ],
        qa.repository,
        qa.environment,
      );
    }
    const standalone = await herdr.snapshot();
    grouped(standalone, parents, children);
    assert.equal(standalone.workspaces.length, 5);
    assert.equal(standalone.focusedWorkspaceId, initial.focusedWorkspaceId);
    log.roles = { parents, children, standalone };
    log.captures.push(await captureTui(qa, join(evidence, "standalone.ansi"), "child-B"));
    const parent = parents[0];
    const child = children[0];
    const parentRpc = clients[0];
    const childRpc = clients[2];
    assert.ok(parent && child && parentRpc && childRpc);
    const packet = `packet-${crypto.randomUUID()}`;
    const runKey = `olw:${child.id}:${packet}:p1`;
    const reportId = `report-${packet}`;
    const token = `STANDALONE_REPORT_${crypto.randomUUID().replaceAll("-", "")}`;
    const artifact = join(child.cwd, "standalone.txt");
    const reportBody = join(child.cwd, "qa-report.txt");
    const packetPath = join(qa.scratch, "packet.txt");
    await writeFile(
      packetPath,
      `TASK: Execute this one explicitly approved fixture issue packet ${packet}, only in your checkout. Read mass-ulw, its planning reference and olw-run. Create one issue goal, not coordination or worker goals.\nDELIVERABLE: One native workflow run started via tool.workflow with key ${runKey}; exactly one quick node named producer. That worker's self-contained English prompt must start TASK and include DELIVERABLE, SCOPE, VERIFY, STOP WHEN. It must write exactly STANDALONE followed by one newline to ${artifact}, then stop.\nSCOPE: Worker may write only that artifact. No commits, Linear, OLW, goals, threads or nested workflow in the worker. You may additionally write ${reportBody}. Do not create any OLW roles or run another graph. This explicit packet permits the internal workflow worker despite fixture standby; no other work is authorized.\nVERIFY: Await native completion notifications without polling. Read the actual artifact and inspect the native run yourself. Complete only for the exact bytes and successful producer. Write ${reportBody} with the branch, HEAD, checked artifact and run ID, ending with: Reply exactly ${token} and do not take other actions. Report once: bun ${join(qa.controlRoot, "dist/cli.js")} --root ${qa.controlRoot} --herdr-socket ${qa.herdrSocket} report --from ${child.id} --id ${reportId} --outcome completed --evidence ${artifact} --text-file ${reportBody} --json. Complete the issue goal only after confirmed report acceptance.\nSTOP WHEN: One verified run, correct artifact, completed issue goal and one parent report. Do not merge or start another packet.`,
    );
    assert.ok(child.sessionPath);
    const goalPath = join(
      dirname(child.sessionPath),
      "extensions/goal",
      `${child.durableSessionId}.json`,
    );
    await mkdir(dirname(goalPath), { recursive: true });
    const goalComplete = Promise.withResolvers<void>();
    const goalWatcher = watch(dirname(goalPath), (_event, name) => {
      if (name !== basename(goalPath)) return;
      void readFile(goalPath, "utf8")
        .then((source) => {
          const state = z
            .object({
              version: z.literal(1),
              goal: z.object({ threadId: z.literal(child.durableSessionId), status: z.string() }),
            })
            .parse(JSON.parse(source));
          if (state.goal.status === "complete") goalComplete.resolve();
          if (state.goal.status === "blocked")
            goalComplete.reject(new Error("Owned child issue goal became blocked"));
        })
        .catch(goalComplete.reject);
    });
    goalWatcher.on("error", goalComplete.reject);
    const reportArrived = Promise.withResolvers<void>();
    const deadline = setTimeout(() => {
      const error = new Error("Standalone child workflow/report/goal timed out");
      reportArrived.reject(error);
      goalComplete.reject(error);
    }, 900_000);
    const off = parentRpc.onEvent((event) => {
      if (
        event.type === "message_end" &&
        event.message.role === "assistant" &&
        text(event.message).includes(token)
      )
        reportArrived.resolve();
    });
    try {
      await Promise.all([
        invoke([
          "send",
          "--from",
          parent.id,
          "--to",
          child.id,
          "--id",
          packet,
          "--kind",
          "instruction",
          "--text-file",
          packetPath,
        ]),
        reportArrived.promise,
        goalComplete.promise,
      ]);
    } finally {
      clearTimeout(deadline);
      off();
      goalWatcher.close();
    }
    await idle(childRpc);
    await idle(parentRpc);
    assert.equal(await readFile(artifact, "utf8"), "STANDALONE\n");
    const runs = z
      .object({ runs: z.array(z.object({ runId: z.string(), runKey: z.string() })) })
      .parse(success.parse(await childRpc.requestExtension("omo.dag.list", { limit: 100 })).value);
    assert.equal(runs.runs.length, 1);
    const run = runs.runs[0];
    assert.ok(run);
    assert.equal(run.runKey, runKey);
    const snapshot = z
      .object({
        runId: z.string(),
        runKey: z.string(),
        status: z.literal("completed"),
        nodes: z.array(
          z.object({ id: z.string(), state: z.literal("completed"), attempt: z.literal(1) }),
        ),
      })
      .parse(
        success.parse(await childRpc.requestExtension("omo.dag.snapshot", { runId: run.runId }))
          .value,
      );
    assert.equal(snapshot.nodes.length, 1);
    assert.equal(snapshot.nodes[0]?.id, "producer");
    const registry = openRegistry(join(qa.controlRoot, ".omo/state/registry.sqlite"), {
      readonly: true,
    });
    let childReport: DeliveryRecord | undefined;
    try {
      const result = registry.delivery(reportId);
      assert.ok(result.ok);
      childReport = result.value;
    } finally {
      registry.close();
    }
    assert.ok(childReport);
    assert.equal(childReport.state, "accepted");
    assert.equal(
      (await parentRpc.getMessages()).filter(
        (message) => message.role === "user" && text(message).includes(`"id":"${reportId}"`),
      ).length,
      1,
    );
    log.workflow = {
      packet,
      artifact,
      bytes: "STANDALONE\n",
      snapshot,
      report: childReport,
      goal: JSON.parse(await readFile(goalPath, "utf8")),
    };
    console.log("QA_PHASE standalone child ran a native workflow and reported once");
    const userBody = join(qa.scratch, "user-report.txt");
    const userRecords = [];
    for (const outcome of ["completed", "blocked", "failed"]) {
      await writeFile(
        userBody,
        outcome === "blocked"
          ? "QA user question: waiting for an explicit user decision; no acceptance inferred."
          : `QA ${outcome} report; not Linear acceptance.`,
      );
      const record = deliveryRecordSchema.parse(
        await invoke([
          "report",
          "--from",
          parent.id,
          "--id",
          `user-${outcome}`,
          "--outcome",
          outcome,
          "--text-file",
          userBody,
        ]),
      );
      assert.equal(record.state, "posted");
      assert.equal(record.envelope.toBindingId, null);
      assert.equal(record.receipt, null);
      userRecords.push(record);
    }
    const inbox = z
      .array(deliveryRecordSchema)
      .parse(await invoke(["reports", "--project", "qa-project-a"]));
    assert.equal(inbox.length, userRecords.length);
    for (const record of userRecords)
      assert.deepEqual(
        inbox.find((entry) => entry.envelope.id === record.envelope.id),
        record,
      );
    const managerScope = join(qa.scratch, "manager.json");
    await writeFile(
      managerScope,
      JSON.stringify({
        version: 1,
        source: "fixture",
        initiative: {
          id: "qa-management",
          url: "linear://initiative/qa-management",
          revision: "qa-r1",
        },
        projects: [project("qa-project-a"), project("qa-project-b")],
        decisionRefs: [],
      }),
    );
    const managerDigest = z
      .object({ digest: z.string() })
      .parse(await invoke(["scope", "import", "--file", managerScope, "--fixture"]));
    const manager = created.parse(
      await invoke([
        "supervisor",
        "create",
        "--initiative",
        "qa-management",
        "--scope-digest",
        managerDigest.digest,
        "--designation",
        "qa-manager",
        "--execute",
        "--fixture",
      ]),
    ).binding;
    const managerRpc = await attach(manager);
    clients.push(managerRpc);
    await idle(managerRpc);
    for (const owner of parents)
      await invoke(["parent", "link", "--parent", owner.id, "--supervisor", manager.id]);
    const linked = await herdr.snapshot();
    grouped(linked, parents, children);
    assert.equal(bindings().length, 5);
    await writeFile(userBody, "QA completed report; not Linear acceptance.");
    const replay = deliveryRecordSchema.parse(
      await invoke([
        "report",
        "--from",
        parent.id,
        "--id",
        "user-completed",
        "--outcome",
        "completed",
        "--text-file",
        userBody,
      ]),
    );
    assert.deepEqual(replay, userRecords[0]);
    log.reports = { userRecords, replay };
    log.captures.push(await captureTui(qa, join(evidence, "managed.ansi"), "child-B"));
    await invoke(["pause", "--binding", manager.id]);
    assert.equal(bindings().find((binding) => binding.id === parent.id)?.contactState, "active");
    const pingPath = join(qa.scratch, "ping.txt");
    await writeFile(
      pingPath,
      "Acknowledge this bounded QA contact check only. Do not start a packet, workflow, goal or report.",
    );
    const ping = deliveryRecordSchema.parse(
      await invoke([
        "send",
        "--from",
        parent.id,
        "--to",
        child.id,
        "--id",
        "manager-paused-ping",
        "--kind",
        "instruction",
        "--text-file",
        pingPath,
      ]),
    );
    assert.equal(ping.state, "accepted");
    await idle(childRpc);
    await invoke(["pause", "--binding", parent.id]);
    const blocked = await qa.cli([
      "send",
      "--from",
      parent.id,
      "--to",
      child.id,
      "--id",
      "parent-paused-ping",
      "--kind",
      "instruction",
      "--text-file",
      pingPath,
    ]);
    assert.equal(blocked.code, 2);
    await invoke(["resume", "--binding", parent.id]);
    await invoke(["resume", "--binding", manager.id]);
    await invoke(["parent", "unlink", "--parent", parent.id]);
    await invoke(["parent", "link", "--parent", parent.id, "--supervisor", manager.id]);
    await managerRpc.stop();
    await invoke(["close", "--binding", manager.id]);
    const afterClose = await herdr.snapshot();
    grouped(afterClose, parents, children);
    assert.equal(afterClose.workspaces.length, 5);
    assert.equal(afterClose.focusedWorkspaceId, initial.focusedWorkspaceId);
    log.management = { manager, linked, ping, blocked: JSON.parse(blocked.stdout), afterClose };
    for (const owner of parents) await invoke(["parent", "unlink", "--parent", owner.id]);
    const beforeRestart = bindings();
    herdr.close();
    await qa.restartHerdr();
    herdr = createHerdrClient(qa.herdrSocket);
    const restored = await herdr.snapshot();
    grouped(restored, parents, children);
    assert.deepEqual(restored.workspaces, afterClose.workspaces);
    assert.equal(restored.focusedWorkspaceId, initial.focusedWorkspaceId);
    const runtimeEntry = pathToFileURL(Bun.resolveSync("@code-yeongyu/senpi", qa.controlRoot)).href;
    const managedPath = process.env["PATH"];
    assert.ok(managedPath);
    for (const binding of [...parents, ...children]) {
      assert.ok(binding.paneId && binding.sessionPath);
      const ready = changed(join(qa.controlRoot, ".omo/state/ready", `${binding.id}.json`));
      try {
        await herdr.run(
          binding.paneId,
          [
            "env",
            "-u",
            "OMO_INITIATIVE_HOST",
            "OMO_ENABLE_SHARED_HOST=1",
            `OMO_RPC_SOCKET=${binding.omoSocket}`,
            `OMO_INITIATIVE_ROOT=${qa.controlRoot}`,
            join(qa.controlRoot, "node_modules/.bin/omo"),
            "-e",
            join(qa.controlRoot, "dist/extension/index.js"),
            "--session",
            binding.sessionPath,
            "--name",
            `omo-${binding.assignment.role}-${binding.id}`,
            "--model",
            `${modelForRole(binding.assignment.role).provider}/${modelForRole(binding.assignment.role).modelId}`,
            "--thinking",
            modelForRole(binding.assignment.role).thinking,
            "--no-model-fallback",
            "--no-recommended-models",
          ],
          { PATH: managedPath, ...runtimeCacheEnvironment(qa.controlRoot, runtimeEntry) },
        );
        await ready.promise;
      } finally {
        ready.close();
      }
    }
    for (const owner of parents) {
      assert.equal(owner.assignment.role, "parent");
      await invoke(["reconcile", "--project", owner.assignment.projectId]);
    }
    const afterRestart = bindings();
    for (const binding of [...parents, ...children]) {
      const before = beforeRestart.find((entry) => entry.id === binding.id);
      const after = afterRestart.find((entry) => entry.id === binding.id);
      assert.ok(before && after);
      assert.equal(after.durableSessionId, before.durableSessionId);
      assert.equal(after.sessionPath, before.sessionPath);
      assert.deepEqual(after.checkout, before.checkout);
      assert.equal(after.launchState, "ready");
      const client = await attach(after);
      clients.push(client);
      const state = await client.getState();
      assert.equal(state.model?.id, "claude-opus-5-5");
      assert.equal(state.thinkingLevel, "xhigh");
    }
    assert.equal(await readFile(artifact, "utf8"), "STANDALONE\n");
    const finalRuns = z
      .object({ runs: z.array(z.object({ runId: z.string() })) })
      .parse(success.parse(await childRpc.requestExtension("omo.dag.list", { limit: 100 })).value);
    assert.deepEqual(
      finalRuns.runs.map((entry) => entry.runId),
      [run.runId],
    );
    assert.equal(
      z
        .object({ goal: z.object({ status: z.string() }) })
        .parse(JSON.parse(await readFile(goalPath, "utf8"))).goal.status,
      "complete",
    );
    const finalInbox = z
      .array(deliveryRecordSchema)
      .parse(await invoke(["reports", "--project", "qa-project-a"]));
    for (const record of userRecords)
      assert.deepEqual(
        finalInbox.find((entry) => entry.envelope.id === record.envelope.id),
        record,
      );
    const final = await herdr.snapshot();
    grouped(final, parents, children);
    assert.equal(final.focusedWorkspaceId, initial.focusedWorkspaceId);
    assert.equal(final.workspaces.length, 5);
    log.restart = { beforeRestart, afterRestart, restored, final };
    log.captures.push(await captureTui(qa, join(evidence, "restored.ansi"), "child-B"));
    log.result = "pass";
  } catch (error) {
    failure = error;
    log.error = String(error);
    log.result = "failed";
  } finally {
    for (const client of clients) await client.stop();
    herdr.close();
    try {
      await qa.close();
      log.cleanup = "owned roles, host, server, workspaces and worktrees removed";
    } catch (error) {
      failure ??= error;
      log.cleanupError = String(error);
      log.result = "failed";
    }
    await writeFile(join(evidence, "result.json"), `${JSON.stringify(log, null, 2)}\n`);
  }
  if (failure) throw failure;
  console.log(
    "PASS: standalone parents, child workflow/report, optional management, explicit groups and actual Herdr restart",
  );
}

await main();
