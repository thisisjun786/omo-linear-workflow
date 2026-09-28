import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { SessionManager } from "@code-yeongyu/senpi";
import type { Registry, Result, ScopeSnapshot } from "../../src/core/contracts";
import { modelForBinding } from "../../src/core/policy";
import { openRegistry } from "../../src/core/store";
import type { HerdrClient, Workspace } from "../../src/herdr";
import { Orchestrator } from "../../src/orchestrator";
import { publishReadiness } from "../../src/readiness";
import { initializeCheckout } from "../../src/repo/checkout";
import { mirrorPath } from "../../src/repo/mirror";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}
async function git(cwd: string, ...args: string[]) {
  const child = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(err);
  return out.trim();
}
async function world() {
  const root = await mkdtemp(join(tmpdir(), "olw-owned-"));
  roots.push(root);
  const seed = join(root, "seed");
  await mkdir(seed);
  await git(seed, "init", "-b", "main");
  await writeFile(join(seed, "README"), "fixture\n");
  await git(seed, "add", ".");
  await git(seed, "-c", "user.name=QA", "-c", "user.email=qa@localhost", "commit", "-m", "initial");
  const head = await git(seed, "rev-parse", "HEAD");
  const bare = join(root, "target.git");
  await git(root, "clone", "--bare", seed, bare);
  const remote = pathToFileURL(bare).href;
  const scope: ScopeSnapshot = {
    version: 1,
    source: "fixture",
    initiative: null,
    decisionRefs: [],
    projects: [
      {
        project: { id: "project", key: "P-LINA-88", url: "linear://project", revision: "r1" },
        issues: [{ id: "issue", key: "LINA-273", url: "linear://issue", revision: "r1" }],
        repository: { remote, defaultBranch: "main" },
      },
    ],
  };
  await mkdir(join(root, ".omo/state"), { recursive: true });
  const db = join(root, ".omo/state/registry.sqlite");
  const registry = <T>(action: (r: Registry) => T) => {
    const r = openRegistry(db);
    try {
      return action(r);
    } finally {
      r.close();
    }
  };
  const digest = registry((r) => value(r.importScope(scope)).digest);
  const calls: Array<{ method: string; cwd: string; grouping?: unknown }> = [];
  const workspaces = new Map<string, Workspace>();
  let sequence = 0;
  const herdr: HerdrClient = {
    async createWorkspace(cwd) {
      calls.push({ method: "workspace.create", cwd });
      const workspace = {
        cwd,
        workspaceId: `ws-${++sequence}`,
        rootPaneId: `pane-${sequence}`,
        rootTabId: `tab-${sequence}`,
      };
      workspaces.set(workspace.workspaceId, workspace);
      return workspace;
    },
    async createWorktree(checkout) {
      calls.push({ method: "worktree.create", cwd: checkout.originalRepoRoot });
      await git(
        checkout.originalRepoRoot,
        "worktree",
        "add",
        "-b",
        checkout.branch,
        checkout.path,
        checkout.baseBranch,
      );
      const workspace = {
        cwd: checkout.path,
        workspaceId: `ws-${++sequence}`,
        rootPaneId: `pane-${sequence}`,
        rootTabId: `tab-${sequence}`,
      };
      workspaces.set(workspace.workspaceId, workspace);
      return workspace;
    },
    async createTab(workspaceId, cwd) {
      calls.push({ method: "tab.create", cwd });
      return { tabId: `${workspaceId}:t2`, rootPaneId: `${workspaceId}:p2` };
    },
    async renameTab() {},
    async closeTab() {
      throw new Error("unexpected closeTab");
    },
    async focusWorkspace() {},
    async focusPane() {},
    async paneContainsProcess() {
      return true;
    },
    async paneForegroundProcesses() {
      return [{ pid: 424242, name: "bun" }];
    },
    async sendKeys() {},
    async run(paneId, argv) {
      const path = argv[argv.indexOf("--session") + 1];
      if (!path) throw new Error("missing session");
      const session = SessionManager.open(path);
      const binding = registry((r) => value(r.bySession(session.getSessionId())));
      await publishReadiness(root, {
        bindingId: binding.id,
        durableSessionId: binding.durableSessionId,
        sessionPath: path,
        cwd: binding.cwd,
        paneId,
      });
    },
    async snapshot() {
      return {
        focusedWorkspaceId: null,
        focusedTabId: null,
        focusedPaneId: null,
        workspaces: [...workspaces.values()],
        panes: [],
      };
    },
    async subscribe() {
      return () => {};
    },
    async closeWorkspace(id) {
      workspaces.delete(id);
    },
    async removeWorktree() {
      throw new Error("must preserve checkout");
    },
    close() {},
  };
  const orchestrator = new Orchestrator(root, "/fixture/herdr", {
    openRegistry,
    createHerdrClient: () => herdr,
    resolveHerdrArtifact: async () => ({ artifactDir: "/fixture/herdr" }),
    ensureHost: async () => {},
    gitTip: (cwd, ref) => git(cwd, "rev-parse", ref),
    now: () => new Date().toISOString(),
    uuid: () => crypto.randomUUID(),
    prompt: async () => {},
    terminateBinding: async () => {},
    attachBinding: async (binding) => ({
      configure: async () => {},
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
      hasUserMessage: async () => true,
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
              delivery: { kind: "started", turn_id: "fixture" },
            },
            claim.value.nativeKey,
          );
        }),
      deliverUserAnswer: async () => {
        throw new Error("unused");
      },
      onEvent: () => () => {},
      close: async () => {},
    }),
  });
  const input = {
    scopeDigest: digest,
    designationId: "approval",
    projectId: "project",
    execute: true,
    fixture: true,
  };
  return {
    root,
    db,
    head,
    remote,
    scope,
    registry,
    calls,
    orchestrator,
    input,
    create: () => orchestrator.createParent(input),
  };
}

