import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RpcClient } from "@code-yeongyu/senpi";
import { z } from "zod";
import type { Binding } from "../src/core/contracts";
import { bindingSchema } from "../src/core/schema";
import { createHerdrClient } from "../src/herdr";
import { QaError } from "./qa-rpc";
import { checkedQaCommand, prepareQaWorld } from "./qa-world";

const successSchema = z.object({ ok: z.literal(true), value: z.unknown() });
const createdSchema = z.object({
  binding: bindingSchema.refine(
    (binding) => binding.launchState === "ready" && binding.initialization.state === "accepted",
  ),
  readiness: z.literal("ready"),
  execution: z.literal("brief_accepted"),
});

async function attach(binding: Binding): Promise<RpcClient> {
  if (!binding.sessionPath) throw new QaError("No role session path");
  const client = new RpcClient({ socketPath: binding.omoSocket });
  await client.start();
  try {
    const opened = await client.openSession({ sessionPath: binding.sessionPath });
    if (opened.attached !== true) {
      if (opened.attached === false) await client.closeSession(opened.sessionId);
      throw new QaError("QA accidentally created a new session");
    }
    return client;
  } catch (cause) {
    await client.stop();
    throw cause;
  }
}

async function idle(client: RpcClient): Promise<void> {
  const settled = Promise.withResolvers<void>();
  const timer = setTimeout(() => settled.reject(new QaError("Role did not settle")), 120000);
  const stop = client.onEvent((event) => {
    if (event.type === "agent_end") settled.resolve();
  });
  try {
    const state = await client.getState();
    if (!state.isStreaming) settled.resolve();
    await settled.promise;
  } finally {
    clearTimeout(timer);
    stop();
  }
}

