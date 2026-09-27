import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Binding, Result, ScopeSnapshot } from "../../src/core/contracts";
import { modelForBinding } from "../../src/core/policy";
import { openRegistry } from "../../src/core/store";
import { checkoutGit } from "../../src/repo/checkout";
import { mergePr } from "../../src/repo/pr";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

test("merge selects the requested PR report when another matching child reported later", async () => {
  const root = await mkdtemp(join(tmpdir(), "olw-pr-report-selection-"));
  roots.push(root);
  const git = (cwd: string, ...args: string[]) => checkoutGit(cwd, args);
  const seed = join(root, "seed");
  await mkdir(seed);
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
  const base = await git(parentPath, "rev-parse", "HEAD");
  await git(parentPath, "worktree", "add", "-b", "issue-274", join(root, "child-one"));
  await git(parentPath, "worktree", "add", "-b", "issue-275", join(root, "child-two"));
  for (const [path, name] of [
    [join(root, "child-one"), "one"],
    [join(root, "child-two"), "two"],
  ] as const) {
    await writeFile(join(path, name), name);
    await git(path, "add", name);
    await git(path, "-c", "user.name=QA", "-c", "user.email=qa@localhost", "commit", "-m", name);
    await git(path, "push", "origin", "HEAD");
  }
  const headOne = await git(join(root, "child-one"), "rev-parse", "HEAD");
  const headTwo = await git(join(root, "child-two"), "rev-parse", "HEAD");
  await mkdir(join(root, ".omo/state"), { recursive: true });
  const dbPath = join(root, ".omo/state/registry.sqlite");
  const registry = openRegistry(dbPath);
  const scope: ScopeSnapshot = {
    version: 1,
    source: "fixture",
    initiative: null,
    decisionRefs: [],
    projects: [
      {
        project: { id: "project", url: "linear://project", revision: "1" },
        issues: [
          { id: "issue-one", key: "LINA-274", url: "linear://one", revision: "1" },
          { id: "issue-two", key: "LINA-275", url: "linear://two", revision: "1" },
        ],
        repository: { remote, defaultBranch: "main" },
      },
    ],
  };
  const digest = value(registry.importScope(scope)).digest;
  const designation = {
    id: "approval",
    snapshotDigest: digest,
    designatedBy: "user",
    designatedAt: "now",
    execute: true,
    create: true,
    contact: true,
  };
  const reserve = (id: string, issueId: string | null, cwd: string, branch: string): Binding => {
    let binding = value(
      registry.reserve({
        bindingId: id,
        durableSessionId: `${id}-session`,
        designation,
        snapshot: scope,
        assignment:
          issueId === null
            ? { role: "parent", initiativeId: null, projectId: "project", ownerBindingId: null }
            : {
                role: "child",
                initiativeId: null,
                projectId: "project",
                issueId,
                ownerBindingId: "parent",
              },
        ...(issueId === null ? {} : { deliverable: "pr" as const }),
        cwd,
        checkout: {
          kind: issueId === null ? "owned-clone" : "linked-worktree",
          remote,
          originalRepoRoot: parentPath,
          path: cwd,
          branch,
          baseBranch: issueId === null ? "main" : "integration",
          baseCommit: base,
        },
        herdrSocket: "/fixture",
        omoSocket: "/fixture",
      }),
    );
    binding = value(registry.provision(binding.id, `ws-${id}`, `pane-${id}`));
    binding = value(registry.observeSession(binding.id, `/fixture/${id}.jsonl`));
    binding = value(
      registry.activate(binding.id, {
        durableSessionId: binding.durableSessionId,
        cwd,
        sessionPath: binding.sessionPath ?? "",
        ...modelForBinding(binding),
        extensionProtocol: 2,
      }),
    );
    value(registry.beginInitialization(binding.id, "fixture"));
    return value(registry.finishInitialization(binding.id, "accepted"));
  };
  const parent = reserve("parent", null, parentPath, "integration");
  const childOne = reserve("child-one", "issue-one", join(root, "child-one"), "issue-274");
  const childTwo = reserve("child-two", "issue-two", join(root, "child-two"), "issue-274");
  const report = (child: Binding, id: string, url: string, head: string) => {
    const claim = value(
      registry.claim(child.durableSessionId, {
        version: 1,
        id,
        fromBindingId: child.id,
        toBindingId: parent.id,
        designationId: designation.id,
        snapshotDigest: digest,
        kind: "report",
        text: "done",
        outcome: "completed",
        evidence: [],
        delivery: { kind: "pr", url, head },
      }),
    );
    value(
      registry.finish(
        id,
        {
          kind: "ok",
          thread_id: parent.durableSessionId,
          message_seq: 1,
          deduplicated: false,
          delivery: { kind: "started", turn_id: id },
        },
        claim.nativeKey,
      ),
    );
  };
  const requested = "https://github.test/fixture/repo/pull/1";
  report(childOne, "report-one", requested, headOne);
  report(childTwo, "report-two", "https://github.test/fixture/repo/pull/2", headTwo);
  registry.close();
  const state = join(root, "gh.json");
  await writeFile(
    state,
    JSON.stringify([
      {
        number: 1,
        url: requested,
        headRefName: "issue-274",
        baseRefName: "integration",
        headRefOid: headOne,
        state: "OPEN",
        isCrossRepository: false,
      },
      {
        number: 2,
        url: "https://github.test/fixture/repo/pull/2",
        headRefName: "issue-275",
        baseRefName: "integration",
        headRefOid: headTwo,
        state: "OPEN",
        isCrossRepository: false,
      },
    ]),
  );
  const shim = join(root, "gh");
  await writeFile(
    shim,
    `#!/bin/sh\nexec '${process.execPath}' '${join(import.meta.dir, "../fixtures/gh-shim.ts")}' "$@"\n`,
  );
  await chmod(shim, 0o700);
  const previous = {
    bin: process.env["OLW_GH_BIN"],
    state: process.env["OLW_TEST_GH_STATE"],
    remote: process.env["OLW_TEST_REMOTE"],
  };
  Object.assign(process.env, { OLW_GH_BIN: shim, OLW_TEST_GH_STATE: state, OLW_TEST_REMOTE: bare });
  const opened = openRegistry(dbPath);
  try {
    expect(await mergePr(opened, parent.id, requested)).toMatchObject({
      ok: true,
      value: { url: requested },
    });
  } finally {
    opened.close();
    for (const [key, value] of Object.entries({
      OLW_GH_BIN: previous.bin,
      OLW_TEST_GH_STATE: previous.state,
      OLW_TEST_REMOTE: previous.remote,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  expect(JSON.parse(await readFile(state, "utf8"))[0]).toMatchObject({ state: "MERGED" });
});