test("mapped parent uses a hardlinked independent clone and children use its real Git common dir", async () => {
  const w = await world();
  const parent = value(await w.create()).binding;
  expect(parent.checkout).toMatchObject({
    kind: "owned-clone",
    originalRepoRoot: parent.cwd,
    baseBranch: "origin/main",
    baseCommit: w.head,
  });
  expect(parent.cwd).toContain("/.omo/checkouts/target-P-LINA-88-");
  expect(await git(parent.cwd, "remote", "get-url", "origin")).toBe(w.remote);
  expect(await Bun.file(join(parent.cwd, ".git/objects/info/alternates")).exists()).toBe(false);
  const object = `objects/${w.head.slice(0, 2)}/${w.head.slice(2)}`;
  // file:// mirrors may pack objects; compare a pack inode when the commit is packed.
  const packs = await git(parent.cwd, "rev-parse", "--git-common-dir");
  expect(packs).toBe(".git");
  const { readdir } = await import("node:fs/promises");
  const mirror = mirrorPath(w.root, w.remote);
  const packed = (await readdir(join(mirror, "objects/pack"))).find((name) =>
    name.endsWith(".pack"),
  );
  const objectPath = packed === undefined ? object : `objects/pack/${packed}`;
  expect((await stat(join(parent.cwd, ".git", objectPath))).ino).toBe(
    (await stat(join(mirror, objectPath))).ino,
  );
  const child = value(
    await w.orchestrator.createChild({ parentId: parent.id, issueId: "issue", mode: "planned" }),
  ).binding;
  expect(child.checkout).toMatchObject({
    kind: "linked-worktree",
    originalRepoRoot: parent.cwd,
    baseBranch: parent.checkout?.branch,
    baseCommit: w.head,
  });
  expect(await git(child.cwd, "rev-parse", "--git-common-dir")).toBe(join(parent.cwd, ".git"));
  expect(w.calls).toEqual([
    { method: "workspace.create", cwd: parent.cwd },
    { method: "worktree.create", cwd: parent.cwd, grouping: undefined },
  ]);
});

