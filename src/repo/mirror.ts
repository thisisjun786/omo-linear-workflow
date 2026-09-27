import { dlopen, FFIType, read } from "bun:ffi";
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";

const mirrorStateSchema = z.strictObject({
  version: z.literal(1),
  remote: z.string().min(1),
  lastFetchTime: z.string().nullable(),
  lastError: z.string().nullable(),
});
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
      | "mirror_locked"
      | "mirror_lock_unreadable"
      | "mirror_legacy_lock"
      | "mirror_metadata_invalid"
      | "mirror_metadata_unreadable",
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
  if (remote.startsWith("-"))
    throw new MirrorError("invalid_remote", "Remote must not start with '-'");
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

interface HeldLock {
  readonly fd: number;
  readonly path: string;
  readonly release: () => Promise<void>;
}

// Git inherits fd 3 so the kernel lock survives worker/launcher death. Disable detached
// maintenance so no background Git descendant extends the lock beyond this operation.
const gitWrapperSource =
  'trap "" TERM HUP INT; git -c gc.autoDetach=false -c maintenance.autoDetach=false "$@"; code=$?; exec 3>&-; printf x >> "$OLW_MIRROR_RELEASE_MARKER"; exit "$code"';

async function runGit(
  args: readonly string[],
  lock: HeldLock,
): Promise<{ code: number; stderr: string }> {
  const child = Bun.spawn(["setsid", "/bin/sh", "-c", gitWrapperSource, "olw-git", ...args], {
    env: { ...process.env, OLW_MIRROR_RELEASE_MARKER: `${lock.path}.released-git` },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
    stdio: ["ignore", "ignore", "pipe", lock.fd],
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

function errorCode(cause: unknown): string | undefined {
  return cause instanceof Error && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : undefined;
}

const O_RDWR = 2;
const O_CREAT = 64;
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;
const EWOULDBLOCK = 11;

interface LockFunctions {
  readonly open: (path: Uint8Array, flags: number, mode: number) => number;
  readonly flock: (fd: number, operation: number) => number;
  readonly close: (fd: number) => number;
  readonly errno: () => number;
}

function lockFunctions(): LockFunctions {
  try {
    const libc = dlopen(process.env["OLW_LIBC_PATH"] ?? "libc.so.6", {
      open: { args: [FFIType.cstring, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      close: { args: [FFIType.i32], returns: FFIType.i32 },
      __errno_location: { args: [], returns: FFIType.ptr },
    });
    return {
      open: libc.symbols.open,
      flock: libc.symbols.flock,
      close: libc.symbols.close,
      errno: () => {
        const pointer = libc.symbols.__errno_location();
        if (pointer === null)
          throw new MirrorError("mirror_lock_unreadable", "Could not read libc errno");
        return read.i32(pointer, 0);
      },
    };
  } catch (cause) {
    throw new MirrorError("mirror_lock_unreadable", "Kernel advisory locking is unavailable", {
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

async function legacyLockDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return false;
    throw new MirrorError("mirror_lock_unreadable", `Could not inspect mirror lock at ${path}`, {
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

const blockingFlockWorker = `
import { dlopen, FFIType } from "bun:ffi";
self.onmessage = async (event) => {
  try {
    const libc = dlopen(event.data.libcPath, {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    });
    const result = libc.symbols.flock(event.data.fd, 2);
    postMessage({ ok: result === 0 });
    await new Promise(() => {});
  } catch (cause) {
    postMessage({ ok: false, error: cause instanceof Error ? cause.message : String(cause) });
  }
};
`;

async function waitForLockRelease(path: string, fd: number, deadline: number): Promise<boolean> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return false;
  const worker = new Worker(URL.createObjectURL(new Blob([blockingFlockWorker])), {
    smol: true,
  });
  return new Promise<boolean>((resolve, reject) => {
    let settled = false;
    const finish = (value: boolean, cause?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      if (cause === undefined) resolve(value);
      else reject(cause);
    };
    const timer = setTimeout(() => finish(false), remaining);
    worker.onmessage = (event: MessageEvent<{ ok: boolean; error?: string }>) => {
      if (event.data.ok) finish(true);
      else
        finish(
          false,
          new MirrorError("mirror_lock_unreadable", `Could not lock ${path}`, event.data),
        );
    };
    worker.onerror = (event) => finish(false, event.error ?? new Error(event.message));
    worker.postMessage({
      fd,
      libcPath: process.env["OLW_LIBC_PATH"] ?? "libc.so.6",
    });
  });
}

async function acquireLock(
  path: string,
  timeoutMs: number,
  onWait?: (() => void) | undefined,
): Promise<HeldLock> {
  const lockPath = (await legacyLockDirectory(path)) ? `${path}.advisory` : path;
  const flock = lockFunctions();
  const fd = flock.open(new TextEncoder().encode(`${lockPath}\0`), O_RDWR | O_CREAT, 0o600);
  if (fd < 0)
    throw new MirrorError("mirror_lock_unreadable", `Could not open mirror lock at ${lockPath}`, {
      errno: flock.errno(),
    });
  let acquired = false;
  try {
    acquired = flock.flock(fd, LOCK_EX | LOCK_NB) === 0;
    if (!acquired && flock.errno() !== EWOULDBLOCK)
      throw new MirrorError("mirror_lock_unreadable", `Could not lock ${lockPath}`, {
        errno: flock.errno(),
      });
    if (!acquired) {
      onWait?.();
      if (timeoutMs <= 0) throw new MirrorError("mirror_locked", "Repository mirror is locked");
      acquired = await waitForLockRelease(lockPath, fd, Date.now() + timeoutMs);
      if (!acquired) throw new MirrorError("mirror_locked", "Repository mirror is locked");
    }
    await writeFile(
      `/proc/self/fd/${fd}`,
      `${JSON.stringify({ pid: process.pid, host: hostname(), acquiredAt: new Date().toISOString() })}\n`,
    );
    return {
      fd,
      path: lockPath,
      release: async () => {
        if (flock.flock(fd, LOCK_UN) !== 0 || flock.close(fd) !== 0)
          throw new MirrorError("mirror_lock_unreadable", `Could not release ${lockPath}`, {
            errno: flock.errno(),
          });
      },
    };
  } catch (cause) {
    if (acquired) flock.flock(fd, LOCK_UN);
    flock.close(fd);
    throw cause;
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

async function ensureMirrorLocked(
  path: string,
  identity: RemoteIdentity,
  lock: HeldLock,
): Promise<MirrorStatus> {
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
    const result = await runGit(["clone", "--mirror", "--", identity.normalized, temporary], lock);
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
  action: (mirror: MirrorStatus, lock: HeldLock) => Promise<T>,
  onLockWait?: (() => void) | undefined,
): Promise<T> {
  const identity = remoteIdentity(remote);
  const path = mirrorPath(root, remote);
  await mkdir(join(root, ".omo", "repos"), { recursive: true });
  const lock = await acquireLock(`${path}.lock`, timeoutMs, onLockWait);
  try {
    return await action(await ensureMirrorLocked(path, identity, lock), lock);
  } finally {
    await lock.release();
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
    async (mirror, lock) => {
      const result = await runGit(["--git-dir", mirror.path, "fetch", "--prune"], lock);
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
    if (entry.endsWith(".git.lock")) {
      const legacyPath = join(directory, basename(entry));
      if (await legacyLockDirectory(legacyPath))
        throw new MirrorError(
          "mirror_legacy_lock",
          `Legacy repository mirror lock directory requires manual removal: ${legacyPath}`,
          { path: legacyPath },
        );
    }
    if (!entry.endsWith(".git")) continue;
    const path = join(directory, basename(entry));
    let text: string;
    try {
      text = await readFile(statePath(path), "utf8");
    } catch (cause) {
      if (errorCode(cause) === "ENOENT") continue;
      throw new MirrorError(
        "mirror_metadata_unreadable",
        `Could not read repository mirror metadata at ${statePath(path)}`,
        { cause: cause instanceof Error ? cause.message : String(cause) },
      );
    }
    try {
      mirrors.push({ path, ...mirrorStateSchema.parse(JSON.parse(text)) });
    } catch (cause) {
      throw new MirrorError(
        "mirror_metadata_invalid",
        `Repository mirror metadata is corrupt at ${statePath(path)}`,
        { cause: cause instanceof Error ? cause.message : String(cause) },
      );
    }
  }
  return mirrors;
}
