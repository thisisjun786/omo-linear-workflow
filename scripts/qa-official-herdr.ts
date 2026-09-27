import assert from "node:assert/strict";
import { existsSync, watch } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { RpcClient } from "@code-yeongyu/senpi";
import { z } from "zod";
import type { Binding } from "../src/core/contracts";
import { bindingSchema, deliveryRecordSchema, runtimeIdentitySchema } from "../src/core/schema";
import { openRegistry } from "../src/core/store";
import { resolveHerdrArtifact } from "../src/herdr/artifact";
import { createHerdrClient } from "../src/herdr/client";
import { planPaneExited } from "../src/orchestrator";
import { autoHostHandoffQa } from "./qa-auto-host-handoff";
import { attach, idle } from "./qa-hierarchy";
import { managerBusyNoticeQa, managerEntryQa } from "./qa-manager-entry";
import { checkedQaCommand, prepareQaWorld } from "./qa-world";

export async function runOfficialHerdrQa(
  evidenceName = "lina-275-official-qa.json",
  entry = false,
  autoHandoff = false,
  roleReport = false,
): Promise<void> {
  const root = resolve(import.meta.dir, "..");
  const scratch = await mkdtemp(join(tmpdir(), "olw-official-"));
  const home = join(scratch, "home");
  const agent = join(home, ".omo/agent");
  const envBefore = { ...process.env };
  const clients: RpcClient[] = [];
  const assertions: Record<string, boolean> = {};
  const evidence: Record<string, unknown> = {
    scratch,
    assertions,
    inference: "offline deterministic provider; real TUI, host, OLW and Herdr",
  };
  let world: Awaited<ReturnType<typeof prepareQaWorld>> | undefined;
  let herdr: ReturnType<typeof createHerdrClient> | undefined;
  let failure: unknown;
  const check = (name: string, value: unknown) => {
    assertions[name] = Boolean(value);
    assert.ok(value, name);
  };
  try {
    for (const key of Object.keys(process.env)) {
      if (/^(PI_|HERDR_|OMO_|SENPI_|OLW_)/.test(key)) delete process.env[key];
    }
    await mkdir(join(agent, "extensions"), { recursive: true });
    await mkdir(join(home, ".config/herdr"), { recursive: true });
    await mkdir(join(scratch, "bin"));
    await mkdir(join(scratch, "gate"));
    await writeFile(join(home, ".zshrc"), "# isolated QA\n");
    await writeFile(
      join(home, ".config/herdr/config.toml"),
      "[update]\nversion_check = false\nmanifest_check = false\n",
    );
    await writeFile(
      join(agent, "extensions/offline.ts"),
      `import offline from ${JSON.stringify(join(root, "scripts/qa-official-provider.ts"))};\nexport default (pi) => offline(pi, ${JSON.stringify(join(scratch, "gate"))});\n`,
    );
    const ids = ["anthropic/claude-opus-5-5", "anthropic/claude-fable-5-1", "gpt-6-astra"];
    await writeFile(
      join(agent, "models.json"),
      JSON.stringify({
        providers: {
          opencodex: {
            baseUrl: "http://offline.invalid",
            api: "openai-completions",
            apiKey: "qa-offline-not-a-secret",
            models: ids.map((id) => ({
              id,
              name: id,
              reasoning: true,
              input: ["text"],
              contextWindow: 1_000_000,
              maxTokens: 32000,
            })),
          },
        },
      }),
    );
    await writeFile(
      join(agent, "settings.json"),
      JSON.stringify({
        defaultProvider: "opencodex",
        defaultModel: ids[0],
        defaultThinkingLevel: "medium",
        permissionPreset: "full-access",
        quietStartup: true,
      }),
    );
    await writeFile(join(home, ".omo/omo.jsonc"), '{"categories":{},"agents":{}}');
    const upstream = join(scratch, "bin/omo");
    await symlink(join(root, "node_modules/omo-ai/bin/omo.js"), upstream);
    await writeFile(
      join(scratch, "bin/npm"),
      '#!/bin/sh\ncase "$*" in *senpi*) echo \'{"latest":"2026.9.27"}\';; *omo-ai*) echo \'{"latest":"5.0.1"}\';; *) exit 2;; esac\n',
      { mode: 0o700 },
    );
    Object.assign(process.env, {
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local/share"),
      XDG_STATE_HOME: join(home, ".local/state"),
      XDG_CACHE_HOME: join(home, ".cache"),
      OMO_CODING_AGENT_DIR: agent,
      SENPI_CODING_AGENT_DIR: agent,
      PI_OFFLINE: "1",
      QA_OFFICIAL_GATE: join(scratch, "gate"),
      HERDR_ENV: "1",
      PATH: `${join(scratch, "bin")}:${envBefore["PATH"]}`,
      GIT_AUTHOR_NAME: "QA",
      GIT_AUTHOR_EMAIL: "qa@localhost",
      GIT_COMMITTER_NAME: "QA",
      GIT_COMMITTER_EMAIL: "qa@localhost",
    });
    await checkedQaCommand([process.execPath, "run", "build"], root);
    await checkedQaCommand(
      [process.execPath, "dist/proxy/routing.js", "sync", "--adopt", "--upstream", upstream],
      root,
    );
    world = await prepareQaWorld();
    herdr = createHerdrClient(world.herdrSocket);
    evidence["world"] = world.scratch;
    evidence["artifact"] = (await resolveHerdrArtifact(world.controlRoot)).asset;
    await writeFile(join(agent, "trust.json"), JSON.stringify({ [world.scratch]: true }));
    const success = z.object({ ok: z.literal(true), value: z.unknown() });
    const invoke = async (args: string[]) => {
      assert.ok(world);
      console.log("OFFICIAL_QA", args.join(" "));
      const reply = await world.cli(args);
      assert.equal(reply.code, 0, `${JSON.stringify(args)}\n${reply.stdout}\n${reply.stderr}`);
      return success.parse(JSON.parse(reply.stdout)).value;
    };
    const connected = async (binding: Binding) => {
      const client = await attach(binding);
      clients.push(client);
      await idle(client);
      return client;
    };
    const handoffResult = autoHandoff ? await autoHostHandoffQa(world, herdr) : undefined;
    if (handoffResult) evidence["autoHostHandoff"] = handoffResult;
    const entryResult = entry ? await managerEntryQa(world, herdr) : undefined;
    if (entryResult) evidence["managerEntry"] = entryResult.evidence;
    if (autoHandoff) {
      evidence["result"] = "PASS";
      return;
    }
    const manager =
      entryResult?.manager ??
      z.object({ binding: bindingSchema }).parse(await invoke(["manage"])).binding;
    const managerClient = await connected(manager);
    let reattached = { binding: manager };
    if (!entry && !roleReport) {
      const initialManagerIdentity = {
        durableSessionId: manager.durableSessionId,
        sessionPath: manager.sessionPath,
      };
      const initialSnapshot = await herdr.snapshot();
      check(
        "builtinAgentDetection",
        initialSnapshot.panes.some(
          (pane) => pane.paneId === manager.paneId && (pane.agent === "pi" || pane.agent === "omo"),
        ),
      );
      const again = z
        .object({ action: z.string(), binding: bindingSchema })
        .parse(await invoke(["manage"]));
      check(
        "managerFocusWithoutDuplicate",
        again.action === "focused" && again.binding.paneId === manager.paneId,
      );
      assert.ok(manager.paneId);
      const exited = Promise.withResolvers<void>();
      const stop = await herdr.subscribe((event) => {
        if (planPaneExited(event, manager.paneId ?? "")) exited.resolve();
      });
      const deadline = setTimeout(() => exited.reject(new Error("manager exit timeout")), 30000);
      try {
        await herdr.sendKeys(manager.paneId, "/quit", ["Enter"]);
        await exited.promise;
      } finally {
        stop();
        clearTimeout(deadline);
      }
      check(
        "managerExitFrameReleasedTui",
        !(await herdr.snapshot()).panes.some(
          (pane) =>
            pane.paneId === manager.paneId &&
            (pane.agent === "pi" || pane.agent === "omo") &&
            pane.sessionPath !== null,
        ),
      );
      const reopened = z
        .object({ action: z.string(), binding: bindingSchema })
        .parse(await invoke(["manage"]));
      reattached = reopened;
      const reattachedSnapshot = await herdr.snapshot();
      check(
        "managerReattachSameBindingAndSession",
        reopened.action === "reattached" &&
          reattached.binding.id === manager.id &&
          reattached.binding.paneId !== manager.paneId &&
          reattached.binding.durableSessionId === initialManagerIdentity.durableSessionId &&
          reattached.binding.sessionPath === initialManagerIdentity.sessionPath,
      );
      check(
        "managerReattachExactlyOneWorkspace",
        reattachedSnapshot.workspaces.filter((workspace) => workspace.label === "manager")
          .length === 1,
      );
      check(
        "managerReattachTuiLive",
        reattachedSnapshot.panes.some(
          (pane) =>
            pane.paneId === reattached.binding.paneId &&
            pane.workspaceId === reattached.binding.workspaceId &&
            (roleReport || pane.agent === "pi" || pane.agent === "omo"),
        ),
      );
      const native = runtimeIdentitySchema.parse(
        success.parse(await managerClient.requestExtension("omo.initiative.describe")).value,
      );
      check(
        "managerReattachNativeSession",
        native.durableSessionId === initialManagerIdentity.durableSessionId &&
          native.sessionPath === initialManagerIdentity.sessionPath,
      );
      evidence["managerReattach"] = {
        initial: manager,
        reattached: reattached.binding,
        initialSnapshot,
        reattachedSnapshot,
        nativeIdentity: native,
      };
    }
    if (roleReport) {
      const gate = join(scratch, "gate");
      await rm(join(gate, "entered"), { force: true });
      await rm(join(gate, "release"), { force: true });
      const turnEntered = Promise.withResolvers<void>();
      const inspectGate = () => {
        if (existsSync(join(gate, "entered"))) turnEntered.resolve();
      };
      const gateWatcher = watch(gate, inspectGate);
      const turnStarted = Promise.withResolvers<void>();
      const turnSettled = Promise.withResolvers<void>();
      const stopEvents = managerClient.onEvent((event) => {
        if (event.type === "agent_start") turnStarted.resolve();
        if (event.type === "agent_settled") turnSettled.resolve();
      });
      const deadline = setTimeout(() => {
        const error = new Error("Manager reattach state deadline");
        turnEntered.reject(error);
        turnStarted.reject(error);
        turnSettled.reject(error);
      }, 60000);
      const activeHerdr = herdr;
      const activeWorld = world;
      assert.ok(activeHerdr);
      assert.ok(activeWorld);
      assert.ok(manager.workspaceId);
      await activeHerdr.createTab(manager.workspaceId, manager.cwd, "reattach-anchor");
      const reattach = async (current: Binding, expectedState: "working" | "blocked") => {
        assert.ok(current.paneId);
        const start = activeWorld.herdrTraffic.length;
        let moved: Binding | undefined;
        const reported = Promise.withResolvers<void>();
        const inspect = () => {
          if (moved?.paneId === null || moved?.paneId === undefined) return;
          const requests = activeWorld.herdrTraffic.slice(start);
          if (
            reportsFor(requests, moved.paneId, "pane.report_agent_session").length === 1 &&
            reportsFor(requests, moved.paneId, "pane.report_agent").some(
              (request) => request.params["state"] === expectedState,
            )
          )
            reported.resolve();
        };
        const stopTraffic = activeWorld.onHerdrRequest(inspect);
        const reportDeadline = setTimeout(
          () => reported.reject(new Error(`Manager ${expectedState} report deadline`)),
          30000,
        );
        try {
          await checkedQaCommand(
            ["herdr", "pane", "close", current.paneId],
            activeWorld.repository,
            activeWorld.environment,
          );
          moved = z
            .object({ action: z.literal("reattached"), binding: bindingSchema })
            .parse(await invoke(["manage"])).binding;
          inspect();
          await reported.promise;
          return { binding: moved, raw: activeWorld.herdrTraffic.slice(start) };
        } finally {
          stopTraffic();
          clearTimeout(reportDeadline);
        }
      };
      const reportsFor = (requests: readonly unknown[], paneId: string, method: string) =>
        requests.filter(
          (request): request is { method: string; params: Record<string, unknown> } =>
            typeof request === "object" &&
            request !== null &&
            "method" in request &&
            request.method === method &&
            "params" in request &&
            typeof request.params === "object" &&
            request.params !== null &&
            "pane_id" in request.params &&
            request.params.pane_id === paneId,
        );
      const turn = managerClient.prompt("OLW_ENTRY_BUSY_GATE");
      try {
        inspectGate();
        await Promise.all([turnEntered.promise, turnStarted.promise]);
        assert.ok(manager.paneId);
        await checkedQaCommand(
          ["herdr", "agent", "wait", manager.paneId, "--until", "working", "--timeout", "30000"],
          world.repository,
          world.environment,
        );
        const workingMove = await reattach(manager, "working");
        const workingBinding = workingMove.binding;
        assert.ok(workingBinding.paneId);
        const workingRaw = workingMove.raw;
        check(
          "managerReattachDuringTurnSingleRpcOwner",
          reportsFor(workingRaw, workingBinding.paneId, "pane.report_agent_session").length === 1,
        );
        check(
          "managerReattachDuringTurnWorking",
          reportsFor(workingRaw, workingBinding.paneId, "pane.report_agent").some(
            (request) => request.params["state"] === "working",
          ),
        );

        const blockedBeforeMove = Promise.withResolvers<void>();
        const stopBlocked = activeWorld.onHerdrRequest((request) => {
          if (
            reportsFor([request], workingBinding.paneId ?? "", "pane.report_agent").some(
              (report) => report.params["state"] === "blocked",
            )
          )
            blockedBeforeMove.resolve();
        });
        const blockedDeadline = setTimeout(
          () => blockedBeforeMove.reject(new Error("Manager blocked report deadline")),
          30000,
        );
        try {
          z.object({ active: z.literal(true) }).parse(
            await managerClient.requestExtension("oi.qa.olw-question-wait", true),
          );
          await blockedBeforeMove.promise;
        } finally {
          stopBlocked();
          clearTimeout(blockedDeadline);
        }
        const blockedMove = await reattach(workingBinding, "blocked");
        const blockedBinding = blockedMove.binding;
        reattached = { binding: blockedBinding };
        assert.ok(blockedBinding.paneId);
        const blockedRaw = blockedMove.raw;
        check(
          "managerReattachDuringQuestionSingleRpcOwner",
          reportsFor(blockedRaw, blockedBinding.paneId, "pane.report_agent_session").length === 1,
        );
        check(
          "managerReattachDuringQuestionBlocked",
          reportsFor(blockedRaw, blockedBinding.paneId, "pane.report_agent").some(
            (request) => request.params["state"] === "blocked",
          ),
        );

        z.object({ active: z.literal(false) }).parse(
          await managerClient.requestExtension("oi.qa.olw-question-wait", false),
        );
        await writeFile(join(gate, "release"), "release");
        await turn;
        await turnSettled.promise;
        await idle(managerClient);
        await checkedQaCommand(
          [
            "herdr",
            "agent",
            "wait",
            blockedBinding.paneId,
            "--until",
            "idle",
            "--until",
            "done",
            "--timeout",
            "30000",
          ],
          world.repository,
          world.environment,
        );
        const idleRaw = activeWorld.herdrTraffic.slice(
          activeWorld.herdrTraffic.indexOf(blockedRaw[0]),
        );
        check(
          "managerReattachAfterTurnIdle",
          reportsFor(idleRaw, blockedBinding.paneId, "pane.report_agent").some(
            (request) => request.params["state"] === "idle",
          ),
        );
        evidence["managerReattachRoleReportRaw"] = {
          duringTurn: workingRaw,
          duringQuestion: blockedRaw,
          afterTurn: idleRaw,
        };
      } finally {
        gateWatcher.close();
        stopEvents();
        clearTimeout(deadline);
        if (!existsSync(join(gate, "release"))) await writeFile(join(gate, "release"), "release");
        await turn;
      }
    }
    await idle(managerClient);
    const remote = join(world.scratch, "remote.git");
    await checkedQaCommand(
      ["git", "clone", "--bare", world.repository, remote],
      world.scratch,
      world.environment,
    );
    const parents: Binding[] = [];
    for (const id of ["A", "B"]) {
      const scope = join(world.scratch, `scope-${id}.json`);
      await writeFile(
        scope,
        JSON.stringify({
          version: 1,
          source: "fixture",
          initiative: null,
          projects: [
            {
              project: { id, key: `P-${id}`, url: `linear://${id}`, revision: "1" },
              issues: [
                { id: `${id}-issue`, key: `${id}-1`, url: `linear://${id}-issue`, revision: "1" },
              ],
              repository: { remote: pathToFileURL(remote).href, defaultBranch: "main" },
            },
          ],
          decisionRefs: [],
        }),
      );
      const { digest } = z
        .object({ digest: z.string() })
        .parse(await invoke(["scope", "import", "--file", scope, "--fixture"]));
      const parent = z
        .object({ binding: bindingSchema })
        .parse(
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
          ]),
        ).binding;
      parents.push(parent);
      await connected(parent);
    }
    let plainPane: string | undefined;
    if (roleReport) {
      const plain = await herdr.createWorkspace(world.repository, "plain-omo");
      world.workspaces.push(plain.workspaceId);
      plainPane = plain.rootPaneId;
      const plainReported = Promise.withResolvers<void>();
      const stopTraffic = world.onHerdrRequest((value) => {
        if (
          typeof value === "object" &&
          value !== null &&
          "method" in value &&
          value.method === "pane.report_agent_session" &&
          "params" in value &&
          typeof value.params === "object" &&
          value.params !== null &&
          "pane_id" in value.params &&
          value.params.pane_id === plain.rootPaneId
        )
          plainReported.resolve();
      });
      const deadline = setTimeout(
        () => plainReported.reject(new Error("Plain OMO reporter deadline")),
        30000,
      );
      try {
        await herdr.run(
          plain.rootPaneId,
          [join(world.controlRoot, "node_modules/.bin/omo"), "--name", "plain-omo"],
          {
            PATH: process.env["PATH"] ?? "",
            HERDR_ENV: "1",
            HERDR_PANE_ID: plain.rootPaneId,
            HERDR_SOCKET_PATH: world.herdrSocket,
          },
        );
        await plainReported.promise;
      } finally {
        stopTraffic();
        clearTimeout(deadline);
      }
    }
    const parent = parents[0];
    assert.ok(parent);
    if (roleReport) {
      assert.ok(parent.paneId);
      const gate = join(scratch, "gate");
      await rm(join(gate, "entered"), { force: true });
      await rm(join(gate, "release"), { force: true });
      const entered = Promise.withResolvers<void>();
      const inspectGate = () => {
        if (existsSync(join(gate, "entered"))) entered.resolve();
      };
      const watcher = watch(gate, inspectGate);
      const started = Promise.withResolvers<void>();
      const settled = Promise.withResolvers<void>();
      const parentClient = clients[1];
      assert.ok(parentClient);
      const stopEvents = parentClient.onEvent((event) => {
        if (event.type === "agent_start") started.resolve();
        if (event.type === "agent_settled") settled.resolve();
      });
      const deadline = setTimeout(() => {
        const error = new Error("Role-report provider hold deadline");
        entered.reject(error);
        started.reject(error);
      }, 30000);
      const reportedWorking = checkedQaCommand(
        ["herdr", "agent", "wait", parent.paneId, "--until", "working", "--timeout", "30000"],
        world.repository,
        world.environment,
      );
      const turn = parentClient.prompt("OLW_ENTRY_BUSY_GATE");
      try {
        inspectGate();
        await Promise.all([entered.promise, started.promise, reportedWorking]);
        const working = await checkedQaCommand(
          ["herdr", "agent", "explain", parent.paneId, "--json"],
          world.repository,
          world.environment,
        );
        const workingAgent = await checkedQaCommand(
          ["herdr", "agent", "get", parent.paneId],
          world.repository,
          world.environment,
        );
        evidence["roleReportWorkingRaw"] = { explain: working, agent: workingAgent };
        const workingExplain = JSON.parse(working) as unknown;
        check(
          "roleReportWorking",
          workingAgent.includes('"agent_status":"working"') &&
            JSON.stringify(workingExplain).includes("default_known_agent_idle_fallback") &&
            JSON.stringify(workingExplain).includes('"state":"idle"'),
        );
        await writeFile(join(gate, "release"), "release");
        await turn;
        await settled.promise;
        await idle(parentClient);
        await checkedQaCommand(
          [
            "herdr",
            "agent",
            "wait",
            parent.paneId,
            "--until",
            "idle",
            "--until",
            "done",
            "--timeout",
            "30000",
          ],
          world.repository,
          world.environment,
        );
        const idleReport = await checkedQaCommand(
          ["herdr", "agent", "get", parent.paneId],
          world.repository,
          world.environment,
        );
        evidence["roleReportIdleRaw"] = idleReport;
        check(
          "roleReportIdle",
          idleReport.includes('"agent_status":"done"') ||
            idleReport.includes('"agent_status":"idle"'),
        );
        evidence["roleReport"] = { paneId: parent.paneId, working, idle: idleReport };
      } finally {
        watcher.close();
        stopEvents();
        clearTimeout(deadline);
        if (!existsSync(join(gate, "release"))) await writeFile(join(gate, "release"), "release");
        await turn;
      }
    }
    if (entry && !roleReport)
      evidence["busyNotice"] = await managerBusyNoticeQa(world, manager, parent, managerClient);
    const plan = z
      .object({ binding: bindingSchema })
      .parse(
        await invoke([
          "child",
          "create",
          "--parent",
          parent.id,
          "--issue",
          "A-issue",
          "--mode",
          "planned",
          "--deliverable",
          "report",
        ]),
      ).binding;
    const planClient = await connected(plan);
    const body = join(world.scratch, "question.txt");
    await writeFile(body, "QA format decision");
    const asked = z
      .object({ ok: z.literal(true), id: z.string(), state: z.literal("accepted") })
      .parse(
        await planClient.requestExtension("oi.qa.olw-ask", {
          questions: [
            {
              id: "format",
              question: "QA format decision",
              options: [{ label: "text" }],
              multiSelect: false,
            },
          ],
        }),
      );
    if (roleReport) {
      assert.ok(plan.paneId);
      await idle(planClient);
      const blocked = await checkedQaCommand(
        ["herdr", "agent", "get", plan.paneId],
        world.repository,
        world.environment,
      );
      check("roleReportQuestionBlocked", blocked.includes('"agent_status":"blocked"'));
      evidence["roleReportQuestion"] = { paneId: plan.paneId, blocked };
    }
    const registryForQuestion = openRegistry(
      join(world.controlRoot, ".omo/state/registry.sqlite"),
      {
        readonly: true,
      },
    );
    const q = (() => {
      try {
        const record = registryForQuestion.delivery(asked.id);
        assert.ok(record.ok);
        return deliveryRecordSchema.parse(record.value);
      } finally {
        registryForQuestion.close();
      }
    })();
    const escalation = join(world.scratch, "escalation.json");
    await writeFile(escalation, JSON.stringify({ questions: [], escalates: q.envelope.id }));
    const pq = deliveryRecordSchema.parse(
      await invoke([
        "ask",
        "--from",
        parent.id,
        "--id",
        "qa-escalated-question",
        "--text-file",
        body,
        "--questions-file",
        escalation,
      ]),
    );
    check(
      "questionEscalation",
      pq.envelope.toBindingId === manager.id && pq.envelope.question?.escalates === q.envelope.id,
    );
    await invoke([
      "answer",
      "--from",
      manager.id,
      "--question",
      pq.envelope.id,
      "--text-file",
      body,
    ]);
    await invoke(["answer", "--from", parent.id, "--question", q.envelope.id, "--text-file", body]);
    await idle(planClient);
    if (roleReport) {
      assert.ok(plan.paneId);
      await checkedQaCommand(
        [
          "herdr",
          "agent",
          "wait",
          plan.paneId,
          "--until",
          "idle",
          "--until",
          "done",
          "--until",
          "working",
          "--timeout",
          "30000",
        ],
        world.repository,
        world.environment,
      );
      const unblocked = await checkedQaCommand(
        ["herdr", "agent", "get", plan.paneId],
        world.repository,
        world.environment,
      );
      check("roleReportQuestionCleared", !unblocked.includes('"agent_status":"blocked"'));
      evidence["roleReportQuestion"] = {
        ...(evidence["roleReportQuestion"] as object),
        unblocked,
      };
    }
    const registry = openRegistry(join(world.controlRoot, ".omo/state/registry.sqlite"), {
      readonly: true,
    });
    try {
      const questions = registry.questions({});
      assert.ok(questions.ok);
      evidence["questions"] = questions.value;
      for (const id of [q.envelope.id, pq.envelope.id]) {
        const answer = registry.delivery(`answer:${id}`);
        check(`acceptedAnswer:${id}`, answer.ok && answer.value.state === "accepted");
      }
    } finally {
      registry.close();
    }
    check(
      "nativeAnswerWokeChild",
      (await planClient.getMessages()).some(
        (message) =>
          message.role === "user" && JSON.stringify(message).includes(`answer:${q.envelope.id}`),
      ),
    );
    const planPath = join(plan.cwd, ".omo/plans/A-1.md");
    await mkdir(join(plan.cwd, ".omo/plans"), { recursive: true });
    await writeFile(planPath, "QA approved plan\n");
    const head = (
      await checkedQaCommand(["git", "rev-parse", "HEAD"], plan.cwd, world.environment)
    ).trim();
    await invoke([
      "stage",
      "complete",
      "--from",
      plan.id,
      "--plan",
      planPath,
      "--head",
      head,
      "--id",
      "qa-handoff",
      "--text-file",
      planPath,
    ]);
    await planClient.closeSession();
    await planClient.stop();
    clients.splice(clients.indexOf(planClient), 1);
    if (roleReport) {
      const sessionReports = world.herdrTraffic.filter(
        (value): value is { method: string; params: { pane_id?: string } } =>
          typeof value === "object" &&
          value !== null &&
          "method" in value &&
          value.method === "pane.report_agent_session" &&
          "params" in value &&
          typeof value.params === "object" &&
          value.params !== null,
      );
      evidence["roleOwnershipRaw"] = {
        sessionReports: world.herdrTraffic,
        manager,
        parents,
        plainPane,
      };
      const rolePanes = parents
        .map((binding) => binding.paneId)
        .filter((pane): pane is string => pane !== null);
      for (const pane of new Set(rolePanes)) {
        const count = sessionReports.filter((request) => request.params.pane_id === pane).length;
        evidence[`singleOwnerCount:${pane}`] = count;
        check(`singleOwner:${pane}`, count === 1);
      }
      assert.ok(plainPane);
      check(
        "plainBuiltinOwner",
        sessionReports.filter((request) => request.params.pane_id === plainPane).length === 1,
      );
      const loaded = (await Bun.file(join(scratch, "gate/loaded-extensions.jsonl")).text())
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) =>
          z
            .object({ sessionId: z.string(), mode: z.string(), paths: z.array(z.string()) })
            .parse(JSON.parse(line)),
        );
      const marker = join(world.controlRoot, "dist/extension/herdr-olw-owner.js");
      for (const binding of [manager, ...parents])
        check(
          `markerLoaded:${binding.id}`,
          loaded.some(
            (receipt) =>
              receipt.sessionId === binding.durableSessionId && receipt.paths.includes(marker),
          ),
        );
      const plainReceipt = loaded.find(
        (receipt) => receipt.mode === "tui" && !receipt.paths.includes(marker),
      );
      check("plainMarkerAbsent", plainReceipt !== undefined);
      evidence["roleOwnership"] = { sessionReports, loaded, marker, plainPane };
    }
    if (roleReport) {
      const cleanupClient = new RpcClient({
        socketPath: join(world.controlRoot, ".omo/state/omo.sock"),
      });
      await cleanupClient.start();
      try {
        for (const session of await cleanupClient.listSessions())
          await cleanupClient.closeSession(session.sessionId);
      } finally {
        await cleanupClient.stop();
      }
      evidence["result"] = "PASS";
      return;
    }
    const execute = z
      .object({ binding: bindingSchema })
      .parse(
        await invoke([
          "stage",
          "start",
          "--from",
          plan.id,
          "--parent",
          parent.id,
          "--stage",
          "execute",
          "--id",
          "qa-execute",
        ]),
      ).binding;
    await connected(execute);
    check(
      "twoStage",
      execute.cwd === plan.cwd &&
        execute.workspaceId === plan.workspaceId &&
        execute.paneId !== plan.paneId &&
        execute.id !== plan.id,
    );
    const secondParent = parents[1];
    assert.ok(secondParent);
    const secondChild = z
      .object({ binding: bindingSchema })
      .parse(
        await invoke([
          "child",
          "create",
          "--parent",
          secondParent.id,
          "--issue",
          "B-issue",
          "--deliverable",
          "report",
        ]),
      ).binding;
    await connected(secondChild);
    const snapshot = await herdr.snapshot();
    evidence["snapshot"] = snapshot;
    const keys = parents.map(
      (p) => snapshot.workspaces.find((w) => w.workspaceId === p.workspaceId)?.repoKey,
    );
    check(
      "perParentGroups",
      keys.every(Boolean) &&
        new Set(keys).size === 2 &&
        snapshot.workspaces.find((w) => w.workspaceId === execute.workspaceId)?.repoKey ===
          keys[0] &&
        snapshot.workspaces.find((w) => w.workspaceId === secondChild.workspaceId)?.repoKey ===
          keys[1],
    );
    await invoke(["doctor"]);
    assert.ok(reattached.binding.workspaceId);
    await herdr.closeWorkspace(reattached.binding.workspaceId);
    const missingWorkspace = await world.cli(["manage"]);
    const missingWorkspaceResult = z
      .object({
        ok: z.literal(false),
        error: z.object({ code: z.literal("manager_unavailable"), message: z.string() }),
      })
      .parse(JSON.parse(missingWorkspace.stdout));
    check(
      "managerMissingWorkspaceTypedOutcome",
      missingWorkspace.code === 2 &&
        missingWorkspaceResult.error.message.includes("workspace is gone or changed") &&
        missingWorkspaceResult.error.message.includes(
          `run olw close --binding ${manager.id} first`,
        ),
    );
    evidence["managerMissingWorkspace"] = {
      exitCode: missingWorkspace.code,
      result: missingWorkspaceResult,
      planContract:
        "todo 11 exact-pane fallback: report the exact binding to close when relaunch is impossible",
    };
    evidence["result"] = "PASS";
  } catch (error) {
    failure = error;
    evidence["error"] = error instanceof Error ? error.stack : String(error);
  } finally {
    for (const client of clients) {
      try {
        await client.closeSession();
        await client.stop();
      } catch (error) {
        failure ??= error;
      }
    }
    herdr?.close();
    if (world) {
      try {
        await world.close();
        evidence["cleanup"] = world.cleanup;
      } catch (error) {
        failure ??= error;
        evidence["cleanupError"] = String(error);
      }
    }
    await rm(scratch, { recursive: true, force: true });
    evidence["scratchRemoved"] = !existsSync(scratch);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, envBefore);
    if (failure) evidence["result"] = "FAIL";
    await mkdir(join(root, ".omo/evidence/two-stage"), { recursive: true });
    await writeFile(
      join(root, ".omo/evidence/two-stage", evidenceName),
      JSON.stringify(evidence, null, 2),
    );
  }
  if (failure) throw failure;
  console.log("OFFICIAL_HERDR_QA_PASS");
}
if (import.meta.main) {
  const autoHandoff = process.argv.includes("--auto-handoff");
  await runOfficialHerdrQa(
    autoHandoff
      ? "qa-auto-host-handoff.json"
      : process.argv.includes("--entry")
        ? "qa-manager-entry.json"
        : "lina-275-official-qa.json",
    process.argv.includes("--entry"),
    autoHandoff,
    process.argv.includes("--role-report"),
  );
}
