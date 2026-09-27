import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { loadHerdrBuild } from "../src/herdr/artifact";
import { ensureHerdrBuild } from "../src/herdr/build";
import { type PrepareRunner, prepareUpdate } from "../src/update/prepare";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const branch = "olw/update-omo-5.0.0-0.beta.90-senpi-2026.9.25-1";
const cleanupDetailsSchema = z.object({
  worktree: z.string(),
  outcome: z.looseObject({ ok: z.boolean() }),
});
const mutableCheckSchema = z.object({
  packages: z.record(z.string(), z.looseObject({ state: z.string() })),
});
const devPackage = {
  name: "omo-linear-workflow",
  dependencies: { "@code-yeongyu/senpi": "2026.9.22-4", "omo-ai": "5.0.0-0.beta.84" },
  pnpm: {
    patchedDependencies: {
      "@code-yeongyu/senpi@2026.9.22-4": "patches/@code-yeongyu__senpi@2026.9.22-4.patch",
      "omo-ai@5.0.0-0.beta.84": "patches/omo-ai@5.0.0-0.beta.84.patch",
    },
  },
};

async function prepareFixture(available: { omo?: string; senpi?: string } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "olw-update-prepare-"));
  roots.push(root);
  await writeFile(join(root, "package.json"), JSON.stringify(devPackage));
  await mkdir(join(root, ".omo/state"), { recursive: true });
  await writeFile(
    join(root, ".omo/state/update-check.json"),
    JSON.stringify({
      checkedAt: "2026-09-26T00:00:00.000Z",
      state: "available",
      packages: {
        "omo-ai": {
          state: "update_available",
          pinned: "5.0.0-beta.84",
          available: available.omo ?? "5.0.0-0.beta.90",
          tag: "beta",
        },
        "@code-yeongyu/senpi": {
          state: "update_available",
          pinned: "2026.9.22-4",
          available: available.senpi ?? "2026.9.25-1",
          tag: "latest",
        },
      },
      globalOmo: "5.0.0-0.beta.84",
    }),
  );
  return root;
}