test("research defaults to a report, carries the packet kind and requires an explicit deliverable path", async () => {
  const w = await world();
  const parent = value(await w.create()).binding;
  const child = value(
    await w.orchestrator.createChild({ parentId: parent.id, issueId: "issue", mode: "research" }),
  ).binding;
  expect(child.deliverable).toBe("report");
  expect(Bun.YAML.parse(child.initialization.text ?? "")).toMatchObject({ deliverable: "report" });
  expect(value(w.orchestrator.status()).find((b) => b.id === child.id)?.deliverable).toBe("report");
  const packet = value(
    await w.orchestrator.send({
      fromId: parent.id,
      toId: child.id,
      messageId: "packet",
      kind: "instruction",
      text: "fixture research",
    }),
  );
  expect(packet).toMatchObject({ envelope: { deliverable: "report" } });
  const path = join(w.root, "findings.md");
  await writeFile(path, "fixture findings");
  const report = {
    fromId: child.id,
    messageId: "report:packet",
    outcome: "completed" as const,
    evidence: [path],
    text: "findings",
  };
  expect(await w.orchestrator.report(report)).toMatchObject({
    ok: false,
    error: { code: "deliverable_missing" },
  });
  expect(
    value(await w.orchestrator.report({ ...report, delivery: { kind: "report", path } })),
  ).toMatchObject({ envelope: { delivery: { kind: "report", path } }, state: "accepted" });
  expect(await git(parent.cwd, "ls-remote", "--heads", "origin")).not.toContain(
    child.checkout?.branch ?? "missing",
  );
});

test("--repo is rejected even with a mapping, without creating a checkout", async () => {
  const w = await world();
  expect(
    await w.orchestrator.createParent({ ...w.input, repo: w.root, base: "main" }),
  ).toMatchObject({ ok: false, error: { code: "legacy_parent_unsupported" } });
  expect(w.registry((r) => value(r.list()))).toEqual([]);
  expect(w.calls).toEqual([]);
});

test("old registry checkout rows read as linked worktrees, including read-only access", async () => {
  const w = await world();
  const parent = value(await w.create()).binding;
  const db = new Database(w.db);
  db.run(
    "UPDATE bindings SET json = json_remove(json, '$.checkout.kind', '$.checkout.remote', '$.checkout.receiptPath') WHERE id = ?",
    [parent.id],
  );
  db.close();
  const registry = openRegistry(w.db, { readonly: true });
  try {
    expect(value(registry.get(parent.id)).checkout).toMatchObject({
      kind: "linked-worktree",
      originalRepoRoot: parent.cwd,
    });
  } finally {
    registry.close();
  }
});

test("explicit local files are private, receipted and redacted from setup logs in parent and child", async () => {
  const w = await world();
  const secret = "OWNED_FIXTURE_SECRET_273";
  const source = join(w.root, "local-env");
  await writeFile(source, secret);
  await mkdir(join(w.root, ".omo/repos"), { recursive: true });
  await writeFile(
    join(w.root, ".omo/repos/config.json"),
    JSON.stringify({
      [w.remote]: {
        localFiles: [{ source, target: ".env" }],
        setup: ["cat .env; printf setup-ok > setup-result"],
      },
    }),
  );
  const parent = value(await w.create()).binding;
  const child = value(
    await w.orchestrator.createChild({ parentId: parent.id, issueId: "issue" }),
  ).binding;
  for (const binding of [parent, child]) {
    expect(await readFile(join(binding.cwd, ".env"), "utf8")).toBe(secret);
    expect((await stat(join(binding.cwd, ".env"))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(binding.cwd, "setup-result"), "utf8")).toBe("setup-ok");
    const receiptPath = binding.checkout?.receiptPath;
    expect(receiptPath).toBeDefined();
    const receipt = await readFile(receiptPath ?? "", "utf8");
    expect(receipt).not.toContain(secret);
    expect(JSON.parse(receipt)).toMatchObject({
      setup: [{ code: 0, timedOut: false }],
    });
    const log = await readFile(`${receiptPath}.setup-0.log`, "utf8");
    expect(log).not.toContain(secret);
  }
});

