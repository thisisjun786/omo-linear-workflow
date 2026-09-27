import { createHash } from "node:crypto";
import { chmod, mkdir, realpath, rename, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { isAbsolute, join, relative } from "node:path";
import { z } from "zod";

const EXTENSIONS = [
  "./node_modules/omo-ai/plugin",
  "./node_modules/omo-ai/plugin/extensions/omo-member.js",
  "./dist/extension/index.js",
] as const;

const hostStatusSchema = z.object({
  reachable: z.boolean(),
  socket: z.string(),
  generation: z.number().nullable(),
  launchProfile: z
    .object({
      core: z.object({
        session_runtime: z.string(),
        multi_session: z.boolean(),
        extensions: z.array(z.string()),
      }),
    })
    .nullable(),
  sessions: z.object({
    total: z.number(),
    interactive: z.number(),
    worker: z.number(),
    retained: z.number(),
    foreign_attached: z.number(),
    foreign_retained: z.number(),
  }),
  env_keys: z.array(z.string()).default([]),
});
export type HostStatus = z.infer<typeof hostStatusSchema>;

const observedSessionsSchema = z.object({ sessions: z.array(z.unknown()) });
const HOST_STATUS_TIMEOUT_MS = 15_000;
const HOST_HANDOFF_TIMEOUT_MS = 45_000;
const HOST_GROUP_TERM_GRACE_MS = 250;
const HOST_GROUP_KILL_GRACE_MS = 1_000;

interface HostCommandProcess {
  readonly pid?: number;
  readonly exited: Promise<number>;
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly stderr: ReadableStream<Uint8Array> | null;
  kill(signal?: NodeJS.Signals): void;
}

export class HostCommandTimeoutError extends Error {
  public override readonly name = "HostCommandTimeoutError";
  public constructor(
    public readonly operation: "status" | "handoff",
    public readonly timeoutMs: number,
  ) {
    super(`Native host ${operation} timed out after ${timeoutMs}ms`);
  }
}

export class HostSessionObservationError extends Error {
  public override readonly name = "HostSessionObservationError";
  public constructor(message = "Native host session list could not be read") {
    super(message);
  }
}

export class HostSessionsPresentError extends Error {
  public override readonly name = "HostSessionsPresentError";
  public constructor(public readonly count: number) {
    super(`Native host session list is not empty (${count})`);
  }
}

export class HostPostHandoffVerificationError extends Error {
  public override readonly name = "HostPostHandoffVerificationError";
  public constructor(message: string) {
    super(message);
  }
}

function runtimeNamespace(entry: string): string {
  return createHash("sha256").update(entry).digest("hex").slice(0, 16);
}
export const RUNTIME_CACHE_MARKER = `OMO_INITIATIVE_CACHE_V1_${runtimeNamespace(
  import.meta.resolve("@code-yeongyu/senpi"),
).toUpperCase()}`;
export const EXTENSION_PROTOCOL_MARKER = "OMO_INITIATIVE_EXTENSION_PROTOCOL_2";

export function runtimeCacheEnvironment(
  root: string,
  runtimeEntry = import.meta.resolve("@code-yeongyu/senpi"),
): Readonly<Record<string, string>> {
  const namespace = runtimeNamespace(runtimeEntry);
  const cache = join(root, ".omo/cache", namespace);
  return {
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(cache, "cli"),
    XDG_CACHE_HOME: join(cache, "host"),
  };
}

export class HostProfileMismatchError extends Error {
  public override readonly name = "HostProfileMismatchError";
  public constructor(
    public readonly details: {
      readonly missingExtensions: readonly string[];
      readonly missingCapabilities: readonly string[];
      readonly generation: number | null;
      readonly sessions: HostStatus["sessions"];
      readonly actualProfile: HostStatus["launchProfile"];
      readonly recovery: {
        readonly automatic: boolean;
        readonly argv: readonly string[];
        readonly env: Readonly<Record<string, string>>;
      };
    },
  ) {
    super(
      "Running host profile is incompatible; OLW can hand off only after proving every session count is zero",
    );
  }
}

export async function assertHostProtocol(
  root: string,
  socket: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  await createHostProfile(root, await readHostStatus(root, socket, env));
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ESRCH") return false;
    throw cause;
  }
}