type Reply = { code: number; stdout?: string; stderr?: string };
type Call = { argv: string[]; cwd: string };
/** Stateful fake of git/gh: tracks created worktrees and pushed branch heads like a real remote. */
function fakeRunner(
  overrides: (
    argv: readonly string[],
    cwd: string,
  ) => Promise<Reply | undefined> | Reply | undefined = () => undefined,
  onWorktree?: (path: string) => Promise<void>,
) {
  const calls: Call[] = [];
  const pushed = new Map<string, string>();
  const openPrs = new Set<string>();
  let committedPackage: unknown;
  const run: PrepareRunner = async (argv, options) => {
    calls.push({ argv: [...argv], cwd: options.cwd });
    const override = await overrides(argv, options.cwd);
    if (override) return { stdout: "", stderr: "", ...override };
    const [bin, sub] = argv;
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
    if (bin === "git" && sub === "remote" && argv[2] === "get-url")
      return ok("git@github.com:thisisjun786/omo-linear-workflow.git\n");
    if (bin === "git" && sub === "rev-parse" && argv.includes("FETCH_HEAD")) return ok("abc123\n");
    if (bin === "git" && sub === "rev-parse" && argv.includes("HEAD")) return ok("def456\n");
    if (bin === "git" && sub === "ls-remote") {
      const ref = argv.at(-1)?.replace("refs/heads/", "") ?? "";
      const head = pushed.get(ref);
      return ok(head ? `${head}\trefs/heads/${ref}\n` : "");
    }
    if (bin === "git" && sub === "push") {
      const ref = argv.at(-1)?.replace("HEAD:refs/heads/", "") ?? "";
      pushed.set(ref, "def456");
    }
    if (bin === "git" && sub === "worktree" && argv[2] === "add") {
      const path = argv.at(-2) ?? "";
      // Like git: an existing empty directory is accepted, anything else is refused.
      const entries = await readdir(path).catch(() => undefined);
      if (entries === undefined || entries.length > 0)
        return { code: 128, stdout: "", stderr: `fatal: '${path}' already exists` };
      await writeFile(join(path, "package.json"), JSON.stringify(devPackage, null, 2));
      await onWorktree?.(path);
    }
    if (bin === "git" && sub === "worktree" && argv[2] === "remove")
      await rm(argv.at(-1) ?? "", { recursive: true, force: true });
    if (bin === "git" && sub === "commit")
      committedPackage = JSON.parse(await readFile(join(options.cwd, "package.json"), "utf8"));
    if (sub === "pr" && argv[2] === "list") {
      const head = (argv[argv.indexOf("--head") + 1] ?? "").replace(/^[^:]+:/, "");
      const repository = argv[argv.indexOf("-R") + 1] ?? "thisisjun786/omo-linear-workflow";
      const [owner, name] = repository.split("/");
      return ok(
        openPrs.has(head)
          ? JSON.stringify([
              {
                url: "https://example.test/pull/3",
                headRepository: { name },
                headRepositoryOwner: { login: owner },
              },
            ])
          : "[]",
      );
    }
    if (sub === "pr" && argv[2] === "create") {
      openPrs.add((argv[argv.indexOf("--head") + 1] ?? "").replace(/^[^:]+:/, ""));
      return ok("https://example.test/pull/7\n");
    }
    if (sub === "pr" && argv[2] === "view") {
      const repository = argv[argv.indexOf("-R") + 1] ?? "thisisjun786/omo-linear-workflow";
      const [owner, name] = repository.split("/");
      return ok(
        JSON.stringify({
          url: "https://example.test/pull/7",
          headRepository: { name },
          headRepositoryOwner: { login: owner },
        }),
      );
    }
    return ok();
  };
  return { run, calls, pushed, openPrs, committed: () => committedPackage };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
const prCreate = (calls: Call[]) =>
  calls.find((call) => call.argv[1] === "pr" && call.argv[2] === "create")?.argv;
const ran = (calls: Call[], prefix: string) =>
  calls.some((call) => call.argv.join(" ").startsWith(prefix));

test("all green opens a ready PR to dev from a removed worktree", async () => {
  const root = await prepareFixture();
  const fake = fakeRunner();
  const result = await prepareUpdate(root, { run: fake.run, ghBin: "gh" });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value).toMatchObject({
    action: "opened",
    branch,
    draft: false,
    pr: "https://example.test/pull/7",
  });
  expect(result.value.cleanupErrors).toBeUndefined();
  const argv = fake.calls.map((call) => call.argv.join(" "));
  expect(argv).toContain("git fetch origin dev");
  const worktree = join(root, ".omo/update-worktrees", branch);
  expect(argv).toContain(`git worktree add --detach ${worktree} abc123`);
  expect(argv).toContain(`git push origin HEAD:refs/heads/${branch}`);
  expect(argv).toContain(`git worktree remove --force ${worktree}`);
  const create = prCreate(fake.calls) ?? [];
  expect(create.slice(0, 5)).toEqual([
    "gh",
    "pr",
    "create",
    "-R",
    "thisisjun786/omo-linear-workflow",
  ]);
  expect(create).not.toContain("--draft");
  for (const step of ["pnpm install", "bun run typecheck", "bun test", "bun run build"]) {
    const call = fake.calls.find((item) => item.argv.join(" ").startsWith(step));
    expect(call?.cwd).toBe(worktree);
  }
  expect(fake.committed()).toMatchObject({
    dependencies: { "@code-yeongyu/senpi": "2026.9.25-1", "omo-ai": "5.0.0-0.beta.90" },
    pnpm: {
      patchedDependencies: {
        "@code-yeongyu/senpi@2026.9.25-1": "patches/@code-yeongyu__senpi@2026.9.22-4.patch",
        "omo-ai@5.0.0-0.beta.90": "patches/omo-ai@5.0.0-0.beta.84.patch",
      },
    },
  });
  const commit = fake.calls.find((call) => call.argv[1] === "commit")?.argv ?? [];
  expect(commit).toContain(
    "chore(deps): update omo-ai to 5.0.0-0.beta.90 and senpi to 2026.9.25-1",
  );
  expect(await exists(worktree)).toBe(false);
  expect(await exists(join(root, ".omo/state/update.lock"))).toBe(false);
  const logPath = join(root, ".omo/state/update-prepare", `${branch}.log`);
  expect(await readFile(logPath, "utf8")).toContain(
    "gh pr create -R thisisjun786/omo-linear-workflow --base dev",
  );

  const again = await prepareUpdate(root, { run: fake.run, ghBin: "gh" });
  expect(again.ok && again.value).toMatchObject({
    action: "exists",
    pr: "https://example.test/pull/3",
  });
  expect(await readFile(logPath, "utf8")).toContain(
    "gh pr create -R thisisjun786/omo-linear-workflow --base dev",
  );
});

