import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";

const mirrorStateSchema = z.strictObject({
  version: z.literal(1),
  remote: z.string().min(1),
  lastFetchTime: z.string().nullable(),
  lastError: z.string().nullable(),
});
const lockSchema = z.strictObject({
  pid: z.number().int().positive(),
  timestamp: z.number().nonnegative(),
  token: z.string().regex(/^[a-f0-9]{24}$/),
});
const legacyLockSchema = lockSchema.omit({ token: true });

type MirrorState = z.infer<typeof mirrorStateSchema>;
export interface MirrorStatus extends MirrorState {
  readonly path: string;
}
export interface FetchOptions {
  readonly lockTimeoutMs?: number;
  readonly onLockWait?: (() => void) | undefined;
}

export class MirrorError extends Error {
  public constructor(
    public readonly code:
      | "invalid_remote"
      | "mirror_clone_failed"
      | "mirror_fetch_failed"
      | "mirror_locked",
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "MirrorError";
  }
}

interface RemoteIdentity {
  readonly normalized: string;
  readonly label: string;
}

function remoteIdentity(remote: string): RemoteIdentity {
  let parsed: URL;
  try {
    parsed = new URL(remote);
  } catch {
    throw new MirrorError("invalid_remote", "Remote must be an https, ssh, or file Git URL");
  }
  if (!["https:", "ssh:", "file:"].includes(parsed.protocol))
    throw new MirrorError("invalid_remote", "Remote must be an https, ssh, or file Git URL");
  if (parsed.protocol === "https:" && (parsed.username !== "" || parsed.password !== ""))
    throw new MirrorError("invalid_remote", "Remote URL must not contain embedded credentials");
  if (parsed.protocol === "ssh:" && parsed.password !== "")
    throw new MirrorError("invalid_remote", "Remote URL must not contain an embedded password");
  if (parsed.protocol !== "file:" && parsed.hostname === "")
    throw new MirrorError("invalid_remote", "Remote URL must include a host");
  if (parsed.pathname === "" || parsed.pathname === "/")
    throw new MirrorError("invalid_remote", "Remote URL must include a repository path");
  parsed.hash = "";
  parsed.search = "";
  const normalized = parsed.href;
  const source = `${parsed.hostname}${parsed.pathname.replace(/\.git\/?$/, "")}`;
  const label = source.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "repository";
  return { normalized, label: label.slice(-80) };
}

export function mirrorPath(root: string, remote: string): string {
  const identity = remoteIdentity(remote);
  const hash = createHash("sha256").update(identity.normalized).digest("hex").slice(0, 12);
  return join(root, ".omo", "repos", `${identity.label}-${hash}.git`);
}

function statePath(path: string): string {
  return join(path, "olw-mirror.json");
}

async function runGit(args: readonly string[]): Promise<{ code: number; stderr: string }> {
  const child = Bun.spawn(["git", ...args], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { code, stderr: stderr.trim() };
}

function safeGitMessage(stderr: string): string {
  return stderr
    .replace(/https:\/\/[^/@\s]+@/giu, "https://")
    .replace(/ssh:\/\/[^/@\s]*:[^/@\s]*@/giu, "ssh://");
}

async function writeState(path: string, state: MirrorState): Promise<void> {
  await writeFile(statePath(path), `${JSON.stringify(state)}\n`, { mode: 0o600 });
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return !(cause instanceof Error && "code" in cause && cause.code === "ESRCH");
  }
}

interface LockOwner {
  readonly pid: number;
  readonly timestamp: number;
  readonly token: string;
}

function isAlreadyExists(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    "code" in cause &&
    (cause.code === "EEXIST" || cause.code === "ENOTEMPTY" || cause.code === "ENOTDIR")
  );
}

async function readLock(path: string): Promise<LockOwner | undefined> {
  try {
    const stats = await lstat(path);
    const text = await readFile(stats.isDirectory() ? join(path, "owner.json") : path, "utf8");
    const value: unknown = JSON.parse(text);
    const current = lockSchema.safeParse(value);
    if (current.success) return current.data;
    const legacy = legacyLockSchema.safeParse(value);
    if (!legacy.success) return undefined;
    return {
      ...legacy.data,
      token: createHash("sha256").update(text).digest("hex").slice(0, 24),
    };
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
    return undefined;
  }
}

async function publishLock(path: string, owner: LockOwner): Promise<boolean> {
  const candidate = `${path}.acquire-${owner.token}`;
  await mkdir(candidate);
  try {
    await writeFile(join(candidate, "owner.json"), JSON.stringify(owner), { mode: 0o600 });
    try {
      await rename(candidate, path);
      return true;
    } catch (cause) {
      if (!isAlreadyExists(cause)) throw cause;
      return false;
    }
  } finally {
    await rm(candidate, { recursive: true, force: true });
  }
}

async function releaseLock(path: string, token: string): Promise<void> {
  if ((await readLock(path))?.token !== token) return;
  const released = `${path}.released-${token}`;
  try {
    await rename(path, released);
    await rm(released, { recursive: true, force: true });
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
  }
}