async function waitForProcessGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (signalProcessGroup(pid, 0)) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) return false;
    await Bun.sleep(Math.min(10, remaining));
  }
  return true;
}

async function cleanSuccessfulProcessGroup(pid: number | undefined): Promise<void> {
  if (pid === undefined || !signalProcessGroup(pid, "SIGTERM")) return;
  if (await waitForProcessGroupExit(pid, HOST_GROUP_TERM_GRACE_MS)) return;
  signalProcessGroup(pid, "SIGKILL");
  if (!(await waitForProcessGroupExit(pid, HOST_GROUP_KILL_GRACE_MS)))
    throw new Error(`Native host command process group ${pid} did not exit after SIGKILL`);
}

export async function runBoundedHostCommand(
  argv: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
  timeoutMs: number,
  spawn: () => HostCommandProcess = () =>
    Bun.spawn([...argv], { cwd, env, stdout: "pipe", stderr: "pipe", detached: true }),
  operation: "status" | "handoff" = "handoff",
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const child = spawn();
  const stdout = child.stdout?.getReader();
  const stderr = child.stderr?.getReader();
  const read = async (reader: ReadableStreamDefaultReader<Uint8Array> | undefined) => {
    if (reader === undefined) return "";
    const chunks: Uint8Array[] = [];
    for (;;) {
      const item = await reader.read();
      if (item.done) return new TextDecoder().decode(Buffer.concat(chunks));
      chunks.push(item.value);
    }
  };
  const completed = Promise.all([child.exited, read(stdout), read(stderr)]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new HostCommandTimeoutError(operation, timeoutMs));
    }, timeoutMs);
  });
  try {
    const [code, stdoutText, stderrText] = await Promise.race([completed, timeout]);
    await cleanSuccessfulProcessGroup(child.pid);
    return { code, stdout: stdoutText, stderr: stderrText };
  } catch (cause) {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch (killCause) {
      if (!(killCause instanceof Error && "code" in killCause && killCause.code === "ESRCH"))
        throw new AggregateError([cause, killCause], "Host command and cleanup failed");
    }
    await child.exited;
    await Promise.allSettled([stdout?.cancel(), stderr?.cancel()]);
    throw cause;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    stdout?.releaseLock();
    stderr?.releaseLock();
  }
}

export async function readHostStatus(
  root: string,
  socket: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<HostStatus> {
  const result = await runBoundedHostCommand(
    [
      join(root, "node_modules/.bin/omo"),
      "host",
      "status",
      "--socket",
      socket,
      "--include-workers",
    ],
    root,
    env,
    HOST_STATUS_TIMEOUT_MS,
    undefined,
    "status",
  );
  if (result.code !== 0 && result.code !== 3)
    throw new Error(`Native host status failed (${result.code}): ${result.stderr.trim()}`);
  return hostStatusSchema.parse(JSON.parse(result.stdout));
}

async function requestSessionList(socketPath: string, timeoutMs: number): Promise<unknown> {
  const id = `olw-session-proof-${crypto.randomUUID()}`;
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    let settled = false;
    const finish = (value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolve(value);
    };
    const timeout = setTimeout(() => finish(), timeoutMs);
    socket.once("connect", () =>
      socket.write(`${JSON.stringify({ id, type: "list_sessions", include_workers: true })}\n`),
    );
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const reply = z
            .object({ id: z.literal(id), success: z.literal(true), data: z.unknown() })
            .safeParse(JSON.parse(line));
          if (reply.success) return finish(reply.data.data);
        } catch {
          // Ignore unrelated lifecycle records and malformed lines until the bounded deadline.
        }
      }
    });
    socket.once("error", () => finish());
    socket.once("close", () => finish());
  });
}

