import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import type { Result } from "../core/contracts";
import { loadHerdrBuild, resolveHerdrArtifact } from "../herdr/artifact";

export type PrepareRunner = (
  argv: readonly string[],
  options: { readonly cwd: string; readonly timeoutMs: number; readonly signal?: AbortSignal },
) => Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>;

export interface PrepareStep {
  readonly name: string;
  readonly command: string;
  readonly code: number;
  readonly tail: string;
}
export interface PrepareResult {
  /** `recovered`: the branch was already pushed without an open PR, and the PR was created now. */
  readonly action: "opened" | "recovered" | "exists" | "up_to_date";
  readonly branch: string | null;
  readonly pr: string | null;
  readonly draft?: boolean;
  readonly versions?: { readonly omo: string; readonly senpi: string };
  readonly steps?: readonly PrepareStep[];
  readonly failedPatches?: readonly string[];
  readonly log?: string;
  /** Cleanup actions that failed after the outcome was decided; the lock release is always attempted. */
  readonly cleanupErrors?: readonly string[];
}
export interface PrepareOptions {
  readonly run?: PrepareRunner;
  /** Git remote name or URL; default `origin`. */
  readonly remote?: string;
  /** PR command; default `OLW_GH_BIN` or `gh`. */
  readonly ghBin?: string;
  /** OLW root whose verified managed Herdr artifact is copied into the update worktree; default `root`. */
  readonly herdrRoot?: string;
  readonly isAlive?: (pid: number) => boolean;
  readonly now?: () => string;
}

const OMO = "omo-ai";
const SENPI = "@code-yeongyu/senpi";
/** Strict semver: numeric core, dot-separated non-empty prerelease identifiers, no path or ref syntax. */
const versionPattern =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const checkSchema = z.object({
  packages: z.record(
    z.string(),
    z.object({ state: z.string(), pinned: z.string(), available: z.string().nullable() }),
  ),
});
const lockSchema = z.object({ pid: z.number().int(), token: z.string() });
const manifestSchema = z.object({
  dependencies: z.record(z.string(), z.string()),
  pnpm: z.object({ patchedDependencies: z.record(z.string(), z.string()).optional() }).optional(),
});
const prListSchema = z.array(z.object({ url: z.string() }));
const stepSchema = z.object({
  name: z.string(),
  command: z.string(),
  code: z.number().int(),
  tail: z.string(),
});
const recordSchema = z.object({
  branch: z.string(),
  head: z.string(),
  base: z.string(),
  from: z.object({ omo: z.string(), senpi: z.string() }),
  steps: z.array(stepSchema),
  failedPatches: z.array(z.string()),
});
type Outcome = z.infer<typeof recordSchema>;

const minute = 60_000;
const steps = [
  {
    name: "pnpm install",
    argv: ["pnpm", "install", "--no-frozen-lockfile"],
    timeoutMs: 15 * minute,
  },
  { name: "typecheck", argv: ["bun", "run", "typecheck"], timeoutMs: 10 * minute },
  { name: "test", argv: ["bun", "test"], timeoutMs: 20 * minute },
  { name: "build", argv: ["bun", "run", "build"], timeoutMs: 45 * minute },
] as const;

const spawnRunner: PrepareRunner = async (argv, { cwd, timeoutMs, signal }) => {
  const child = Bun.spawn([...argv], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const kill = () => child.kill();
  const timer = setTimeout(kill, timeoutMs);
  signal?.addEventListener("abort", kill, { once: true });
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", kill);
  }
};