async function acquireLock(
  path: string,
  timeoutMs: number,
  onWait?: (() => void) | undefined,
): Promise<() => Promise<void>> {
  const started = Date.now();
  const owner: LockOwner = {
    pid: process.pid,
    timestamp: Date.now(),
    token: randomBytes(12).toString("hex"),
  };
  let waiting = false;
  while (true) {
    if (await publishLock(path, owner)) return async () => releaseLock(path, owner.token);
    if (!waiting) {
      waiting = true;
      onWait?.();
    }
    const lock = await readLock(path);
    if (lock !== undefined && !processAlive(lock.pid)) {
      const stale = `${path}.stale-${lock.token}`;
      try {
        await rename(path, stale);
      } catch (cause) {
        if (
          !isAlreadyExists(cause) &&
          !(cause instanceof Error && "code" in cause && cause.code === "ENOENT")
        )
          throw cause;
      }
      continue;
    }
    if (Date.now() - started >= timeoutMs)
      throw new MirrorError(
        "mirror_locked",
        `Repository mirror is locked by pid ${lock?.pid ?? "unknown"}`,
      );
    await Bun.sleep(Math.min(50, Math.max(1, timeoutMs - (Date.now() - started))));
  }
}

function temporaryMirrorOwner(entry: string, finalName: string): number | undefined {
  const prefix = `${finalName}-`;
  if (!entry.startsWith(prefix)) return undefined;
  const [pid, random, ...extra] = entry.slice(prefix.length).split("-");
  if (
    pid === undefined ||
    random === undefined ||
    extra.length > 0 ||
    !/^[a-f0-9]{12}$/.test(random)
  )
    return undefined;
  const parsed = z.coerce.number().int().positive().safeParse(pid);
  return parsed.success ? parsed.data : undefined;
}

async function removeDeadTemporaryMirrors(path: string): Promise<void> {
  const directory = join(path, "..", ".tmp");
  await mkdir(directory, { recursive: true });
  const finalName = basename(path);
  for (const entry of await readdir(directory)) {
    const owner = temporaryMirrorOwner(entry, finalName);
    if (owner === undefined || processAlive(owner)) continue;
    const temporary = join(directory, entry);
    try {
      if ((await lstat(temporary)).isDirectory())
        await rm(temporary, { recursive: true, force: true });
    } catch (cause) {
      if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
    }
  }
}

async function ensureMirrorLocked(path: string, identity: RemoteIdentity): Promise<MirrorStatus> {
  await removeDeadTemporaryMirrors(path);
  const existing = Bun.file(statePath(path));
  if (await existing.exists()) {
    const state = mirrorStateSchema.parse(await existing.json());
    if (state.remote !== identity.normalized)
      throw new MirrorError("mirror_clone_failed", `Mirror identity mismatch at ${path}`);
    return { path, ...state };
  }
  const temporary = join(
    path,
    "..",
    ".tmp",
    `${basename(path)}-${process.pid}-${randomBytes(6).toString("hex")}`,
  );
  try {
    const result = await runGit(["clone", "--mirror", identity.normalized, temporary]);
    if (result.code !== 0)
      throw new MirrorError(
        "mirror_clone_failed",
        `Could not create repository mirror: ${safeGitMessage(result.stderr) || `git exited ${result.code}`}`,
      );
    const state: MirrorState = {
      version: 1,
      remote: identity.normalized,
      lastFetchTime: null,
      lastError: null,
    };
    await writeState(temporary, state);
    await rename(temporary, path);
    return { path, ...state };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function withMirrorLock<T>(
  root: string,
  remote: string,
  timeoutMs: number,
  action: (mirror: MirrorStatus) => Promise<T>,
  onLockWait?: (() => void) | undefined,
): Promise<T> {
  const identity = remoteIdentity(remote);
  const path = mirrorPath(root, remote);
  await mkdir(join(root, ".omo", "repos"), { recursive: true });
  const release = await acquireLock(`${path}.lock`, timeoutMs, onLockWait);
  try {
    return await action(await ensureMirrorLocked(path, identity));
  } finally {
    await release();
  }
}

export async function ensureMirror(root: string, remote: string): Promise<MirrorStatus> {
  return withMirrorLock(root, remote, 5_000, async (mirror) => mirror);
}

export async function fetchMirror(
  root: string,
  remote: string,
  options: FetchOptions = {},
): Promise<MirrorStatus> {
  return withMirrorLock(
    root,
    remote,
    options.lockTimeoutMs ?? 5_000,
    async (mirror) => {
      const result = await runGit(["--git-dir", mirror.path, "fetch", "--prune"]);
      if (result.code !== 0) {
        const message = safeGitMessage(result.stderr) || `git exited ${result.code}`;
        await writeState(mirror.path, {
          version: 1,
          remote: mirror.remote,
          lastFetchTime: mirror.lastFetchTime,
          lastError: message,
        });
        throw new MirrorError(
          "mirror_fetch_failed",
          `Could not fetch repository mirror: ${message}`,
        );
      }
      const state: MirrorState = {
        version: 1,
        remote: mirror.remote,
        lastFetchTime: new Date().toISOString(),
        lastError: null,
      };
      await writeState(mirror.path, state);
      return { path: mirror.path, ...state };
    },
    options.onLockWait,
  );
}

export async function listMirrors(root: string): Promise<MirrorStatus[]> {
  const directory = join(root, ".omo", "repos");
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return [];
    throw cause;
  }
  const mirrors: MirrorStatus[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".git")) continue;
    const path = join(directory, basename(entry));
    try {
      mirrors.push({
        path,
        ...mirrorStateSchema.parse(JSON.parse(await readFile(statePath(path), "utf8"))),
      });
    } catch {
      // Only OLW mirrors with valid metadata are known locally.
    }
  }
  return mirrors;
}