test("failed patch application opens a draft PR with the failure in the body", async () => {
  const root = await prepareFixture();
  const fake = fakeRunner((argv) =>
    argv[0] === "pnpm"
      ? {
          code: 1,
          stderr:
            "ERR_PNPM_PATCH_FAILED  Could not apply patch /w/patches/omo-ai@5.0.0-0.beta.84.patch to /w/node_modules/omo-ai\n",
        }
      : undefined,
  );
  const result = await prepareUpdate(root, { run: fake.run, ghBin: "gh" });
  expect(result.ok && result.value.action).toBe("opened");
  expect(result.ok && result.value.draft).toBe(true);
  expect(result.ok && result.value.failedPatches).toEqual(["patches/omo-ai@5.0.0-0.beta.84.patch"]);
  const create = prCreate(fake.calls) ?? [];
  expect(create).toContain("--draft");
  const body = create[create.indexOf("--body") + 1] ?? "";
  expect(body).toContain("ERR_PNPM_PATCH_FAILED");
  expect(body).toContain("patches/omo-ai@5.0.0-0.beta.84.patch");
  expect(body).toContain("typecheck: skipped (install failed)");
  expect(body).toContain("test: skipped (install failed)");
  expect(body).toContain("build: skipped (install failed)");
  expect(ran(fake.calls, "bun run typecheck")).toBe(false);
  expect(ran(fake.calls, "bun test")).toBe(false);
  expect(ran(fake.calls, "bun run build")).toBe(false);
  expect(await exists(join(root, ".omo/update-worktrees", branch))).toBe(false);
});

test("an existing branch with an open PR is a no-op", async () => {
  const root = await prepareFixture();
  const fake = fakeRunner();
  fake.pushed.set(branch, "def456");
  fake.openPrs.add(branch);
  const result = await prepareUpdate(root, { run: fake.run, ghBin: "gh" });
  expect(result.ok && result.value).toMatchObject({
    action: "exists",
    pr: "https://example.test/pull/3",
  });
  expect(ran(fake.calls, "git fetch")).toBe(false);
  expect(ran(fake.calls, "git worktree")).toBe(false);
  expect(await exists(join(root, ".omo/state/update.lock"))).toBe(false);
});

test("a pushed branch whose PR creation failed gets its PR on the next run from the record", async () => {
  const root = await prepareFixture();
  let createFails = true;
  const fake = fakeRunner((argv) => {
    if (argv[2] === "create" && createFails) {
      createFails = false;
      return { code: 1, stderr: "HTTP 502" };
    }
    if (argv[0] === "pnpm") return { code: 1, stderr: "ERR_PNPM_PATCH_FAILED patches/x.patch" };
    return undefined;
  });
  const first = await prepareUpdate(root, { run: fake.run, ghBin: "gh" });
  expect(!first.ok && first.error.code).toBe("runtime_unavailable");
  expect(fake.pushed.get(branch)).toBe("def456");
  fake.calls.length = 0;

  const second = await prepareUpdate(root, { run: fake.run, ghBin: "gh" });
  expect(second.ok && second.value).toMatchObject({
    action: "recovered",
    branch,
    pr: "https://example.test/pull/7",
    draft: true,
    failedPatches: ["patches/x.patch"],
  });
  expect(ran(fake.calls, "pnpm")).toBe(false);
  expect(ran(fake.calls, "git worktree")).toBe(false);
  expect(ran(fake.calls, "git push")).toBe(false);
  const create = prCreate(fake.calls) ?? [];
  expect(create.slice(0, 5)).toEqual([
    "gh",
    "pr",
    "create",
    "-R",
    "thisisjun786/omo-linear-workflow",
  ]);
  expect(create).toContain("--draft");
});

