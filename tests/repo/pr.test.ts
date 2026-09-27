import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Binding, Registry, Result, ScopeSnapshot } from "../../src/core/contracts";
import { modelForBinding } from "../../src/core/policy";
import { openRegistry } from "../../src/core/store";
import { checkoutGit } from "../../src/repo/checkout";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
function value<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r.value;
}
async function world(legacy = false, deliverable: "pr" | "report" | "document" = "pr") {
  const root = await mkdtemp(join(tmpdir(), "olw-pr-"));
  roots.push(root);
  const seed = join(root, "seed");
  await mkdir(seed);
  const git = (cwd: string, ...args: string[]) => checkoutGit(cwd, args);
  await git(seed, "init", "-b", "main");
  await git(
    seed,
    "-c",
    "user.name=QA",
    "-c",
    "user.email=qa@localhost",
    "commit",
    "--allow-empty",
    "-m",
    "initial",
  );
  const bare = join(root, "remote.git");
  await git(root, "clone", "--bare", seed, bare);
  const remote = pathToFileURL(bare).href;
  const parentPath = join(root, "parent");
  await git(root, "clone", remote, parentPath);
  await git(parentPath, "checkout", "-b", "integration");
  const head = await git(parentPath, "rev-parse", "HEAD");
  const childPath = join(root, "child");
  await git(parentPath, "worktree", "add", "-b", "issue-274", childPath);
  await mkdir(join(root, ".omo/state"), { recursive: true });
  const registry = <T>(fn: (r: Registry) => T) => {
    const r = openRegistry(join(root, ".omo/state/registry.sqlite"));
    try {
      return fn(r);
    } finally {
      r.close();
    }
  };
  const scope: ScopeSnapshot = {
    version: 1,
    source: "fixture",
    initiative: null,
    decisionRefs: [],
    projects: [
      {
        project: { id: "project", url: "linear://project", revision: "1" },
        issues: [
          { id: "issue", key: "LINA-274", url: "linear://issue", revision: "1" },
          { id: "issue-other", key: "LINA-275", url: "linear://issue-other", revision: "1" },
        ],
        ...(legacy ? {} : { repository: { remote, defaultBranch: "main" } }),
      },
    ],
  };
  const digest = registry((r) => value(r.importScope(scope)).digest);
  const designation = {
    id: "approval",
    snapshotDigest: digest,
    designatedBy: "user",
    designatedAt: "now",
    execute: true,
    create: true,
    contact: true,
  };
  function reserve(child: boolean, other = false) {
    return registry((r) => {
      const id = child ? (other ? "child-other" : "child") : "parent";
      let b = value(
        r.reserve({
          bindingId: id,
          durableSessionId: `${id}-session`,
          designation,
          snapshot: scope,
          assignment: child
            ? {
                role: "child",
                projectId: "project",
                issueId: other ? "issue-other" : "issue",
                initiativeId: null,
                ownerBindingId: "parent",
              }
            : { role: "parent", projectId: "project", initiativeId: null, ownerBindingId: null },
          ...(child ? { deliverable } : {}),
          cwd: child ? childPath : parentPath,
          checkout: {
            kind: child || legacy ? "linked-worktree" : "owned-clone",
            remote,
            originalRepoRoot: parentPath,
            path: child ? childPath : parentPath,
            branch: child ? "issue-274" : "integration",
            baseBranch: child ? "integration" : "main",
            baseCommit: head,
          },
          herdrSocket: "/fixture",
          omoSocket: "/fixture",
        }),
      );
      b = value(r.provision(b.id, `ws-${b.id}`, `pane-${b.id}`));
      b = value(r.observeSession(b.id, `/fixture/${b.id}.jsonl`));
      b = value(
        r.activate(b.id, {
          durableSessionId: b.durableSessionId,
          cwd: b.cwd,
          sessionPath: b.sessionPath ?? "",
          ...modelForBinding(b),
          extensionProtocol: 2,
        }),
      );
      value(r.beginInitialization(b.id, "fixture"));
      return value(r.finishInitialization(b.id, "accepted"));
    });
  }
  const parent = reserve(false);
  const child = reserve(true);
  const state = join(root, "gh.json");
  await writeFile(state, "[]");
  const shim = join(root, "gh");
  await writeFile(
    shim,
    `#!/bin/sh\nexec '${process.execPath}' '${join(import.meta.dir, "../fixtures/gh-shim.ts")}' "$@"\n`,
  );
  await chmod(shim, 0o700);
  const body = join(root, "body.md");
  await writeFile(body, "LINA-274\nCriteria: fixture\nEvidence: fixture checks\n");
  async function cli(...args: string[]) {
    const p = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "../../src/cli.ts"),
        "--root",
        root,
        ...args,
        "--json",
      ],
      {
        env: { ...process.env, OLW_GH_BIN: shim, OLW_TEST_GH_STATE: state, OLW_TEST_REMOTE: bare },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, out, err] = await Promise.all([
      p.exited,
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    expect(err).toBe("");
    return { code, result: JSON.parse(out) };
  }
  async function commit(binding: Binding, name = "work") {
    await writeFile(join(binding.cwd, name), name);
    await git(binding.cwd, "add", name);
    await git(
      binding.cwd,
      "-c",
      "user.name=QA",
      "-c",
      "user.email=qa@localhost",
      "commit",
      "-m",
      name,
    );
    return git(binding.cwd, "rev-parse", "HEAD");
  }
  function report(url: string, head: string, sender = child) {
    registry((r) => {
      const claim = value(
        r.claim(sender.durableSessionId, {
          version: 1,
          id: `report:${sender.id}:${head}`,
          fromBindingId: sender.id,
          toBindingId: parent.id,
          designationId: designation.id,
          snapshotDigest: digest,
          kind: "report",
          outcome: "completed",
          text: "verified",
          evidence: [body],
          delivery: { kind: "pr", url, head },
        }),
      );
      value(
        r.finish(
          claim.record.envelope.id,
          {
            kind: "ok",
            thread_id: parent.durableSessionId,
            message_seq: 1,
            deduplicated: false,
            delivery: { kind: "started", turn_id: "fixture" },
          },
          claim.nativeKey,
        ),
      );
    });
  }
  return { root, bare, git, parent, child, body, state, registry, cli, commit, report, reserve };
}

