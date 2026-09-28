import { createHash } from "node:crypto";
import { chmod, mkdir, open, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
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
      profile_id: z.string().optional(),
      core: z.object({
        session_runtime: z.string(),
        multi_session: z.boolean(),
        extensions: z.array(z.string()).readonly(),
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
  rss_mb: z.number().nullable().optional(),
  sessions_observed: z.boolean().optional(),
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
export const DEFAULT_HOST_RSS_WARNING_MB = 8 * 1024;

const crashRecordSchema = z.object({
  at: z.iso.datetime(),
  signal: z.string().min(1).optional(),
  code: z.number().int().optional(),
  uptimeMs: z.number().nonnegative(),
});

export interface HostHealth {
  readonly reachable: boolean;
  readonly generation: number | null;
  readonly profile: {
    readonly matchesOlw: boolean;
    readonly recovery: {
      readonly ready: boolean;
      readonly preparation: readonly string[];
      readonly env: Readonly<Record<string, string>>;
      readonly argv: readonly string[];
    };
  };
  readonly sessions: HostStatus["sessions"] | null;
  readonly rssMb: number | null;
  readonly rssWarningMb: number;
  readonly crashes: ReadonlyArray<
    z.infer<typeof crashRecordSchema> & { readonly likelyOom: boolean }
  >;
  readonly crashHistoryError: string | null;
  readonly warnings: readonly string[];
}

export function resolveOmoAgentDir(
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
): string {
  for (const name of ["OMO_CODING_AGENT_DIR", "SENPI_CODING_AGENT_DIR", "PI_CODING_AGENT_DIR"]) {
    const configured = env[name]?.trim();
    if (configured) return resolve(cwd, configured);
  }
  return join(env["HOME"] || env["USERPROFILE"] || homedir(), ".omo/agent");
}

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
  deadline?: Promise<never>,
  schedule: (fire: () => void, ms: number) => () => void = (fire, ms) => {
    const handle = setTimeout(fire, ms);
    return () => clearTimeout(handle);
  },
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
  let cancelTimer: (() => void) | undefined;
  // The timeoutMs bound always applies; an injected deadline can only end the wait earlier.
  const timeout = new Promise<never>((_resolve, reject) => {
    cancelTimer = schedule(() => {
      reject(new HostCommandTimeoutError(operation, timeoutMs));
    }, timeoutMs);
  });
  try {
    const [code, stdoutText, stderrText] = await Promise.race([
      completed,
      timeout,
      ...(deadline === undefined ? [] : [deadline]),
    ]);
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
    cancelTimer?.();
    stdout?.releaseLock();
    stderr?.releaseLock();
  }
}

const protocolInfoSchema = z.object({
  generation: z.number().optional(),
  launch_profile: hostStatusSchema.shape.launchProfile.unwrap().optional(),
});
const pointerSchema = z.object({ instance_id: z.string() });
const registrationSchema = z.object({
  pid: z.number().int().positive(),
  generation: z.number().default(0),
});
const envKeysSchema = z.object({ env_keys: z.array(z.string()).default([]) });

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
    return undefined;
  }
}

async function probeProtocolInfoReadOnly(
  socket: string,
): Promise<z.infer<typeof protocolInfoSchema> | undefined> {
  const id = `olw-host-health-${crypto.randomUUID()}`;
  return new Promise((resolveProbe) => {
    const client = createConnection(socket);
    let buffer = "";
    let settled = false;
    const finish = (value?: z.infer<typeof protocolInfoSchema>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      client.destroy();
      resolveProbe(value);
    };
    const timeout = setTimeout(() => finish(), HOST_STATUS_TIMEOUT_MS);
    client.once("connect", () =>
      client.write(`${JSON.stringify({ id, type: "get_protocol_info" })}\n`),
    );
    client.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const response = z
            .object({ id: z.literal(id), success: z.literal(true), data: z.unknown() })
            .safeParse(JSON.parse(line));
          if (!response.success) continue;
          const parsed = protocolInfoSchema.safeParse(response.data.data);
          return finish(parsed.success ? parsed.data : undefined);
        } catch {
          // Ignore unrelated lifecycle records and malformed lines until the bounded deadline.
        }
      }
    });
    client.once("error", () => finish());
    client.once("close", () => finish());
  });
}