test("a pushed branch without a PR or record is re-verified and gets a PR", async () => {
  const root = await prepareFixture();
  const fake = fakeRunner();
  fake.pushed.set(branch, "def456");
  const result = await prepareUpdate(root, { run: fake.run, ghBin: "gh" });
  expect(result.ok && result.value).toMatchObject({ action: "recovered", draft: false });
  const argv = fake.calls.map((call) => call.argv.join(" "));
  expect(argv).toContain(`git fetch origin refs/heads/${branch}`);
  expect(ran(fake.calls, "bun run build")).toBe(true);
  expect(ran(fake.calls, "git push")).toBe(false);
  expect(ran(fake.calls, "git commit")).toBe(false);
  expect(await exists(join(root, ".omo/update-worktrees", branch))).toBe(false);
});

test("a crafted version is rejected before any git or filesystem action", async () => {
  for (const omo of ["x/../../../../victim", "6.0.0-bad..ref", "5.0.0-0.beta.90.lock"]) {
    const root = await prepareFixture({ omo });
    await mkdir(join(root, "victim"));
    await writeFile(join(root, "victim/sentinel"), "keep");
    const fake = fakeRunner();
    const result = await prepareUpdate(root, { run: fake.run, ghBin: "gh" });
    expect(!result.ok && result.error.code).toBe("invalid_input");
    expect(fake.calls).toEqual([]);
    expect(await readFile(join(root, "victim/sentinel"), "utf8")).toBe("keep");
    expect(await exists(join(root, ".omo/state/update.lock"))).toBe(false);
    expect(await exists(join(root, ".omo/update-worktrees"))).toBe(false);
  }
});

test("a path this run did not create is never removed", async () => {
  const root = await prepareFixture();
  const occupied = join(root, ".omo/update-worktrees", branch);
  await mkdir(occupied, { recursive: true });
  await writeFile(join(occupied, "must-survive"), "keep");
  const fake = fakeRunner();
  const result = await prepareUpdate(root, { run: fake.run, ghBin: "gh" });
  expect(!result.ok && result.error.message).toContain("not owned by this run");
  expect(await readFile(join(occupied, "must-survive"), "utf8")).toBe("keep");
  expect(ran(fake.calls, "git worktree")).toBe(false);
  expect(await exists(join(root, ".omo/state/update.lock"))).toBe(false);
});

async function gitRepo(root: string) {
  const git = async (...args: string[]) => {
    const child = Bun.spawn(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    expect(code).toBe(0);
    return stdout;
  };
  await git("init", "-q");
  await git("add", "package.json");
  await git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "fixture");
  return git;
}
/** Real git for worktree commands; hooks run at the base rev-parse and before real worktree add. */
function pausingGitRunner(hooks: {
  afterBase?: (path: string) => Promise<void>;
  beforeAdd?: (path: string) => Promise<void>;
}): PrepareRunner {
  return async (argv, options) => {
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
    const spawn = async (command: readonly string[]) => {
      const child = Bun.spawn([...command], { cwd: options.cwd, stdout: "pipe", stderr: "pipe" });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { code, stdout, stderr };
    };
    if (argv[1] === "pr" && argv[2] === "list") return ok("[]");
    if (argv[0] !== "git") return ok();
    if (argv[1] === "remote" && argv[2] === "get-url")
      return ok("https://github.com/thisisjun786/omo-linear-workflow.git\n");
    if (argv[1] === "rev-parse") {
      const head = await spawn(["git", "rev-parse", "HEAD"]);
      await hooks.afterBase?.(worktreeOf(options.cwd));
      return head;
    }
    if (argv[1] !== "worktree") return ok();
    if (argv[2] === "add") await hooks.beforeAdd?.(argv.at(-2) ?? "");
    return spawn(argv);
  };
}
const worktreeOf = (root: string) => join(root, ".omo/update-worktrees", branch);

