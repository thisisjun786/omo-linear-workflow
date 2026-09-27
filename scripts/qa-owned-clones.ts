import assert from "node:assert/strict";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
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
import { loadHerdrBuild, resolveHerdrArtifact } from "../src/herdr/artifact";
import type { OrchestratorDependencies } from "../src/orchestrator";
import { publishReadiness } from "../src/readiness";
import { checkoutGit } from "../src/repo/checkout";

// Real CLI + registry + Git + official Herdr RPC. Native model execution is deliberately
// replaced at its boundary: grouping QA needs neither credentials nor model network calls.
const root = resolve(import.meta.dir, "..");
const installedArtifact = await resolveHerdrArtifact(root);
const scratch = await mkdtemp(join(tmpdir(), "olw-owned-qa-"));
const control = join(scratch, "control");
const home = join(scratch, "home");
await mkdir(control);
await mkdir(home);
await cp(join(root, "herdr-release.json"), join(control, "herdr-release.json"));
const fixtureBuild = await loadHerdrBuild(control);
await cp(installedArtifact.artifactDir, fixtureBuild.artifactDir, { recursive: true });
const artifact = await resolveHerdrArtifact(control);
await writeFile(
  join(scratch, "herdr.toml"),
  "[update]\nversion_check = false\nmanifest_check = false\n",
);
const env = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_DATA_HOME: join(home, ".local/share"),
  XDG_STATE_HOME: join(home, ".local/state"),
  XDG_CACHE_HOME: join(home, ".cache"),
  HERDR_CONFIG_PATH: join(scratch, "herdr.toml"),
  HERDR_SOCKET_PATH: undefined,
  HERDR_CLIENT_SOCKET_PATH: undefined,
  HERDR_SESSION: undefined,
};
const ghEnvironment = Object.fromEntries(
  ["OLW_GH_BIN", "OLW_TEST_GH_STATE", "OLW_TEST_REMOTE"].map((key) => [key, process.env[key]]),
);
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
let result: unknown;
let failure: unknown;
try {
  const upstreamPath = await ready.promise;
  clearTimeout(timeout);
  // Record the client boundary, not a forwarding proxy: event subscribers may close while
  // Herdr is emitting notifications. The real server remains the integration under test.
  const record = (method: string, params: unknown) => {
    methods.push(method);
    requests.push({ method, params });
  };
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
  const ghState = join(scratch, "gh.json");
  await writeFile(ghState, "[]");
  const ghShim = join(scratch, "gh");
  await writeFile(
    ghShim,
    `#!/bin/sh\nexec '${process.execPath}' '${join(root, "tests/fixtures/gh-shim.ts")}' "$@"\n`,
  );
  await chmod(ghShim, 0o700);
  process.env["OLW_GH_BIN"] = ghShim;
  process.env["OLW_TEST_GH_STATE"] = ghState;
  process.env["OLW_TEST_REMOTE"] = remotePath;
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
        createWorkspace: (cwd, label) => {
          record("workspace.create", { cwd, label });
          return client.createWorkspace(cwd, label);
        },
        createWorktree: (checkout, label) => {
          record("worktree.create", { checkout, label });
          return client.createWorktree(checkout, label);
        },
        createTab: (workspace, cwd, label) => {
          record("tab.create", { workspace, cwd, label });
          return client.createTab(workspace, cwd, label);
        },
        renameTab: (tab, label) => client.renameTab(tab, label),
        focusWorkspace: (workspace) => client.focusWorkspace(workspace),
        sendKeys: (pane, text, keys) => client.sendKeys(pane, text, keys),
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
      await runCli(["--root", control, "--herdr-socket", upstreamPath, ...args, "--json"], deps),
      0,
    );
  const pairs = [];
  for (const project of ["P-QA-1", "P-QA-2"]) {
    const issueKey = project.replace("P-", "");
    const snapshot = {
      version: 1,
      source: "fixture",
      initiative: null,
      projects: [
        {
          project: { id: project, key: project, url: `linear://${project}`, revision: "1" },
          repository: { remote, defaultBranch: "main" },
          issues: [
            {
              id: `${project}-issue`,
              key: issueKey,
              url: `linear://${project}-issue`,
              revision: "1",
            },
          ],
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
    const planBrief = z
      .object({
        stage: z.literal("plan"),
        deliverable: z.literal("pr"),
        plan_path: z.string(),
        execution_skills: z.array(z.string()),
      })
      .parse(Bun.YAML.parse(child.initialization.text ?? ""));
    assert.equal(planBrief.plan_path, `.omo/plans/${issueKey}.md`);
    assert.deepEqual(planBrief.execution_skills, ["olw-run", "ulw-plan"]);
    const planPath = join(child.cwd, planBrief.plan_path);
    await mkdir(join(child.cwd, ".omo/plans"), { recursive: true });
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
    assert.equal(execute.deliverable, "pr");
    const executeBrief = z
      .object({
        stage: z.literal("execute"),
        deliverable: z.literal("pr"),
        plan_path: z.string(),
        plan_head: z.string(),
        integration_branch: z.string(),
        execution_skills: z.array(z.string()),
      })
      .parse(Bun.YAML.parse(execute.initialization.text ?? ""));
    assert.equal(executeBrief.plan_path, planPath);
    assert.equal(executeBrief.plan_head, head);
    assert.equal(executeBrief.integration_branch, parent.checkout?.branch);
    assert.deepEqual(executeBrief.execution_skills, ["olw-run", "ulw-execute", "mass-ulw"]);
    pairs.push({ parent, child: execute, issueKey });
  }
  // One direct raw snapshot retains repo_key, which the normalized client intentionally omits.
  const response = await new Promise<unknown>((resolve, reject) => {
    const socket = createConnection(upstreamPath);
    const deadline = setTimeout(() => {
      socket.destroy();
      reject(new Error("Snapshot timeout"));
    }, 10_000);
    let buffer = "";
    socket.once("connect", () =>
      socket.write(
        `${JSON.stringify({ id: "qa-snapshot", method: "session.snapshot", params: {} })}\n`,
      ),
    );
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        resolve(JSON.parse(buffer.slice(0, newline)));
      } catch (error) {
        reject(error);
      }
      socket.destroy();
    });
    socket.once("error", reject);
    socket.once("close", () => {
      clearTimeout(deadline);
      reject(new Error("Snapshot connection closed"));
    });
  });
  const snapshot = z
    .object({
      workspaces: z.array(
        z.object({
          workspace_id: z.string(),
          worktree: z.looseObject({ repo_key: z.string() }).optional(),
        }),
      ),
    })
    .parse(
      z.object({ result: z.object({ snapshot: z.unknown() }) }).parse(response).result.snapshot,
    );
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
  const integrations = [];
  for (const { parent, child, issueKey } of pairs) {
    const issue = child.assignment.role === "child" ? child.assignment.issueId : "";
    await writeFile(join(child.cwd, "result.txt"), `${issue} implemented\n`);
    await checkoutGit(child.cwd, ["add", "result.txt"]);
    await checkoutGit(child.cwd, [
      "-c",
      "user.name=QA",
      "-c",
      "user.email=qa@localhost",
      "commit",
      "-m",
      issue,
    ]);
    const childHead = await checkoutGit(child.cwd, ["rev-parse", "HEAD"]);
    const bodyFile = join(scratch, `${issue}-pr.md`);
    await writeFile(
      bodyFile,
      `${issueKey} (${issue})\nCriteria: integration branch advances via child PR merge commit.\nEvidence: isolated real Git and Herdr QA.\n`,
    );
    await cli(["pr", "open", "--from", child.id, "--body-file", bodyFile]);
    await cli(["pr", "open", "--from", child.id, "--body-file", bodyFile]);
    const prs = z
      .array(z.object({ url: z.string(), headRefName: z.string() }))
      .parse(JSON.parse(await readFile(ghState, "utf8")));
    const pr = prs.find((entry) => entry.headRefName === child.checkout?.branch);
    assert.ok(pr);
    await cli([
      "report",
      "--from",
      child.id,
      "--id",
      `report:${issue}`,
      "--outcome",
      "completed",
      "--pr",
      pr.url,
      "--head",
      childHead,
      "--evidence",
      bodyFile,
      "--text-file",
      bodyFile,
    ]);
    await cli(["pr", "merge", "--from", parent.id, "--pr", pr.url]);
    const parentHead = await checkoutGit(parent.cwd, ["rev-parse", "HEAD"]);
    assert.equal(
      await checkoutGit(remotePath, ["rev-parse", parent.checkout?.branch ?? ""]),
      parentHead,
    );
    const ancestry = (await checkoutGit(parent.cwd, ["rev-list", "--parents", "-1", "HEAD"])).split(
      " ",
    );
    assert.equal(ancestry.length, 3);
    assert.equal(ancestry[2], childHead);
    integrations.push({ pr: pr.url, childHead, parentHead });
    await cli(["pr", "open", "--from", parent.id, "--base", "main"]);
    assert.notEqual(await checkoutGit(remotePath, ["rev-parse", "main"]), parentHead);
    await cli(["close", "--binding", child.id]);
    await cli(["close", "--binding", parent.id]);
    assert.equal(await checkoutGit(parent.cwd, ["rev-parse", "--git-common-dir"]), ".git");
  }
  assert.equal(failure, undefined);
  result = {
    passed: true,
    artifact: { version: artifact.manifest.version, sha256: artifact.asset.sha256 },
    groups,
    integrations,
    ghArgv: (await readFile(`${ghState}.argv`, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
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
  for (const [key, value] of Object.entries(ghEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  server.kill("SIGTERM");
  const deadline = setTimeout(() => server.kill("SIGKILL"), 5_000);
  await Promise.all([server.exited, stdout, stderr]);
  clearTimeout(deadline);
  await rm(scratch, { recursive: true, force: true });
  await writeFile(
    join(root, ".omo/evidence/lina-274-qa.json"),
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