test("child open pushes both branches, is idempotent, and parent merge checks reported head and uses a merge commit", async () => {
  const w = await world();
  const head = await w.commit(w.child);
  const opened = await w.cli("pr", "open", "--from", "child", "--body-file", w.body, "--draft");
  expect(opened.code).toBe(0);
  expect(opened.result.value).toMatchObject({
    head,
    url: "https://github.test/fixture/repo/pull/1",
  });
  const url = opened.result.value.url;
  expect(
    (await w.cli("pr", "open", "--from", "child", "--body-file", w.body)).result.value,
  ).toEqual(opened.result.value);
  expect(
    (await readFile(`${w.state}.argv`, "utf8")).split("\n").filter((s) => s.includes('"create"')),
  ).toHaveLength(1);
  expect((await w.cli("pr", "merge", "--from", "parent", "--pr", url)).code).toBe(2);
  w.report(url, head);
  const other = w.reserve(true, true);
  w.report("https://github.test/fixture/repo/pull/999", head, other);
  const saved = JSON.parse(await readFile(w.state, "utf8"));
  await writeFile(
    w.state,
    JSON.stringify(saved.map((pr: Record<string, unknown>) => ({ ...pr, baseRefName: "main" }))),
  );
  expect((await w.cli("pr", "merge", "--from", "parent", "--pr", url)).result).toMatchObject({
    ok: false,
    error: { code: "base_mismatch" },
  });
  await writeFile(w.state, JSON.stringify(saved));
  const advanced = await w.commit(w.child, "correction");
  await w.git(w.child.cwd, "push", "origin", "issue-274");
  expect((await w.cli("pr", "merge", "--from", "parent", "--pr", "1")).result).toMatchObject({
    ok: false,
    error: { code: "head_mismatch" },
  });
  w.report(url, advanced);
  expect((await w.cli("pr", "merge", "--from", "parent", "--pr", url)).code).toBe(0);
  const parents = (await w.git(w.parent.cwd, "rev-list", "--parents", "-1", "HEAD")).split(" ");
  expect(parents).toHaveLength(3);
  expect(parents[2]).toBe(advanced);
  expect(await w.git(w.bare, "rev-parse", "integration")).toBe(parents[0] ?? "");
  // Recovery after a successful remote merge but interrupted local fast-forward.
  await w.git(w.parent.cwd, "reset", "--hard", parents[1] ?? "");
  expect((await w.cli("pr", "merge", "--from", "parent", "--pr", url)).code).toBe(0);
  expect(await w.git(w.parent.cwd, "rev-parse", "HEAD")).toBe(parents[0] ?? "");
  expect(await readFile(`${w.state}.argv`, "utf8")).toContain('"--merge","--match-head-commit"');
  expect(
    (await w.cli("pr", "open", "--from", "parent", "--base", "main", "--body-file", w.body)).code,
  ).toBe(0);
  expect(await w.git(w.bare, "rev-parse", "main")).not.toBe(parents[0] ?? "");
}, 30_000);