test("a foreign directory created after the checks and before the claim survives", async () => {
  const root = await prepareFixture();
  const git = await gitRepo(root);
  const worktree = worktreeOf(root);
  let addCalled = false;
  const result = await prepareUpdate(root, {
    run: pausingGitRunner({
      // Prepare has read remote state and resolved the base; the target path is still absent.
      afterBase: async (path) => {
        expect(await exists(path)).toBe(false);
        await mkdir(path, { recursive: true });
        await writeFile(join(path, "unrelated-must-survive"), "belongs to another actor\n");
      },
      beforeAdd: async () => {
        addCalled = true;
      },
    }),
    ghBin: "gh",
  });
  expect(!result.ok && result.error.code).toBe("runtime_unavailable");
  expect(!result.ok && result.error.message).toContain("not owned by this run");
  expect(addCalled).toBe(false);
  expect(await readFile(join(worktree, "unrelated-must-survive"), "utf8")).toBe(
    "belongs to another actor\n",
  );
  expect(await git("worktree", "list", "--porcelain")).not.toContain("update-worktrees");
  expect(await exists(join(root, ".omo/state/update.lock"))).toBe(false);
});

test("a directory replaced after the claim (different inode) is never deleted", async () => {
  const root = await prepareFixture();
  const git = await gitRepo(root);
  const worktree = worktreeOf(root);
  let claimedInode = 0;
  let replacedInode = 0;
  // At real git worktree add prepare has claimed its empty directory; a foreign actor swaps in a
  // different directory at the same path, which git then refuses.
  const result = await prepareUpdate(root, {
    run: pausingGitRunner({
      beforeAdd: async (path) => {
        expect(path).toBe(worktree);
        expect(await readdir(path)).toEqual([]);
        // Created while the claimed directory still exists, so its inode is necessarily different.
        const staged = `${path}.foreign`;
        await mkdir(staged);
        await writeFile(join(staged, "unrelated-must-survive"), "foreign\n");
        replacedInode = (await stat(staged)).ino;
        claimedInode = (await stat(path)).ino;
        await rm(path, { recursive: true });
        await rename(staged, path);
      },
    }),
    ghBin: "gh",
  });
  expect(!result.ok && result.error.code).toBe("cleanup_incomplete");
  expect(!result.ok && result.error.message).toContain(worktree);
  expect(replacedInode).not.toBe(claimedInode);
  expect(await readFile(join(worktree, "unrelated-must-survive"), "utf8")).toBe("foreign\n");
  expect(await git("worktree", "list", "--porcelain")).not.toContain("update-worktrees");
  expect(await exists(join(root, ".omo/state/update.lock"))).toBe(false);
});

test("a live lock holder yields update_in_progress; a dead one is reclaimed", async () => {
  const root = await prepareFixture();
  const lock = join(root, ".omo/state/update.lock");
  await writeFile(lock, JSON.stringify({ pid: 4242, startedAt: "t", token: "other" }));
  const fake = fakeRunner();
  const busy = await prepareUpdate(root, { run: fake.run, isAlive: () => true });
  expect(!busy.ok && busy.error.code).toBe("update_in_progress");
  expect(fake.calls).toEqual([]);
  expect(await exists(lock)).toBe(true);

  const reclaimed = await prepareUpdate(root, {
    run: fake.run,
    ghBin: "gh",
    isAlive: (pid) => pid !== 4242,
  });
  expect(reclaimed.ok && reclaimed.value.action).toBe("opened");
  expect(await exists(lock)).toBe(false);
});

test("an unparseable lock is reported as corrupt with its path and left in place", async () => {
  const root = await prepareFixture();
  const lock = join(root, ".omo/state/update.lock");
  await writeFile(lock, "{half");
  const fake = fakeRunner();
  const result = await prepareUpdate(root, { run: fake.run });
  expect(!result.ok && result.error.code).toBe("update_lock_corrupt");
  expect(!result.ok && result.error.details).toEqual({ lock });
  expect(await readFile(lock, "utf8")).toBe("{half");
  expect(fake.calls).toEqual([]);
});