class Interrupted extends Error {
  constructor(readonly signal: NodeJS.Signals) {
    super(`olw update prepare interrupted by ${signal}`);
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return errorCode(cause) === "EPERM";
  }
}
function errorCode(cause: unknown): unknown {
  return cause instanceof Error && "code" in cause ? cause.code : undefined;
}
function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
function versionOrder(a: string, b: string): number | null {
  if (!versionPattern.test(a) || !versionPattern.test(b)) return null;
  try {
    return Bun.semver.order(a, b);
  } catch {
    return null;
  }
}
function checkedPinMatches(name: string, checked: string, current: string): boolean {
  if (checked === current) return true;
  // Early OMO beta receipts used npm's display alias before the manifest moved to the exact
  // prerelease identifier. Preserve those already-issued receipts; all current checks are exact.
  return name === OMO && checked.replace("-beta.", "-0.beta.") === current;
}
function fail<T>(code: string, message: string, details?: unknown): Result<T> {
  return details === undefined
    ? { ok: false, error: { code, message } }
    : { ok: false, error: { code, message, details } };
}
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return false;
    throw cause;
  }
}
function inside(parent: string, path: string): boolean {
  const rel = relative(parent, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
function tail(text: string, lines = 30, chars = 3000): string {
  const kept = text.trimEnd().split("\n").slice(-lines).join("\n");
  return kept.length > chars ? kept.slice(-chars) : kept;
}
export function failedPatchesOf(output: string): string[] {
  const found = new Set<string>();
  for (const line of output.split("\n")) {
    if (!/ERR_PNPM_PATCH|could not apply patch|patch.*fail|fail.*patch/i.test(line)) continue;
    for (const match of line.matchAll(/patches\/[^\s'":]+\.patch/g)) found.add(match[0]);
  }
  return [...found];
}

type Lock = { release: () => Promise<void> };
async function acquireLock(
  path: string,
  isAlive: (pid: number) => boolean,
  now: string,
): Promise<Result<Lock>> {
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(path, `${JSON.stringify({ pid: process.pid, startedAt: now, token })}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      return {
        ok: true,
        value: {
          release: async () => {
            let raw: string;
            try {
              raw = await readFile(path, "utf8");
            } catch (cause) {
              if (errorCode(cause) === "ENOENT") return;
              throw cause;
            }
            const held = lockSchema.parse(JSON.parse(raw));
            if (held.token === token) await rm(path, { force: true });
          },
        },
      };
    } catch (cause) {
      if (errorCode(cause) !== "EEXIST") throw cause;
      let raw: string;
      try {
        raw = await readFile(path, "utf8");
      } catch (readCause) {
        if (errorCode(readCause) === "ENOENT") continue;
        throw readCause;
      }
      let holder: z.infer<typeof lockSchema> | undefined;
      try {
        const parsed = lockSchema.safeParse(JSON.parse(raw));
        if (parsed.success) holder = parsed.data;
      } catch {
        holder = undefined;
      }
      if (holder === undefined)
        return fail(
          "update_lock_corrupt",
          `The update lock ${path} is unreadable; confirm no olw update prepare is running, then delete it`,
          { lock: path },
        );
      if (isAlive(holder.pid) || attempt > 0)
        return fail("update_in_progress", "Another olw update prepare holds the update lock", {
          lock: path,
          pid: holder.pid,
        });
      await rm(path, { force: true });
    }
  }
  return fail("update_in_progress", "Could not acquire the update lock", { lock: path });
}

function rewriteManifest(text: string, targets: Record<string, string>): string {
  const manifest = manifestSchema.parse(JSON.parse(text));
  let next = text;
  const replace = (from: string, to: string) => {
    if (!next.includes(from)) throw new Error(`package.json has no ${from}`);
    next = next.replace(from, to);
  };
  for (const [name, version] of Object.entries(targets)) {
    const current = manifest.dependencies[name];
    if (current === undefined) throw new Error(`package.json does not pin ${name}`);
    if (current !== version) replace(`"${name}": "${current}"`, `"${name}": "${version}"`);
    for (const key of Object.keys(manifest.pnpm?.patchedDependencies ?? {}))
      if (key.startsWith(`${name}@`) && key !== `${name}@${version}`)
        replace(`"${key}":`, `"${name}@${version}":`);
  }
  const check = manifestSchema.parse(JSON.parse(next));
  for (const [name, version] of Object.entries(targets))
    if (check.dependencies[name] !== version) throw new Error(`Could not pin ${name}@${version}`);
  return next;
}

function prBody(outcome: Outcome, versions: { omo: string; senpi: string }, note: string): string {
  const green = outcome.steps.every((step) => step.code === 0);
  return [
    "## What",
    "",
    `Pins omo-ai \`${outcome.from.omo}\` -> \`${versions.omo}\` and @code-yeongyu/senpi \`${outcome.from.senpi}\` -> \`${versions.senpi}\`, renaming the \`pnpm.patchedDependencies\` keys to the new versions. ${note}`,
    "",
    "## How it was verified",
    "",
    ...outcome.steps.flatMap((step) => [
      `### \`${step.command}\`: exit ${step.code}`,
      "",
      "```",
      step.tail,
      "```",
      "",
    ]),
    "## Patches",
    "",
    outcome.failedPatches.length
      ? `These patches did not apply to the new versions: ${outcome.failedPatches.map((path) => `\`${path}\``).join(", ")}. Regenerating them is a human step (see docs/runtime-patches.md); this PR stays draft until they are regenerated and every step passes.`
      : green
        ? "All patches applied."
        : "No patch failure was detected; see the failing step above.",
    "",
    "## Compatibility",
    "",
    "Dependency pin update only; the global OMO is not modified.",
  ].join("\n");
}

/** Prepare a dev pull request that moves the pinned OMO and Senpi to the latest checked versions. */
export async function prepareUpdate(
  root: string,
  options: PrepareOptions = {},
): Promise<Result<PrepareResult>> {
  const run = options.run ?? spawnRunner;
  const remote = options.remote ?? "origin";
  if (remote.startsWith("-")) return fail("invalid_input", "Git remote must not start with '-'");
  const gh = options.ghBin ?? process.env["OLW_GH_BIN"] ?? "gh";
  const now = options.now ?? (() => new Date().toISOString());
  const resolvedRoot = resolve(root);

  // Validate every input that becomes a ref or path before any lock, git or filesystem action.
  let check: z.infer<typeof checkSchema>;
  let pins: z.infer<typeof manifestSchema>;
  try {
    check = checkSchema.parse(
      JSON.parse(await readFile(join(resolvedRoot, ".omo/state/update-check.json"), "utf8")),
    );
    pins = manifestSchema.parse(
      JSON.parse(await readFile(join(resolvedRoot, "package.json"), "utf8")),
    );
  } catch (cause) {
    return fail("update_check_missing", `Run olw update check first: ${messageOf(cause)}`);
  }
  for (const name of [OMO, SENPI] as const) {
    const item = check.packages[name];
    const current = pins.dependencies[name];
    if (item === undefined || current === undefined)
      return fail(
        "update_check_missing",
        "package.json and the update check must include both pins",
      );
    if (!checkedPinMatches(name, item.pinned, current))
      return fail(
        "update_check_stale",
        `The update check is stale for ${name}; rerun olw update check`,
        { package: name, checked: item.pinned, current },
      );
  }
  const target = (name: string) => {
    const item = check.packages[name];
    return item?.state === "update_available" && item.available
      ? item.available
      : pins.dependencies[name];
  };
  const omo = target(OMO);
  const senpi = target(SENPI);
  if (omo === undefined || senpi === undefined)
    return fail("update_check_missing", "package.json does not pin omo-ai and Senpi");
  for (const [name, version] of [
    [OMO, omo],
    [SENPI, senpi],
  ] as const)
    if (!versionPattern.test(version) || version.endsWith(".lock"))
      return fail(
        "invalid_input",
        `Refusing non-semver ${name} version ${JSON.stringify(version)}`,
      );
  const versions = { omo, senpi };
  const from = { omo: pins.dependencies[OMO] ?? "", senpi: pins.dependencies[SENPI] ?? "" };
  for (const [name, current, selected] of [
    [OMO, from.omo, omo],
    [SENPI, from.senpi, senpi],
  ] as const) {
    if (selected !== current && versionOrder(selected, current) !== 1)
      return fail(
        "update_not_newer",
        `Refusing to replace ${name} ${current} with non-newer version ${selected}`,
      );
  }
  if (omo === from.omo && senpi === from.senpi)
    return { ok: true, value: { action: "up_to_date", branch: null, pr: null, versions } };
  const branch = `olw/update-omo-${omo}-senpi-${senpi}`;
  const worktreesDir = join(resolvedRoot, ".omo/update-worktrees");
  const logDir = join(resolvedRoot, ".omo/state/update-prepare");
  const worktreePath = resolve(worktreesDir, branch);
  const logPath = resolve(logDir, `${branch}.log`);
  const recordPath = resolve(logDir, `${branch}.json`);
  if (
    !inside(worktreesDir, worktreePath) ||
    !inside(logDir, logPath) ||
    !inside(logDir, recordPath)
  )
    return fail("invalid_input", `Update paths for ${branch} escape .omo`);

  const lockPath = join(resolvedRoot, ".omo/state/update.lock");
  const lock = await acquireLock(lockPath, options.isAlive ?? pidAlive, now());
  if (!lock.ok) return lock;

  const abort = new AbortController();
  let interrupted: NodeJS.Signals | undefined;
  const onSignal = (signal: NodeJS.Signals) => {
    if (interrupted !== undefined) return;
    interrupted = signal;
    abort.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const log: string[] = [`# olw update prepare ${now()} remote=${remote}`];
  // The update worktree directory this run created exclusively. Device and inode identify it; the
  // birth time also catches a same-inode recreation where the filesystem reports it (0 otherwise).
  let owned:
    | { readonly path: string; readonly dev: bigint; readonly ino: bigint; readonly birth: bigint }
    | undefined;
  const exec = async (argv: readonly string[], cwd: string, timeoutMs = 5 * minute) => {
    if (interrupted !== undefined) throw new Interrupted(interrupted);
    log.push(`$ (${cwd}) ${argv.join(" ")}`);
    const result = await run(argv, { cwd, timeoutMs, signal: abort.signal });
    log.push(`exit ${result.code}`, result.stdout.trimEnd(), result.stderr.trimEnd());
    if (interrupted !== undefined) throw new Interrupted(interrupted);
    return result;
  };
  const cleanupExec = async (argv: readonly string[]) => {
    log.push(`$ (${resolvedRoot}) ${argv.join(" ")}`);
    const result = await run(argv, { cwd: resolvedRoot, timeoutMs: minute });
    log.push(`exit ${result.code}`, result.stdout.trimEnd(), result.stderr.trimEnd());
    if (result.code !== 0) throw new Error(`${argv.join(" ")} exited ${result.code}`);
    return result.stdout;
  };
  const addWorktree = async (ref: string): Promise<string> => {
    await mkdir(join(worktreePath, ".."), { recursive: true });
    // Exclusive creation is the ownership claim: EEXIST means another actor owns the path. Git adds
    // the worktree into this empty directory, so an interrupted add still leaves only our inode.
    try {
      await mkdir(worktreePath, { mode: 0o700 });
    } catch (cause) {
      if (errorCode(cause) === "EEXIST")
        throw new Error(
          `The update worktree path ${worktreePath} already exists and is not owned by this run; inspect it, then remove it with git worktree remove or by hand`,
        );
      throw cause;
    }
    const created = await stat(worktreePath, { bigint: true });
    owned = {
      path: worktreePath,
      dev: created.dev,
      ino: created.ino,
      birth: created.birthtimeNs,
    };
    const added = await exec(
      ["git", "worktree", "add", "--detach", worktreePath, ref],
      resolvedRoot,
    );
    if (added.code !== 0) throw new Error(`git worktree add failed: ${tail(added.stderr)}`);
    await copyHerdrArtifact(options.herdrRoot ?? resolvedRoot, worktreePath, log);
    return worktreePath;
  };
  const verify = async (worktree: string) => {
    const results: PrepareStep[] = [];
    let installOutput = "";
    for (const step of steps) {
      const result = await exec(step.argv, worktree, step.timeoutMs);
      const output = `${result.stdout}\n${result.stderr}`;
      if (step.name === "pnpm install") installOutput = output;
      results.push({
        name: step.name,
        command: step.argv.join(" "),
        code: result.code,
        tail: tail(output),
      });
    }
    return { steps: results, failedPatches: failedPatchesOf(installOutput) };
  };
  const createPr = async (outcome: Outcome, action: "opened" | "recovered", note: string) => {
    const green = outcome.steps.every((step) => step.code === 0);
    const subject = `chore(deps): update omo-ai to ${omo} and senpi to ${senpi}`;
    const created = await exec(
      [
        gh,
        "pr",
        "create",
        "--base",
        "dev",
        "--head",
        branch,
        "--title",
        subject,
        "--body",
        prBody(outcome, versions, note),
        ...(green ? [] : ["--draft"]),
      ],
      resolvedRoot,
    );
    if (created.code !== 0)
      return fail<PrepareResult>(
        "runtime_unavailable",
        `${gh} pr create failed after pushing ${branch}; rerun olw update prepare to retry`,
        { branch, stderr: tail(created.stderr) },
      );
    return {
      ok: true as const,
      value: {
        action,
        branch,
        pr: created.stdout.trim().split("\n").at(-1) ?? null,
        draft: !green,
        versions,
        steps: outcome.steps,
        failedPatches: outcome.failedPatches,
        log: logPath,
      } satisfies PrepareResult,
    };
  };
  const readRecord = async (head: string): Promise<Outcome | undefined> => {
    try {
      const record = recordSchema.parse(JSON.parse(await readFile(recordPath, "utf8")));
      return record.head === head && record.branch === branch ? record : undefined;
    } catch (cause) {
      log.push(`no usable outcome record: ${messageOf(cause)}`);
      return undefined;
    }
  };

  const body = async (): Promise<Result<PrepareResult>> => {
    const remoteRef = await exec(
      ["git", "ls-remote", "--heads", remote, `refs/heads/${branch}`],
      resolvedRoot,
    );
    if (remoteRef.code !== 0)
      return fail("runtime_unavailable", `git ls-remote ${remote} failed`, {
        stderr: tail(remoteRef.stderr),
      });
    const listed = await exec(
      [gh, "pr", "list", "--head", branch, "--state", "open", "--json", "url"],
      resolvedRoot,
    );
    if (listed.code !== 0)
      return fail("runtime_unavailable", `${gh} pr list failed`, { stderr: tail(listed.stderr) });
    const open = prListSchema.parse(JSON.parse(listed.stdout || "[]"));
    if (open.length > 0)
      return {
        ok: true,
        value: { action: "exists", branch, pr: open[0]?.url ?? null, versions, log: logPath },
      };

    const pushedHead = remoteRef.stdout.trim().split(/\s+/)[0];
    if (pushedHead) {
      // Pushed earlier without an open PR: recreate it from the recorded outcome, or re-verify.
      const recorded = await readRecord(pushedHead);
      if (recorded)
        return createPr(
          recorded,
          "recovered",
          `Recovered by \`olw update prepare\` from the recorded checks of ${pushedHead}.`,
        );
      const fetched = await exec(["git", "fetch", remote, `refs/heads/${branch}`], resolvedRoot);
      if (fetched.code !== 0)
        return fail("runtime_unavailable", `git fetch ${remote} ${branch} failed`, {
          stderr: tail(fetched.stderr),
        });
      const head = await exec(["git", "rev-parse", "FETCH_HEAD"], resolvedRoot);
      if (head.code !== 0) return fail("runtime_unavailable", "git rev-parse FETCH_HEAD failed");
      const worktree = await addWorktree(head.stdout.trim());
      const outcome: Outcome = {
        branch,
        head: head.stdout.trim(),
        base: "unknown",
        from,
        ...(await verify(worktree)),
      };
      return createPr(
        outcome,
        "recovered",
        `Re-verified by \`olw update prepare\` at pushed head ${outcome.head}.`,
      );
    }

    const fetched = await exec(["git", "fetch", remote, "dev"], resolvedRoot);
    const base =
      fetched.code === 0 ? await exec(["git", "rev-parse", "FETCH_HEAD"], resolvedRoot) : fetched;
    if (base.code !== 0)
      return fail("runtime_unavailable", `git fetch ${remote} dev failed`, {
        stderr: tail(fetched.stderr),
      });
    const baseSha = base.stdout.trim();
    const worktree = await addWorktree(baseSha);
    const manifestPath = join(worktree, "package.json");
    await writeFile(
      manifestPath,
      rewriteManifest(await readFile(manifestPath, "utf8"), { [OMO]: omo, [SENPI]: senpi }),
    );
    const verified = await verify(worktree);
    const subject = `chore(deps): update omo-ai to ${omo} and senpi to ${senpi}`;
    const checkLog = [
      `Update check: ${JSON.stringify(check.packages)}`,
      ...verified.steps.map((step) => `${step.command}: exit ${step.code}`),
      verified.failedPatches.length
        ? `Failed patches: ${verified.failedPatches.join(", ")}`
        : "Failed patches: none",
    ].join("\n");
    const staged = await exec(["git", "add", "package.json", "pnpm-lock.yaml"], worktree);
    if (staged.code !== 0)
      return fail("runtime_unavailable", "git add failed", { stderr: tail(staged.stderr) });
    const committed = await exec(["git", "commit", "-m", subject, "-m", checkLog], worktree);
    if (committed.code !== 0)
      return fail("runtime_unavailable", "git commit failed", { stderr: tail(committed.stderr) });
    const head = await exec(["git", "rev-parse", "HEAD"], worktree);
    if (head.code !== 0) return fail("runtime_unavailable", "git rev-parse HEAD failed");
    const outcome: Outcome = { branch, head: head.stdout.trim(), base: baseSha, from, ...verified };
    try {
      await mkdir(logDir, { recursive: true, mode: 0o700 });
      await mkdir(join(recordPath, ".."), { recursive: true, mode: 0o700 });
      await writeFile(recordPath, `${JSON.stringify(outcome, null, 2)}\n`, { mode: 0o600 });
    } catch (cause) {
      // A missing record only means a later recovery re-runs the checks.
      log.push(`outcome record not written: ${messageOf(cause)}`);
    }
    const pushed = await exec(["git", "push", remote, `HEAD:refs/heads/${branch}`], worktree);
    if (pushed.code !== 0)
      return fail("runtime_unavailable", `git push ${remote} failed`, {
        stderr: tail(pushed.stderr),
      });
    return createPr(
      outcome,
      "opened",
      `Prepared by \`olw update prepare\` from dev \`${baseSha}\`.`,
    );
  };

  let result: Result<PrepareResult>;
  try {
    result = await body();
  } catch (cause) {
    log.push(`error ${messageOf(cause)}`);
    result =
      cause instanceof Interrupted
        ? fail("interrupted", cause.message, { signal: cause.signal, log: logPath })
        : fail("runtime_unavailable", messageOf(cause), { log: logPath });
  }

  const cleanupErrors: string[] = [];
  const attempt = async (label: string, action: () => Promise<void>) => {
    try {
      await action();
    } catch (cause) {
      cleanupErrors.push(`${label}: ${messageOf(cause)}`);
    }
  };
  let leftover: string | undefined;
  if (owned !== undefined) {
    const { path } = owned;
    const identity = owned;
    // "ours": still the directory this run created; "foreign": replaced by someone else.
    const state = async (): Promise<"ours" | "gone" | "foreign"> => {
      try {
        const current = await lstat(path, { bigint: true });
        return current.isDirectory() &&
          current.dev === identity.dev &&
          current.ino === identity.ino &&
          current.birthtimeNs === identity.birth
          ? "ours"
          : "foreign";
      } catch (cause) {
        if (errorCode(cause) === "ENOENT") return "gone";
        throw cause;
      }
    };
    const registered = async () => {
      const listed = await cleanupExec(["git", "worktree", "list", "--porcelain"]);
      const names = new Set([path, join(await realpath(dirname(path)), basename(path))]);
      return listed.split("\n").some((line) => names.has(line.replace(/^worktree /, "")));
    };
    const current = async () => {
      try {
        return await state();
      } catch (cause) {
        cleanupErrors.push(`inspect ${path}: ${messageOf(cause)}`);
        return "foreign" as const;
      }
    };
    if ((await current()) === "ours")
      await attempt("git worktree remove", async () => {
        await cleanupExec(["git", "worktree", "remove", "--force", path]);
      });
    // Fallback only for the exact directory this run created.
    if ((await current()) === "ours")
      await attempt("remove owned worktree directory", () =>
        rm(path, { recursive: true, force: true }),
      );
    await attempt("git worktree prune", async () => {
      await cleanupExec(["git", "worktree", "prune"]);
    });
    let clean = false;
    await attempt("verify worktree removal", async () => {
      clean = (await state()) === "gone" && !(await registered());
    });
    if (!clean) leftover = path;
  }
  await attempt("log", async () => {
    await mkdir(join(logPath, ".."), { recursive: true, mode: 0o700 });
    await writeFile(logPath, `${[...log, ...cleanupErrors].filter(Boolean).join("\n")}\n`, {
      mode: 0o600,
      flag: "a",
    });
  });
  await attempt("lock release", () => lock.value.release());
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);

  if (leftover !== undefined)
    return fail(
      "cleanup_incomplete",
      `The update worktree ${leftover} could not be removed safely; inspect it, then run: git -C ${resolvedRoot} worktree remove --force ${leftover} && git -C ${resolvedRoot} worktree prune`,
      { worktree: leftover, cleanupErrors, outcome: result },
    );
  if (cleanupErrors.length === 0) return result;
  if (result.ok) return { ok: true, value: { ...result.value, cleanupErrors } };
  const details =
    typeof result.error.details === "object" && result.error.details !== null
      ? result.error.details
      : {};
  return fail(result.error.code, result.error.message, { ...details, cleanupErrors });
}

/**
 * Copy (never link) the verified managed Herdr artifact so the worktree build cannot write into the
 * control root. Without a verified artifact the worktree build prepares Herdr in its own `.omo`.
 */
async function copyHerdrArtifact(herdrRoot: string, worktree: string, log: string[]) {
  let artifactDir: string;
  let destination: string;
  try {
    artifactDir = (await resolveHerdrArtifact(herdrRoot)).artifactDir;
    destination = (await loadHerdrBuild(worktree)).artifactDir;
  } catch (cause) {
    log.push(`managed Herdr artifact not copied: ${messageOf(cause)}`);
    return;
  }
  if (basename(destination) !== basename(artifactDir)) {
    log.push(`managed Herdr artifact not copied: the worktree pins a different Herdr build`);
    return;
  }
  if (await exists(destination)) return;
  await mkdir(join(destination, ".."), { recursive: true });
  await cp(artifactDir, destination, { recursive: true, dereference: true });
  log.push(`copied managed Herdr artifact ${artifactDir} -> ${destination}`);
}