test.each(["report", "document"] as const)("%s children cannot publish PRs", async (kind) => {
  const w = await world(false, kind);
  expect((await w.cli("pr", "open", "--from", "child", "--body-file", w.body)).code).toBe(2);
  expect(await Bun.file(`${w.state}.argv`).exists()).toBe(false);
  expect(
    (await w.cli("status")).result.value.find((b: Binding) => b.id === "child").deliverable,
  ).toBe(kind);
});

test("close fetches before refusing unpublished parent and child commits, without closing the binding", async () => {
  const w = await world();
  const head = await w.commit(w.child);
  // A fabricated stale tracking ref must not defeat a fetch with pruning.
  await w.git(w.parent.cwd, "update-ref", "refs/remotes/origin/deleted", head);
  for (const id of ["child", "parent"]) {
    expect((await w.cli("close", "--binding", id)).result).toMatchObject({
      ok: false,
      error: { code: "unpushed_commits", details: { unpushedCommits: [head] } },
    });
    expect(w.registry((r) => value(r.get(id))).launchState).toBe("ready");
  }
  // Push from another clone; no local remote-tracking ref exists until close fetches.
  await w.git(w.bare, "fetch", w.parent.cwd, "issue-274:refs/heads/published-elsewhere");
  const result = await w.cli("close", "--binding", "child");
  expect(result.result.error.code).not.toBe("unpushed_commits"); // runtime absent, guard passed
  expect(await w.git(w.parent.cwd, "rev-parse", "origin/published-elsewhere")).toBe(head);
});

test("legacy children reject PR helper and keep local integration, with no fetch guard", async () => {
  const w = await world(true);
  const db = new Database(join(w.root, ".omo/state/registry.sqlite"));
  db.run("UPDATE bindings SET json = json_remove(json, '$.deliverable') WHERE id = 'child'");
  db.close();
  w.registry((r) => {
    const approval = value(r.designation(w.parent.designationId));
    expect(
      r.authorize(w.parent.durableSessionId, {
        version: 1,
        id: "legacy-packet",
        fromBindingId: w.parent.id,
        toBindingId: w.child.id,
        designationId: approval.id,
        snapshotDigest: approval.snapshotDigest,
        kind: "instruction",
        text: "local integration",
        deliverable: "pr",
        evidence: [],
        outcome: null,
      }).ok,
    ).toBe(true);
  });
  await w.commit(w.child);
  expect((await w.cli("pr", "open", "--from", "child", "--body-file", w.body)).code).toBe(2);
  await w.git(
    w.parent.cwd,
    "-c",
    "user.name=QA",
    "-c",
    "user.email=qa@localhost",
    "merge",
    "--no-ff",
    "-m",
    "legacy merge",
    "issue-274",
  );
  await w.git(w.parent.cwd, "remote", "remove", "origin");
  expect((await w.cli("close", "--binding", "child")).result).toMatchObject({
    ok: false,
    error: {
      code: "runtime_unavailable",
      message: "Closure is incomplete; ownership remains held",
    },
  });
});