test("an unreadable lock during release is reported and left in place", async () => {
  const root = await prepareFixture();
  const lock = join(root, ".omo/state/update.lock");
  const fake = fakeRunner(async (argv) => {
    if (argv[1] !== "pr" || argv[2] !== "list") return undefined;
    await rm(lock);
    await mkdir(lock);
    return {
      code: 0,
      stdout: JSON.stringify([
        {
          url: "https://example.test/pull/3",
          headRepository: { name: "omo-linear-workflow" },
          headRepositoryOwner: { login: "thisisjun786" },
        },
      ]),
    };
  });
  fake.pushed.set(branch, "def456");

  const result = await prepareUpdate(root, { run: fake.run, ghBin: "gh" });

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.action).toBe("exists");
  expect(result.value.cleanupErrors).toHaveLength(1);
  expect(result.value.cleanupErrors?.[0]).toMatch(/^lock release: .*EISDIR/);
  expect((await stat(lock)).isDirectory()).toBe(true);
});

test("thrown runner errors still remove the worktree and release the lock", async () => {
  const root = await prepareFixture();
  const fake = fakeRunner((argv) => {
    if (argv[0] === "bun" && argv[2] === "build") throw new Error("spawn exploded");
    return undefined;
  });
  const result = await prepareUpdate(root, { run: fake.run, ghBin: "gh" });
  expect(!result.ok && result.error.message).toContain("spawn exploded");
  expect(ran(fake.calls, "git worktree remove")).toBe(true);
  expect(await exists(join(root, ".omo/update-worktrees", branch))).toBe(false);
  expect(await exists(join(root, ".omo/state/update.lock"))).toBe(false);
  expect(prCreate(fake.calls)).toBeUndefined();
});

test("each cleanup step fails independently and the lock is still released", async () => {
  const root = await prepareFixture();
  await writeFile(join(root, ".omo/state/update-prepare"), "not a directory");
  const fake = fakeRunner((argv) =>
    argv[1] === "worktree" && argv[2] === "remove" ? { code: 1, stderr: "busy" } : undefined,
  );
  const result = await prepareUpdate(root, { run: fake.run, ghBin: "gh" });
  expect(result.ok && result.value.action).toBe("opened");
  const errors = (result.ok && result.value.cleanupErrors) || [];
  expect(errors.some((error) => error.startsWith("git worktree remove"))).toBe(true);
  expect(errors.some((error) => error.startsWith("log") && error.includes("ENOTDIR"))).toBe(true);
  expect(ran(fake.calls, "git worktree prune")).toBe(true);
  expect(await exists(join(root, ".omo/update-worktrees", branch))).toBe(false);
  expect(await exists(join(root, ".omo/state/update.lock"))).toBe(false);
});

test("an owned worktree that cannot be removed or pruned yields cleanup_incomplete", async () => {
  const root = await prepareFixture();
  const worktree = join(root, ".omo/update-worktrees", branch);
  const fake = fakeRunner((argv) => {
    if (argv[1] !== "worktree") return undefined;
    if (argv[2] === "list")
      return { code: 0, stdout: `worktree ${root}\n\nworktree ${worktree}\n` };
    if (argv[2] === "remove" || argv[2] === "prune") return { code: 1, stderr: "locked" };
    return undefined;
  });
  const result = await prepareUpdate(root, { run: fake.run, ghBin: "gh" });
  expect(!result.ok && result.error.code).toBe("cleanup_incomplete");
  if (result.ok) return;
  const details = cleanupDetailsSchema.parse(result.error.details);
  expect(details.worktree).toBe(worktree);
  expect(details.outcome.ok).toBe(true);
  expect(!result.ok && result.error.message).toContain(`worktree remove --force ${worktree}`);
  expect(await exists(join(root, ".omo/state/update.lock"))).toBe(false);
});