async function readRegistration(daemonDir: string) {
  const pointer = pointerSchema.safeParse(await readJson(join(daemonDir, "host.pid")));
  if (!pointer.success) return undefined;
  const registration = registrationSchema.safeParse(
    await readJson(join(daemonDir, "generations", pointer.data.instance_id, "host.pid")),
  );
  return registration.success ? registration.data : undefined;
}

async function readRssMb(pid: number | undefined): Promise<number | null> {
  if (pid === undefined || process.platform !== "linux") return null;
  try {
    const match = /^VmRSS:\s+(\d+)\s+kB$/mu.exec(await readFile(`/proc/${pid}/status`, "utf8"));
    return match?.[1] === undefined ? null : Math.round(Number(match[1]) / 1024);
  } catch {
    return null;
  }
}

export async function readHostStatusReadOnly(
  socket: string,
  agentDir: string,
): Promise<HostStatus> {
  const daemonDir = join(agentDir, "rpc-host-daemon", daemonDirectoryName(socket));
  const [protocol, registration, envKeys] = await Promise.all([
    probeProtocolInfoReadOnly(socket),
    readRegistration(daemonDir),
    readJson(join(daemonDir, "env-keys.json")),
  ]);
  const parsedEnvKeys = envKeysSchema.safeParse(envKeys);
  return hostStatusSchema.parse({
    reachable: protocol !== undefined,
    socket,
    generation:
      protocol === undefined ? null : (protocol.generation ?? registration?.generation ?? null),
    launchProfile: protocol?.launch_profile ?? null,
    sessions: {
      total: 0,
      interactive: 0,
      worker: 0,
      retained: 0,
      foreign_attached: 0,
      foreign_retained: 0,
    },
    rss_mb: await readRssMb(registration?.pid),
    sessions_observed: false,
    env_keys: parsedEnvKeys.success ? parsedEnvKeys.data.env_keys : [],
  });
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

function daemonDirectoryName(socket: string): string {
  const canonical =
    process.platform === "win32" ? socket.replaceAll("/", "\\").toLowerCase() : socket;
  return createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 16);
}

export const RECENT_HOST_CRASH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const MAX_CRASH_JOURNAL_BYTES = 64 * 1024;