export async function runHierarchyQa(withEvents: boolean): Promise<void> {
  const world = await prepareQaWorld();
  const clients: RpcClient[] = [];
  const herdr = createHerdrClient(world.herdrSocket);
  const invoke = async (args: readonly string[]): Promise<unknown> => {
    const result = await world.cli(args);
    if (result.code !== 0) {
      throw new QaError(
        `CLI ${args.join(" ")} exited ${result.code}: ${result.stdout} ${result.stderr}`,
      );
    }
    return successSchema.parse(JSON.parse(result.stdout)).value;
  };
  try {
    const anchor = await herdr.createWorkspace(world.repository, "QA focus anchor");
    world.workspaces.push(anchor.workspaceId);
    const initial = await herdr.snapshot();
    const fixturePath = join(world.scratch, "scope.json");
    await writeFile(
      fixturePath,
      await readFile(join(world.installRoot, "tests/fixtures/scope.json"), "utf8"),
    );
    const imported = z
      .object({ digest: z.string() })
      .parse(await invoke(["scope", "import", "--file", fixturePath, "--fixture"]));
    const supervisor = createdSchema.parse(
      await invoke([
        "supervisor",
        "create",
        "--initiative",
        "initiative-omo-1",
        "--scope-digest",
        imported.digest,
        "--designation",
        "qa-designation",
        "--execute",
        "--fixture",
      ]),
    ).binding;
    const parent = createdSchema.parse(
      await invoke([
        "parent",
        "create",
        "--supervisor",
        supervisor.id,
        "--project",
        "project-omo-1",
        "--repo",
        world.repository,
        "--base",
        "main",
      ]),
    ).binding;
    const child = createdSchema.parse(
      await invoke(["child", "create", "--parent", parent.id, "--issue", "issue-omo-1"]),
    ).binding;
    if (!parent.checkout || !child.checkout) throw new QaError("Missing worktree metadata");
    if (parent.cwd === child.cwd) throw new QaError("Parent and child share a checkout");
    if (child.checkout.baseBranch !== parent.checkout.branch) {
      throw new QaError("Child was not based on parent integration branch");
    }
    const childHead = (
      await checkedQaCommand(["git", "-C", child.cwd, "rev-parse", "HEAD"], world.controlRoot)
    ).trim();
    if (childHead !== child.checkout.baseCommit) throw new QaError("Child ancestry changed");
    const final = await herdr.snapshot();
    if (initial.focusedWorkspaceId !== final.focusedWorkspaceId) {
      throw new QaError("Background role creation stole Herdr focus");
    }
    const bindings = [supervisor, parent, child];
    for (const binding of bindings) {
      const client = await attach(binding);
      clients.push(client);
      const state = await client.getState();
      const expected = {
        supervisor: ["chatgpt-subscription", "gpt-6-astra", "high"],
        parent: ["kimi-coding", "k3", "max"],
        child: ["anthropic-subscription", "claude-opus-5", "xhigh"],
      } as const;
      const tuple = expected[binding.assignment.role];
      if (
        state.model?.provider !== tuple[0] ||
        state.model.id !== tuple[1] ||
        state.thinkingLevel !== tuple[2]
      ) {
        throw new QaError(`Wrong actual model tuple for ${binding.assignment.role}`);
      }
      await idle(client);
      console.log(
        "ROLE_PASS",
        JSON.stringify({
          role: binding.assignment.role,
          workspace: binding.workspaceId,
          cwd: binding.cwd,
          model: tuple.join("/"),
        }),
      );
    }
    const duplicate = await world.cli([
      "child",
      "create",
      "--parent",
      parent.id,
      "--issue",
      "issue-omo-1",
    ]);
    if (duplicate.code === 0) throw new QaError("Duplicate issue owner was created");
    const afterDuplicate = await herdr.snapshot();
    if (afterDuplicate.workspaces.length !== final.workspaces.length) {
      throw new QaError("Duplicate request created an extra workspace");
    }
    console.log(
      "HERDR_QA_PASS: three exact-model roles, separate worktrees, correct ancestry, stable focus",
    );

    if (withEvents) {
      const parentClient = clients[1];
      const supervisorClient = clients[0];
      if (!parentClient || !supervisorClient) throw new QaError("Missing QA receiver client");
      const report = async (sender: Binding, receiver: RpcClient, id: string, sentinel: string) => {
        await idle(receiver);
        const response = Promise.withResolvers<void>();
        const timer = setTimeout(
          () => response.reject(new QaError(`No receiver response for ${id}`)),
          120000,
        );
        const stop = receiver.onEvent((event) => {
          if (event.type !== "message_end" || event.message.role !== "assistant") return;
          const text = event.message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("");
          if (text.includes(sentinel)) response.resolve();
        });
        const textPath = join(world.scratch, `${id}.txt`);
        await writeFile(
          textPath,
          `QA fixture message: reply exactly ${sentinel}. Do not take other actions.`,
        );
        try {
          const receipt = z
            .object({ state: z.literal("accepted") })
            .parse(
              await invoke([
                "report",
                "--from",
                sender.id,
                "--id",
                id,
                "--outcome",
                "completed",
                "--evidence",
                textPath,
                "--text-file",
                textPath,
              ]),
            );
          await response.promise;
          await idle(receiver);
          const replay = await invoke([
            "report",
            "--from",
            sender.id,
            "--id",
            id,
            "--outcome",
            "completed",
            "--evidence",
            textPath,
            "--text-file",
            textPath,
          ]);
          if (JSON.stringify(replay) !== JSON.stringify(receipt)) {
            const replayState = z.object({ state: z.literal("accepted") }).safeParse(replay);
            if (!replayState.success) throw new QaError("Replay did not preserve acceptance");
          }
          const messages = await receiver.getMessages();
          const copies = messages.filter(
            (message) =>
              message.role === "user" &&
              typeof message.content !== "string" &&
              message.content.some(
                (part) => part.type === "text" && part.text.includes(`"id":"${id}"`),
              ),
          );
          if (copies.length !== 1)
            throw new QaError(`Expected one delivery for ${id}, got ${copies.length}`);
          console.log("EVENT_PASS", id, sentinel);
        } finally {
          clearTimeout(timer);
          stop();
        }
      };
      await report(child, parentClient, "qa-child-report", "CHILD_REPORT_RECEIVED");
      await report(parent, supervisorClient, "qa-parent-report", "PARENT_REPORT_RECEIVED");
      console.log(
        "EVENTS_QA_PASS: idle owners woke through native events; duplicate reports did not resend",
      );
    }
    for (const client of clients.splice(0)) {
      await idle(client);
      await client.closeSession();
      await client.stop();
    }
    if (child.workspaceId === null || child.sessionPath === null)
      throw new QaError("Missing child runtime metadata");
    await herdr.closeWorkspace(child.workspaceId);
    const lostRuntime = new RpcClient({ socketPath: child.omoSocket });
    try {
      await lostRuntime.start();
      const remaining = (await lostRuntime.listSessions()).find(
        (session) => session.durableSessionId === child.durableSessionId,
      );
      if (remaining) {
        const opened = await lostRuntime.openSession({
          sessionPath: child.sessionPath,
          cwd: child.cwd,
        });
        if (opened.attached !== true) {
          if (opened.attached === false) await lostRuntime.closeSession(opened.sessionId);
          throw new QaError("Fault injection recreated a runtime");
        }
        await lostRuntime.abort();
        await lostRuntime.closeSession();
      }
      if (
        (await lostRuntime.listSessions()).some(
          (session) => session.durableSessionId === child.durableSessionId,
        )
      ) {
        throw new QaError("Fault injection did not remove the child runtime");
      }
    } finally {
      await lostRuntime.stop();
    }
    const reconciledLoss = await world.cli(["reconcile", "--initiative", "initiative-omo-1"]);
    if (reconciledLoss.code !== 4)
      throw new QaError(`Missing runtime was not reported: ${reconciledLoss.stdout}`);
    const afterLoss = z
      .array(bindingSchema)
      .parse(await invoke(["status", "--initiative", "initiative-omo-1"]));
    if (afterLoss.find((binding) => binding.id === child.id)?.launchState !== "uncertain")
      throw new QaError("Missing child stayed ready");
    if (
      afterLoss
        .filter((binding) => binding.id !== child.id)
        .some((binding) => binding.launchState !== "ready")
    )
      throw new QaError("Healthy roles were changed");
    if ((await herdr.snapshot()).workspaces.length !== final.workspaces.length - 1)
      throw new QaError("Reconcile relaunched a workspace");
    console.log(
      "RECONCILE_QA_PASS: lost runtime became uncertain; healthy roles retained; no relaunch",
    );
    for (const binding of bindings.toReversed()) {
      const marker = binding.checkout === null ? null : join(binding.cwd, "keep-on-close.txt");
      if (marker !== null) {
        if (!binding.cwd.startsWith(`${world.controlRoot}/.omo/worktrees/`))
          throw new QaError("Unexpected QA checkout");
        await writeFile(marker, "QA_PRESERVED_DATA\n");
      }
      const closed = bindingSchema.parse(await invoke(["close", "--binding", binding.id]));
      if (closed.launchState !== "closed" || closed.contactState !== "cancelled")
        throw new QaError("Role did not close");
      if (
        marker !== null &&
        (!(await stat(binding.cwd)).isDirectory() ||
          (await readFile(marker, "utf8")) !== "QA_PRESERVED_DATA\n")
      ) {
        throw new QaError("Closure removed worktree data");
      }
    }
    const observer = new RpcClient({ socketPath: supervisor.omoSocket });
    try {
      await observer.start();
      if ((await observer.listSessions()).length !== 0)
        throw new QaError("Closed native sessions remain live");
    } finally {
      await observer.stop();
    }
    if (
      (await herdr.snapshot()).workspaces.some((workspace) =>
        bindings.some((binding) => binding.workspaceId === workspace.workspaceId),
      )
    ) {
      throw new QaError("Closed role workspace remains live");
    }
    console.log(
      "CLOSE_QA_PASS: exact native sessions and workspaces closed; worktree data preserved",
    );
  } catch (error) {
    console.error("QA_FAILURE", error);
    const snapshot = await herdr.snapshot();
    console.error("QA_HERDR_SNAPSHOT", JSON.stringify(snapshot));
    for (const pane of snapshot.panes) {
      console.error(
        "QA_PANE_PROCESS",
        await checkedQaCommand(
          ["herdr", "pane", "process-info", "--pane", pane.paneId],
          world.controlRoot,
          { ...world.environment, HERDR_SOCKET_PATH: world.herdrSocket },
        ),
      );
      console.error(
        "QA_PANE_TEXT",
        await checkedQaCommand(
          ["herdr", "pane", "read", pane.paneId, "--source", "recent-unwrapped", "--lines", "28"],
          world.controlRoot,
          { ...world.environment, HERDR_SOCKET_PATH: world.herdrSocket },
        ),
      );
    }
    const debugClient = new RpcClient({
      socketPath: join(world.controlRoot, ".omo/state/omo.sock"),
    });
    try {
      await debugClient.start();
      const sessions = await debugClient.listSessions();
      console.error("QA_NATIVE_SESSIONS", JSON.stringify(sessions));
      for (const session of sessions) {
        if (session.sessionPath) {
          await debugClient.openSession({ sessionPath: session.sessionPath });
          const observed = await debugClient.getState();
          console.error(
            "QA_ACTUAL_MODEL",
            observed.model?.provider,
            observed.model?.id,
            observed.thinkingLevel,
          );
          console.error(
            "QA_DESCRIBE",
            JSON.stringify(await debugClient.requestExtension("omo.initiative.describe")),
          );
        }
      }
    } finally {
      await debugClient.stop();
    }
    throw error;
  } finally {
    for (const client of clients) await client.stop();
    herdr.close();
    await world.close();
  }
}