test("a named GitHub remote scopes lookup, creation and head verification to its repository", async () => {
  const root = await prepareFixture();
  const fake = fakeRunner((argv) => {
    if (argv.join(" ") === "git remote get-url fork")
      return { code: 0, stdout: "git@github.com:contributor/project.git\n" };
    if (argv[1] === "pr" && argv[2] === "view")
      return {
        code: 0,
        stdout: JSON.stringify({
          url: "https://example.test/pull/7",
          headRepository: { name: "project" },
          headRepositoryOwner: { login: "contributor" },
        }),
      };
    return undefined;
  });

  const result = await prepareUpdate(root, { run: fake.run, remote: "fork", ghBin: "gh-shim" });

  expect(result.ok && result.value.action).toBe("opened");
  const list = fake.calls.find((call) => call.argv[2] === "list")?.argv ?? [];
  expect(list).toContain("-R");
  expect(list[list.indexOf("-R") + 1]).toBe("contributor/project");
  const create = prCreate(fake.calls) ?? [];
  expect(create[create.indexOf("-R") + 1]).toBe("contributor/project");
  expect(create[create.indexOf("--head") + 1]).toBe(`contributor:${branch}`);
  const view = fake.calls.find((call) => call.argv[2] === "view")?.argv ?? [];
  expect(view[view.indexOf("-R") + 1]).toBe("contributor/project");
});

test("a non-GitHub remote fails before push", async () => {
  const root = await prepareFixture();
  const fake = fakeRunner((argv) =>
    argv.join(" ") === "git remote get-url mirror"
      ? { code: 0, stdout: "ssh://git@gitlab.example.com/owner/project.git\n" }
      : undefined,
  );

  const result = await prepareUpdate(root, { run: fake.run, remote: "mirror" });

  expect(result).toMatchObject({ ok: false, error: { code: "unsupported_remote" } });
  expect(ran(fake.calls, "git push")).toBe(false);
  expect(fake.calls.some((call) => call.argv[1] === "pr")).toBe(false);
});

test("custom remote and gh binary are used", async () => {
  const root = await prepareFixture();
  const fake = fakeRunner();
  const result = await prepareUpdate(root, {
    run: fake.run,
    remote: "https://github.com/contributor/project.git",
    ghBin: "/tmp/gh-shim",
  });
  expect(result.ok && result.value.pr).toBe("https://example.test/pull/7");
  const argv = fake.calls.map((call) => call.argv.join(" "));
  expect(argv).toContain("git fetch https://github.com/contributor/project.git dev");
  expect(argv).toContain(
    `git push https://github.com/contributor/project.git HEAD:refs/heads/${branch}`,
  );
  expect(prCreate(fake.calls)?.[0]).toBe("/tmp/gh-shim");
});

test("no newer versions in the latest check prepares nothing", async () => {
  const root = await prepareFixture();
  const path = join(root, ".omo/state/update-check.json");
  const check = mutableCheckSchema.parse(JSON.parse(await readFile(path, "utf8")));
  for (const item of Object.values(check.packages)) item.state = "current";
  await writeFile(path, JSON.stringify(check));
  const fake = fakeRunner();
  const result = await prepareUpdate(root, { run: fake.run });
  expect(result.ok && result.value.action).toBe("up_to_date");
  expect(fake.calls).toEqual([]);
});

const hash = (text: string | Uint8Array) =>
  new Bun.CryptoHasher("sha256").update(text).digest("hex");
async function herdrVendor(dir: string) {
  await writeFile(
    join(dir, "herdr-release.json"),
    JSON.stringify({
      schemaVersion: 1,
      version: "0.9.1",
      assets: {
        [`${process.platform}-${process.arch}`]: {
          name: "herdr-linux-x86_64",
          sha256: hash("#!/bin/sh\nexit 0\n"),
        },
      },
    }),
  );
}
async function tree(dir: string): Promise<string[]> {
  return (await readdir(dir, { recursive: true })).map(String).sort();
}