async function readCrashRecords(agentDir: string, socket: string, now: Date) {
  const path = join(agentDir, "rpc-host-daemon", daemonDirectoryName(socket), "crashes.jsonl");
  let text: string;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const size = (await stat(path)).size;
    const start = Math.max(0, size - MAX_CRASH_JOURNAL_BYTES);
    const bytes = Buffer.alloc(size - start);
    handle = await open(path, "r");
    await handle.read(bytes, 0, bytes.length, start);
    text = bytes.toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return [];
    throw new Error(
      `Could not read ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  } finally {
    await handle?.close();
  }
  return text
    .split("\n")
    .flatMap((line) => {
      if (line.trim() === "") return [];
      try {
        const parsed = crashRecordSchema.safeParse(JSON.parse(line));
        return parsed.success
          ? [{ ...parsed.data, likelyOom: parsed.data.signal === "SIGKILL" }]
          : [];
      } catch {
        return [];
      }
    })
    .filter((record) => {
      const age = now.getTime() - new Date(record.at).getTime();
      return age >= 0 && age <= RECENT_HOST_CRASH_WINDOW_MS;
    })
    .slice(-10);
}

async function requiredExtensionPaths(root: string): Promise<string[]> {
  const required: string[] = [];
  for (const extension of EXTENSIONS) {
    const resolved = await realpath(join(root, extension));
    if (!isContained(root, resolved))
      throw new Error(`Host extension escapes the control root: ${extension}`);
    required.push(resolved);
  }
  return required;
}

function hostProfileCompatibility(status: HostStatus, required: readonly string[]) {
  const core = status.launchProfile?.core;
  const missingExtensions = required.filter((extension) => !core?.extensions.includes(extension));
  const missingCapabilities = [
    ...(!status.env_keys.includes(RUNTIME_CACHE_MARKER) ||
    !status.env_keys.includes("XDG_CACHE_HOME")
      ? ["runtime_cache_isolation"]
      : []),
    ...(!status.env_keys.includes(EXTENSION_PROTOCOL_MARKER) ? ["olw_extension_protocol_2"] : []),
  ];
  return {
    missingExtensions,
    missingCapabilities,
    matches:
      missingExtensions.length === 0 &&
      missingCapabilities.length === 0 &&
      core?.multi_session === true &&
      core.session_runtime === "in-process",
  };
}

export async function inspectHostHealth(
  rootInput: string,
  status: HostStatus,
  options: {
    readonly agentDir: string;
    readonly readyBindings?: number;
    readonly rssWarningMb?: number;
    readonly now?: () => Date;
  },
): Promise<HostHealth> {
  const root = await realpath(rootInput);
  const profilePath = join(root, "omo-host.json");
  const matchesOlw =
    status.reachable &&
    hostProfileCompatibility(status, await requiredExtensionPaths(root)).matches;
  const profileExists = await Bun.file(profilePath).exists();
  const rssWarningMb = options.rssWarningMb ?? DEFAULT_HOST_RSS_WARNING_MB;
  const warnings: string[] = [];
  if (status.reachable && !matchesOlw)
    warnings.push(
      "Shared host launch profile does not match OLW; use the recovery command after its sessions are idle.",
    );
  const rssMb = status.rss_mb ?? null;
  if (rssMb !== null && rssMb > rssWarningMb)
    warnings.push(`Shared host RSS ${rssMb} MiB exceeds ${rssWarningMb} MiB.`);
  if (
    status.sessions_observed !== false &&
    status.reachable &&
    status.sessions.total === 0 &&
    (options.readyBindings ?? 0) > 0
  )
    warnings.push(
      `Shared host has 0 sessions while ${options.readyBindings ?? 0} OLW bindings are ready; run olw status for per-binding state.`,
    );
  let crashes: HostHealth["crashes"] = [];
  let crashHistoryError: string | null = null;
  try {
    crashes = await readCrashRecords(
      options.agentDir,
      status.socket,
      options.now?.() ?? new Date(),
    );
  } catch (cause) {
    crashHistoryError = cause instanceof Error ? cause.message : String(cause);
  }
  return {
    reachable: status.reachable,
    generation: status.generation,
    profile: {
      matchesOlw,
      recovery: {
        ready: profileExists,
        preparation: ["olw", "manage", "--root", root],
        env: runtimeCacheEnvironment(root),
        argv: [
          join(root, "node_modules/.bin/omo"),
          "host",
          "handoff",
          "--launch-spec",
          profilePath,
          "--socket",
          status.socket,
        ],
      },
    },
    sessions: status.sessions_observed === false ? null : status.sessions,
    rssMb,
    rssWarningMb,
    crashes,
    crashHistoryError,
    warnings,
  };
}

export async function createHostProfile(rootInput: string, status?: HostStatus): Promise<string> {
  const root = await realpath(rootInput);
  const required = await requiredExtensionPaths(root);

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
    const compatibility = hostProfileCompatibility(status, required);
    if (!compatibility.matches) {
      throw new HostProfileMismatchError({
        missingExtensions: compatibility.missingExtensions,
        missingCapabilities: compatibility.missingCapabilities,
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