test("close preserves owned clone and refuses unpublished commits unless explicitly discarded", async () => {
  const w = await world();
  const parent = value(await w.create()).binding;
  await writeFile(join(parent.cwd, "work"), "local work");
  await git(parent.cwd, "add", "work");
  await git(
    parent.cwd,
    "-c",
    "user.name=QA",
    "-c",
    "user.email=qa@localhost",
    "commit",
    "-m",
    "local-only",
  );
  const commit = await git(parent.cwd, "rev-parse", "HEAD");
  expect(await w.orchestrator.close(parent.id)).toMatchObject({
    ok: false,
    error: { code: "unpushed_commits", details: { unpushedCommits: [commit] } },
  });
  expect(w.registry((r) => value(r.get(parent.id))).launchState).toBe("ready");
  expect(value(await w.orchestrator.close(parent.id, false, true)).launchState).toBe("closed");
  expect(await git(parent.cwd, "rev-parse", "HEAD")).toBe(commit);
  await git(parent.cwd, "push", "origin", "HEAD:refs/heads/published");
  expect(value(await w.orchestrator.close(parent.id))).toMatchObject({ unpushedCommits: [] });
});

test("snapshot base overrides default branch and duplicate parent never clones twice", async () => {
  const w = await world();
  const snapshot: ScopeSnapshot = {
    ...w.scope,
    projects: w.scope.projects.map((p) => ({
      ...p,
      repository: { remote: w.remote, defaultBranch: "missing", base: w.head },
    })),
  };
  const digest = w.registry((r) => value(r.importScope(snapshot)).digest);
  const input = { ...w.input, scopeDigest: digest };
  const parent = value(await w.orchestrator.createParent(input)).binding;
  expect(parent.checkout?.baseCommit).toBe(w.head);
  expect(await w.orchestrator.createParent(input)).toMatchObject({
    ok: false,
    error: { code: "ownership_conflict" },
  });
  expect(w.calls).toHaveLength(1);
});

test.each(["../outside", ".git/config", "link/secret"])(
  "rejects local-file escape %s",
  async (target) => {
    const w = await world();
    const parent = value(await w.create()).binding;
    if (!parent.checkout) throw new Error("missing checkout");
    await symlink(w.root, join(parent.cwd, "link"));
    const source = join(w.root, "source");
    await writeFile(source, "secret");
    await writeFile(
      join(w.root, ".omo/repos/config.json"),
      JSON.stringify({ [w.remote]: { localFiles: [{ source, target }] } }),
    );
    await expect(initializeCheckout(w.root, parent.checkout)).rejects.toThrow();
    expect(await Bun.file(join(w.root, "secret")).exists()).toBe(false);
  },
);

test.each([false, true])(
  "failed setup records a private receipt (deadline=%s)",
  async (deadline) => {
    const w = await world();
    await mkdir(join(w.root, ".omo/repos"), { recursive: true });
    await writeFile(
      join(w.root, ".omo/repos/config.json"),
      JSON.stringify({
        [w.remote]: {
          setup: [deadline ? "while :; do :; done" : "printf failure >&2; exit 7"],
          setupTimeoutMs: 30,
        },
      }),
    );
    expect(await w.create()).toMatchObject({ ok: false, error: { code: "runtime_unavailable" } });
    const binding = w.registry((r) => value(r.list()))[0];
    if (!binding?.checkout?.receiptPath) throw new Error("missing receipt");
    const receipt = JSON.parse(await readFile(binding.checkout.receiptPath, "utf8"));
    expect(receipt).toMatchObject({
      setup: [{ timedOut: deadline, ...(deadline ? {} : { code: 7 }) }],
    });
    expect((await stat(binding.checkout.receiptPath)).mode & 0o777).toBe(0o600);
    expect((await stat(`${binding.checkout.receiptPath}.setup-0.log`)).mode & 0o777).toBe(0o600);
  },
);