test("a worktree download without a managed release never writes into the root Herdr dir", async () => {
  const root = await prepareFixture();
  await herdrVendor(root);
  await mkdir(join(root, ".omo/herdr"), { recursive: true });

  const before = await tree(join(root, ".omo/herdr"));
  let buildError = "";
  let published = false;
  const fake = fakeRunner(
    async (argv, cwd) => {
      if (argv[0] !== "bun" || argv[2] !== "build") return undefined;
      // The real managed-build entry point, run against the update worktree.
      try {
        await ensureHerdrBuild(cwd, { download: async () => new Response("tampered") });
      } catch (cause) {
        buildError = String(cause);
      }
      published = await Bun.file((await loadHerdrBuild(cwd)).binaryPath).exists();
      return { code: 1, stderr: buildError };
    },
    (path) => herdrVendor(path),
  );
  const result = await prepareUpdate(root, { run: fake.run, ghBin: "gh" });
  expect(result.ok && result.value.draft).toBe(true);
  expect(buildError).toContain("SHA256 mismatch");
  expect(published).toBe(false);
  expect(await tree(join(root, ".omo/herdr"))).toEqual(before);
});

test("a verified root Herdr artifact is copied, not linked, into the worktree", async () => {
  const root = await prepareFixture();
  await herdrVendor(root);
  const build = await loadHerdrBuild(root);
  const executable = "#!/bin/sh\nexit 0\n";
  await mkdir(build.artifactDir, { recursive: true });
  await writeFile(build.binaryPath, executable, { mode: 0o700 });

  const before = await tree(join(root, ".omo/herdr"));
  let reused = "";
  const fake = fakeRunner(
    async (argv, cwd) => {
      if (argv[0] !== "bun" || argv[2] !== "build") return undefined;
      const { lstat } = await import("node:fs/promises");
      expect((await lstat(join(cwd, ".omo/herdr"))).isSymbolicLink()).toBe(false);
      reused = (
        await ensureHerdrBuild(cwd, {
          download: async () => {
            throw new Error("network called");
          },
        })
      ).binaryPath;
      return { code: 0 };
    },
    (path) => herdrVendor(path),
  );
  const result = await prepareUpdate(root, { run: fake.run, ghBin: "gh" });
  expect(result.ok ? result.value.draft : result.error).toBe(false);
  expect(dirname(dirname(dirname(reused)))).toBe(
    join(root, ".omo/update-worktrees", branch, ".omo/herdr"),
  );
  expect(await tree(join(root, ".omo/herdr"))).toEqual(before);
});

async function interruptChild(root: string, mode: "install" | "add") {
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "fixtures/update-prepare-interrupt.ts"),
      root,
      branch,
      mode,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  const readUntil = async (token: string) => {
    while (!output.includes(token)) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`child exited before ${token}: ${output}`);
      output += decoder.decode(chunk.value);
    }
  };
  const bounded = <T>(promise: Promise<T>, label: string) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 10_000);
      }),
    ]).finally(() => clearTimeout(timer));
  };
  const worktree = join(root, ".omo/update-worktrees", branch);
  try {
    await bounded(readUntil("READY "), "READY");
    expect(await exists(worktree)).toBe(true);
    expect(await exists(join(root, ".omo/state/update.lock"))).toBe(true);
    child.kill("SIGINT");
    await bounded(readUntil("RESULT "), "RESULT");
    expect(await bounded(child.exited, "exit")).toBe(130);
    const result = JSON.parse(output.slice(output.indexOf("RESULT ") + 7).split("\n")[0] ?? "");
    expect(result.error.code).toBe("interrupted");
    expect(result.error.details.signal).toBe("SIGINT");
    expect(await exists(worktree)).toBe(false);
    expect(await exists(join(root, ".omo/state/update.lock"))).toBe(false);
    expect(output).toContain("REMOVED ");
  } finally {
    child.kill("SIGKILL");
  }
}

test("SIGINT during prepare removes the created worktree and releases the lock", async () => {
  await interruptChild(await prepareFixture(), "install");
});

test("SIGINT while real git worktree add is running removes the registered worktree", async () => {
  const root = await prepareFixture();
  const git = await gitRepo(root);
  await interruptChild(root, "add");
  expect(await git("worktree", "list", "--porcelain")).not.toContain("update-worktrees");
});