export async function observeEmptyHostSessions(
  socket: string,
  timeoutMs = HOST_STATUS_TIMEOUT_MS,
  request: (socket: string, timeoutMs: number) => Promise<unknown> = requestSessionList,
): Promise<void> {
  const parsed = observedSessionsSchema.safeParse(await request(socket, timeoutMs));
  if (!parsed.success) throw new HostSessionObservationError();
  if (parsed.data.sessions.length !== 0)
    throw new HostSessionsPresentError(parsed.data.sessions.length);
}

function isContained(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child !== "" && !child.startsWith("..") && !isAbsolute(child);
}

export async function handoffHost(
  root: string,
  recovery: HostProfileMismatchError["details"]["recovery"],
): Promise<void> {
  const result = await runBoundedHostCommand(
    recovery.argv,
    root,
    { ...process.env, ...recovery.env },
    HOST_HANDOFF_TIMEOUT_MS,
    undefined,
    "handoff",
  );
  if (result.code !== 0)
    throw new Error(
      `Native host handoff failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
    );
}

export async function verifyHostAfterHandoff(root: string, status: HostStatus): Promise<void> {
  if (!status.reachable)
    throw new HostPostHandoffVerificationError("Successor host is not reachable after handoff");
  if (status.launchProfile === null)
    throw new HostPostHandoffVerificationError(
      "Successor host has no launch profile after handoff",
    );
  await createHostProfile(root, status);
}

export async function createHostProfile(rootInput: string, status?: HostStatus): Promise<string> {
  const root = await realpath(rootInput);
  const required: string[] = [];
  for (const extension of EXTENSIONS) {
    const resolved = await realpath(join(root, extension));
    if (!isContained(root, resolved)) {
      throw new Error(`Host extension escapes the control root: ${extension}`);
    }
    required.push(resolved);
  }

  await mkdir(join(root, ".omo/state"), { recursive: true, mode: 0o700 });
  const path = join(root, "omo-host.json");
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  const profile = {
    spec_version: 1,
    core: {
      session_runtime: "in-process",
      multi_session: true,
      extensions: [...EXTENSIONS],
    },
    tunables: { coldStart: "persistent" },
    env: {
      OMO_NATIVE: "1",
      OMO_INITIATIVE_HOST: "1",
      OMO_INITIATIVE_EXTENSION_PROTOCOL_2: "1",
      OMO_INITIATIVE_ROOT: root,
      OMO_RPC_SOCKET: join(root, ".omo/state/omo.sock"),
      [RUNTIME_CACHE_MARKER]: "1",
    },
  };
  await writeFile(temporary, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
  if (status?.reachable) {
    const core = status.launchProfile?.core;
    const missingExtensions = required.filter((extension) => !core?.extensions.includes(extension));
    const missingCapabilities = [
      ...(!status.env_keys.includes(RUNTIME_CACHE_MARKER) ||
      !status.env_keys.includes("XDG_CACHE_HOME")
        ? ["runtime_cache_isolation"]
        : []),
      ...(!status.env_keys.includes(EXTENSION_PROTOCOL_MARKER) ? ["olw_extension_protocol_2"] : []),
    ];
    if (
      missingExtensions.length > 0 ||
      missingCapabilities.length > 0 ||
      core?.multi_session !== true ||
      core.session_runtime !== "in-process"
    ) {
      throw new HostProfileMismatchError({
        missingExtensions,
        missingCapabilities,
        generation: status.generation,
        sessions: status.sessions,
        actualProfile: status.launchProfile,
        recovery: {
          automatic: status.sessions.total === 0,
          env: runtimeCacheEnvironment(root),
          argv: [
            join(root, "node_modules/.bin/omo"),
            "host",
            "handoff",
            "--launch-spec",
            path,
            "--socket",
            status.socket,
          ],
        },
      });
    }
  }
  return path;
}
