import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SessionManager } from "@code-yeongyu/senpi";
import { z } from "zod";
import { runCli } from "../src/cli";
import type { Registry, Result } from "../src/core/contracts";
import { modelForBinding } from "../src/core/policy";
import { scopeSnapshotSchema } from "../src/core/schema";
import { openRegistry } from "../src/core/store";
import { createHerdrClient } from "../src/herdr";
import { resolveHerdrArtifact } from "../src/herdr/artifact";
import type { OrchestratorDependencies } from "../src/orchestrator";
import { publishReadiness } from "../src/readiness";
import { checkoutGit } from "../src/repo/checkout";

// Real CLI + registry + Git + official Herdr RPC. Native model execution is deliberately
// replaced at its boundary: grouping QA needs neither credentials nor model network calls.
const root = resolve(import.meta.dir, "..");
const artifact = await resolveHerdrArtifact(root);
const scratch = await mkdtemp(join(tmpdir(), "olw-owned-qa-"));
const control = join(scratch, "control");
const home = join(scratch, "home");
await mkdir(control);
await mkdir(home);
const env = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_DATA_HOME: join(home, ".local/share"),
  XDG_STATE_HOME: join(home, ".local/state"),
  XDG_CACHE_HOME: join(home, ".cache"),
  HERDR_SOCKET_PATH: undefined,
  HERDR_CLIENT_SOCKET_PATH: undefined,
  HERDR_SESSION: undefined,
};
const sessionName = `olw-owned-${crypto.randomUUID().slice(0, 8)}`;
const server = Bun.spawn([artifact.binaryPath, "--session", sessionName, "server"], {
  cwd: scratch,
  env,
  stdin: "ignore",
  stdout: "pipe",
  stderr: "pipe",
});
const ready = Promise.withResolvers<string>();
const timeout = setTimeout(
  () => ready.reject(new Error("Isolated Herdr readiness timeout")),
  30_000,
);
const stdout = new Response(server.stdout).text();
const stderr = (async () => {
  let buffer = "";
  for await (const chunk of server.stderr) {
    buffer += new TextDecoder().decode(chunk);
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const match = /^api socket: (.+)$/.exec(line);
      if (match?.[1]) ready.resolve(match[1]);
    }
  }
  ready.reject(new Error("Isolated Herdr exited before readiness"));
})();
const methods: string[] = [];
const requests: unknown[] = [];
const snapshots: unknown[] = [];
const sockets = new Set<Socket>();
const proxy = createServer();
let result: unknown;
let failure: unknown;
try {
  const upstreamPath = await ready.promise;
  clearTimeout(timeout);
  const proxyPath = join(scratch, "recording.sock");
  const requestSchema = z.object({ method: z.string(), params: z.unknown() });
  const responseSchema = z.object({
    result: z.object({ type: z.literal("session_snapshot"), snapshot: z.unknown() }),
  });
  proxy.on("connection", (socket) => {
    const upstream = createConnection(upstreamPath);
    sockets.add(socket);
    sockets.add(upstream);
    let incoming = "";
    let outgoing = "";
    socket.on("data", (chunk) => {
      incoming += chunk.toString();
      for (;;) {
        const newline = incoming.indexOf("\n");
        if (newline < 0) break;
        const request = requestSchema.parse(JSON.parse(incoming.slice(0, newline)));
        incoming = incoming.slice(newline + 1);
        methods.push(request.method);
        requests.push(request);
      }
      upstream.write(chunk);
    });
    upstream.on("data", (chunk) => {
      outgoing += chunk.toString();
      for (;;) {
        const newline = outgoing.indexOf("\n");
        if (newline < 0) break;
        const response = responseSchema.safeParse(JSON.parse(outgoing.slice(0, newline)));
        outgoing = outgoing.slice(newline + 1);
        if (response.success) snapshots.push(response.data.result.snapshot);
      }
      socket.write(chunk);
    });
    socket.on("end", () => upstream.end());
    upstream.on("end", () => socket.end());
    socket.on("close", () => {
      sockets.delete(socket);
      upstream.destroy();
    });
    upstream.on("close", () => {
      sockets.delete(upstream);
      socket.destroy();
    });
    socket.on("error", (error) => {
      failure = error;
      upstream.destroy();
    });
    upstream.on("error", (error) => {
      failure = error;
      socket.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(proxyPath, resolve);
  });
  const seed = join(scratch, "seed");
  await mkdir(seed);
  await checkoutGit(seed, ["init", "-b", "main"]);
  await writeFile(join(seed, "README"), "owned clone QA\n");
  await checkoutGit(seed, ["add", "."]);
  await checkoutGit(seed, [
    "-c",
    "user.name=QA",
    "-c",
    "user.email=qa@localhost",
    "commit",
    "-m",
    "initial",
  ]);
  const remotePath = join(scratch, "target.git");
  await checkoutGit(scratch, ["clone", "--bare", seed, remotePath]);
  const remote = pathToFileURL(remotePath).href;
  await rm(seed, { recursive: true }); // No user-local repository remains.
  await mkdir(join(control, ".omo/state"), { recursive: true });
  const registry = <T>(action: (r: Registry) => T) => {
    const r = openRegistry(join(control, ".omo/state/registry.sqlite"));
    try {
      return action(r);
    } finally {
      r.close();
    }
  };
  const value = <T>(result: Result<T>): T => {
    assert.ok(result.ok, JSON.stringify(result));
    return result.value;
  };
  const deps: OrchestratorDependencies = {
    openRegistry,
    resolveHerdrArtifact: async () => artifact,
    ensureHost: async () => {},
    now: () => new Date().toISOString(),
    uuid: () => crypto.randomUUID(),
    gitTip: (cwd, ref) => checkoutGit(cwd, ["rev-parse", ref]),
    prompt: async () => {},
    terminateBinding: async () => {},
    createHerdrClient: (socket) => {
      const client = createHerdrClient(socket);
      return {
        createWorkspace: (cwd, label) => client.createWorkspace(cwd, label),
        createWorktree: (checkout, label, grouping) =>
          client.createWorktree(checkout, label, grouping),
        createTab: (workspace, cwd, label) => client.createTab(workspace, cwd, label),
        renameTab: (tab, label) => client.renameTab(tab, label),
        focusWorkspace: (workspace) => client.focusWorkspace(workspace),
        sendKeys: (pane, text, keys) => client.sendKeys(pane, text, keys),
        reportSession: (pane, path) => client.reportSession(pane, path),
        snapshot: () => client.snapshot(),
        subscribe: (listener) => client.subscribe(listener),
        closeWorkspace: (workspace) => client.closeWorkspace(workspace),
        removeWorktree: (workspace) => client.removeWorktree(workspace),
        close: () => client.close(),
        run: async (paneId, argv) => {
          const path = argv[argv.indexOf("--session") + 1];
          assert.ok(path);
          const session = SessionManager.open(path);
          const binding = registry((r) => value(r.bySession(session.getSessionId())));
          await publishReadiness(control, {
            bindingId: binding.id,
            durableSessionId: binding.durableSessionId,
            sessionPath: path,
            cwd: binding.cwd,
            paneId,
          });
        },
      };
    },
    attachBinding: async (binding) => ({
      configure: async () => {},
      hasUserMessage: async () => true,
      describe: async () => ({
        ok: true,
        value: {
          durableSessionId: binding.durableSessionId,
          sessionPath: binding.sessionPath ?? "",
          cwd: binding.cwd,
          ...modelForBinding(binding),
          extensionProtocol: 2,
        },
      }),
      send: async (envelope) =>
        registry((r) => {
          const claim = r.claim(binding.durableSessionId, envelope);
          if (!claim.ok) return claim;
          return r.finish(
            envelope.id,
            {
              kind: "ok",
              thread_id: claim.value.target?.durableSessionId ?? "",
              message_seq: 1,
              deduplicated: false,
              delivery: { kind: "started", turn_id: "qa" },
            },
            claim.value.nativeKey,
          );
        }),
      deliverUserAnswer: async () => {
        throw new Error("No QA user answers");
      },
      onEvent: () => () => {},
      close: async () => {},
    }),
  };
  const cli = async (args: string[]) =>
    assert.equal(
      await runCli(["--root", control, "--herdr-socket", proxyPath, ...args, "--json"], deps),
      0,
    );
  const pairs = [];
  for (const project of ["P-QA-1", "P-QA-2"]) {
    const snapshot = {
      version: 1,
      source: "fixture",
      initiative: null,
      projects: [
        {
          project: { id: project, key: project, url: `linear://${project}`, revision: "1" },
          repository: { remote, defaultBranch: "main" },
          issues: [{ id: `${project}-issue`, url: `linear://${project}-issue`, revision: "1" }],
        },
      ],
      decisionRefs: [],
    };
    const scopeFile = join(scratch, `${project}.json`);
    await writeFile(scopeFile, JSON.stringify(snapshot));
    await cli(["scope", "import", "--file", scopeFile, "--fixture"]);
    const digest = value(
      registry((r) => r.importScope(scopeSnapshotSchema.parse(snapshot))),
    ).digest;
    await cli([
      "parent",
      "create",
      "--project",
      project,
      "--scope-digest",
      digest,
      "--designation",
      project,
      "--execute",
      "--fixture",
      "--no-manager",
    ]);
    const parent = value(registry((r) => r.list())).find(
      (b) => b.assignment.role === "parent" && b.assignment.projectId === project,
    );
    assert.ok(parent);
    await cli([
      "child",
      "create",
      "--parent",
      parent.id,
      "--issue",
      `${project}-issue`,
      "--mode",
      "planned",
    ]);
    const child = value(registry((r) => r.list())).find(
      (b) => b.assignment.role === "child" && b.assignment.projectId === project,
    );
    assert.ok(child);
    const planPath = join(child.cwd, "plan.md");
    await writeFile(planPath, "QA plan\n");
    const head = await checkoutGit(child.cwd, ["rev-parse", "HEAD"]);
    await cli([
      "stage",
      "complete",
      "--from",
      child.id,
      "--plan",
      planPath,
      "--head",
      head,
      "--id",
      `${project}-handoff`,
      "--text-file",
      planPath,
    ]);
    await cli([
      "stage",
      "start",
      "--from",
      child.id,
      "--parent",
      parent.id,
      "--stage",
      "execute",
      "--id",
      `${project}-execute`,
    ]);
    const execute = value(registry((r) => r.list())).find(
      (b) =>
        b.assignment.role === "child" &&
        b.assignment.projectId === project &&
        b.launchState === "ready",
    );
    assert.ok(execute);
    assert.equal(execute.cwd, child.cwd);
    assert.equal(execute.workspaceId, child.workspaceId);
    pairs.push({ parent, child: execute });
  }
  const observer = createHerdrClient(proxyPath);
  try {
    await observer.snapshot();
  } finally {
    observer.close();
  }
  const snapshot = z
    .object({
      workspaces: z.array(
        z.object({
          workspace_id: z.string(),
          worktree: z.looseObject({ repo_key: z.string() }).optional(),
        }),
      ),
    })
    .parse(snapshots.at(-1));
  const groups = pairs.map(({ parent, child }) => {
    const p = snapshot.workspaces.find((w) => w.workspace_id === parent.workspaceId);
    const c = snapshot.workspaces.find((w) => w.workspace_id === child.workspaceId);
    assert.ok(p?.worktree && c?.worktree);
    assert.equal(p.worktree.repo_key, c.worktree.repo_key);
    assert.equal(p.worktree.repo_key, join(parent.cwd, ".git"));
    return p.worktree.repo_key;
  });
  assert.equal(new Set(groups).size, 2);
  assert.equal(methods.filter((m) => m === "workspace.create").length, 2);
  assert.equal(methods.filter((m) => m === "worktree.create").length, 2);
  assert.equal(methods.includes("worktree.create_grouped"), false);
  assert.equal(methods.filter((m) => m === "tab.create").length, 2);
  for (const { parent, child } of pairs) {
    await cli(["close", "--binding", child.id]);
    await cli(["close", "--binding", parent.id]);
    assert.equal(await checkoutGit(parent.cwd, ["rev-parse", "--git-common-dir"]), ".git");
  }
  assert.equal(failure, undefined);
  result = {
    passed: true,
    artifact: artifact.receipt,
    groups,
    snapshot,
    methods,
    requests,
    nativeBoundary: "simulated; real CLI, Git, registry and official Herdr server",
    scratch,
  };
} catch (error) {
  failure = error;
} finally {
  clearTimeout(timeout);
  for (const socket of sockets) socket.destroy();
  if (proxy.listening)
    await new Promise<void>((resolve, reject) =>
      proxy.close((error) => (error ? reject(error) : resolve())),
    );
  server.kill("SIGTERM");
  const deadline = setTimeout(() => server.kill("SIGKILL"), 5_000);
  await Promise.all([server.exited, stdout, stderr]);
  clearTimeout(deadline);
  await rm(scratch, { recursive: true, force: true });
  await writeFile(
    join(root, ".omo/evidence/lina-273-qa.json"),
    JSON.stringify(
      {
        result,
        error: failure instanceof Error ? failure.stack : failure,
        cleanup: { pid: server.pid, exited: true, scratchRemoved: scratch },
      },
      null,
      2,
    ),
  );
  console.log(`CLEANUP: isolated Herdr ${server.pid} exited; ${scratch} removed`);
}
if (failure !== undefined) throw failure;
console.log("OWNED_CLONES_QA_OK");
