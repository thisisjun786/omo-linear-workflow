import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { checkRoutingAdvice, readRoutingAdvice, type SyncOptions } from "../proxy/routing-sync";

const packageNames = ["omo-ai", "@code-yeongyu/senpi"] as const;
type PackageName = (typeof packageNames)[number];
export type PackageCheckState = "update_available" | "current" | "unknown";
export interface PackageCheck {
  readonly state: PackageCheckState;
  readonly pinned: string;
  readonly available: string | null;
  readonly tag: string;
  readonly reason?: string;
}
export interface UpdateCheck {
  readonly checkedAt: string;
  readonly state: "available" | "current" | "unknown" | "unavailable";
  readonly packages: Readonly<Record<PackageName, PackageCheck>>;
  readonly globalOmo: string | null;
  readonly routingAdvice?: Awaited<ReturnType<typeof readRoutingAdvice>>;
  readonly reason?: string;
}
export interface UpdateTimer {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}
export const systemUpdateTimer: UpdateTimer = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
};
export type CommandRunner = (
  argv: readonly string[],
  timeoutMs: number,
) => Promise<{
  readonly code: number;
  readonly stdout: string;
  readonly stderr?: string;
  readonly timedOut?: boolean;
}>;
const packageJsonSchema = z.object({ dependencies: z.record(z.string(), z.string()) });
const defaultTags: Record<PackageName, string> = {
  "omo-ai": "beta",
  "@code-yeongyu/senpi": "latest",
};

const RUNNER_KILL_GRACE_MS = 250;
const RUNNER_REAP_GRACE_MS = 100;
const RUNNER_CLEANUP_BUDGET_MS = RUNNER_KILL_GRACE_MS + RUNNER_REAP_GRACE_MS;
export const runCommand = async (
  argv: readonly string[],
  timeoutMs: number,
  timer: UpdateTimer = systemUpdateTimer,
  onSpawn?: (pid: number) => void,
): ReturnType<CommandRunner> => {
  const child = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe", detached: true });
  onSpawn?.(child.pid);
  let timedOut = false;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  let escalation: Promise<void> | undefined;
  const timeout = timer.setTimeout(() => {
    timedOut = true;
    escalation = new Promise<void>((resolve) => {
      const childPid = child.pid;
      if (childPid === undefined) return resolve();
      try {
        process.kill(-childPid, "SIGTERM");
      } catch (cause) {
        if (cause instanceof Error && "code" in cause && cause.code === "ESRCH") return resolve();
        throw cause;
      }
      forceKillTimer = timer.setTimeout(() => {
        try {
          process.kill(-childPid, "SIGKILL");
        } catch (cause) {
          if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) throw cause;
        }
        timer.setTimeout(resolve, RUNNER_REAP_GRACE_MS);
      }, RUNNER_KILL_GRACE_MS);
    });
  }, timeoutMs);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (timedOut && escalation !== undefined) await escalation;
    if (timedOut && child.pid !== undefined) {
      try {
        process.kill(-child.pid, 0);
        throw new Error(`Timed-out command process group ${child.pid} survived SIGKILL`);
      } catch (cause) {
        if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) throw cause;
      }
    }
    return { code, stdout, stderr, timedOut };
  } finally {
    timer.clearTimeout(timeout);
    if (forceKillTimer !== undefined) timer.clearTimeout(forceKillTimer);
  }
};

function isSemver(value: string): boolean {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
    value,
  );
}
function compareVersions(a: string, b: string): number | null {
  if (!isSemver(a) || !isSemver(b)) return null;
  try {
    return Bun.semver.order(a, b);
  } catch {
    return null;
  }
}

export async function checkUpdates(
  root: string,
  options: {
    readonly run?: CommandRunner;
    readonly timeoutMs?: number;
    readonly tags?: Partial<Record<PackageName, string>>;
    readonly now?: () => string;
    readonly timer?: UpdateTimer;
    readonly signal?: AbortSignal;
    readonly routingStateDir?: string;
    readonly routing?: SyncOptions;
  } = {},
): Promise<UpdateCheck> {
  const rawRun = options.run ?? runCommand;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const timer = options.timer ?? systemUpdateTimer;
  const startedAt = timer.now();
  const deadline = startedAt + timeoutMs;
  const signal = options.signal;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  let deadlineExpired = false;
  const run: CommandRunner = async (argv) => {
    const remaining = Math.max(0, deadline - timer.now());
    const commandBudget = Math.max(0, remaining - RUNNER_CLEANUP_BUDGET_MS);
    if (remaining === 0) {
      expired = true;
      return { code: -1, stdout: "", timedOut: true };
    }
    let commandTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (rawRun === runCommand) return await runCommand(argv, commandBudget, timer);
      return await Promise.race([
        rawRun(argv, commandBudget),
        ...(signal === undefined
          ? []
          : [
              new Promise<{ code: number; stdout: string; timedOut: true }>((resolve) => {
                signal.addEventListener(
                  "abort",
                  () => {
                    expired = true;
                    resolve({ code: -1, stdout: "", timedOut: true });
                  },
                  { once: true },
                );
              }),
            ]),
        new Promise<{ code: number; stdout: string; timedOut: true }>((resolve) => {
          commandTimer = timer.setTimeout(() => {
            expired = true;
            resolve({ code: -1, stdout: "", timedOut: true });
          }, commandBudget);
        }),
      ]);
    } finally {
      if (commandTimer !== undefined) timer.clearTimeout(commandTimer);
    }
  };
  const tags = { ...defaultTags, ...options.tags };
  const statePath = join(root, ".omo/state/update-check.json");
  const reasonList: string[] = [];
  let pinned: Record<PackageName, string> | undefined;
  try {
    const json = packageJsonSchema.parse(
      JSON.parse(await readFile(join(root, "package.json"), "utf8")),
    );
    pinned = {
      "omo-ai": json.dependencies["omo-ai"] ?? "",
      "@code-yeongyu/senpi": json.dependencies["@code-yeongyu/senpi"] ?? "",
    };
    if (Object.values(pinned).some((version) => !version))
      throw new Error("Pinned dependency missing from package.json");
  } catch (cause) {
    reasonList.push(cause instanceof Error ? cause.message : String(cause));
  }

  const packages: Record<PackageName, PackageCheck> = {
    "omo-ai": {
      state: "unknown",
      pinned: pinned?.["omo-ai"] ?? "unknown",
      available: null,
      tag: tags["omo-ai"],
    },
    "@code-yeongyu/senpi": {
      state: "unknown",
      pinned: pinned?.["@code-yeongyu/senpi"] ?? "unknown",
      available: null,
      tag: tags["@code-yeongyu/senpi"],
    },
  };
  let globalOmo: string | null = null;
  const queries = [
    ...packageNames.map(async (name) => {
      try {
        const result = await run(
          ["npm", "--fetch-retries=0", "--fetch-timeout=5000", "view", name, "dist-tags", "--json"],
          timeoutMs,
        );
        if (result.timedOut) {
          expired = true;
          return { name, error: "npm view timed out", timedOut: true, offline: false };
        }
        if (result.code !== 0)
          return {
            name,
            error: result.stderr?.trim() || `npm view exited ${result.code}`,
            offline: true,
          };
        const tagsJson: unknown = JSON.parse(result.stdout);
        const distTags = z.record(z.string(), z.string()).parse(tagsJson);
        const available = distTags[tags[name]];
        if (!available) throw new Error(`npm dist-tag ${tags[name]} was not returned`);
        return { name, available };
      } catch (cause) {
        if (timer.now() >= deadline) expired = true;
        const reason = cause instanceof Error ? cause.message : String(cause);
        return { name, error: reason, offline: true };
      }
    }),
    (async () => {
      try {
        const result = await run(["omo", "--version"], timeoutMs);
        return { kind: "global" as const, result };
      } catch (cause) {
        if (timer.now() >= deadline) expired = true;
        return {
          kind: "global" as const,
          error: cause instanceof Error ? cause.message : String(cause),
        };
      }
    })(),
  ];
  const commandResults = await Promise.race([
    Promise.all(queries),
    ...(signal === undefined
      ? []
      : [
          new Promise<Awaited<(typeof queries)[number]>[]>((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                expired = true;
                resolve([
                  ...packageNames.map((name) => ({
                    name,
                    error: "Update check timed out",
                    timedOut: true,
                    offline: false,
                  })),
                  { kind: "global" as const, error: "Update check timed out" },
                ]);
              },
              { once: true },
            );
          }),
        ]),
    new Promise<Awaited<(typeof queries)[number]>[]>((resolve) => {
      deadlineTimer = timer.setTimeout(
        () => {
          expired = true;
          deadlineExpired = true;
          resolve([
            ...packageNames.map((name) => ({
              name,
              error: "Update check timed out",
              timedOut: true,
              offline: false,
            })),
            { kind: "global" as const, error: "Update check timed out" },
          ]);
        },
        Math.max(0, deadline - timer.now()),
      );
    }),
  ]);
  if (deadlineTimer !== undefined && !deadlineExpired) timer.clearTimeout(deadlineTimer);
  const outputs = commandResults.filter(
    (item): item is Extract<(typeof commandResults)[number], { name: PackageName }> =>
      "name" in item,
  );
  const globalResult = commandResults.find(
    (item): item is Extract<(typeof commandResults)[number], { kind: "global" }> => "kind" in item,
  );
  if (globalResult && "result" in globalResult) {
    const result = globalResult.result;
    if (!result.timedOut && result.code === 0) {
      const match = /(?:^|\s)omo\s+([^\s]+)/.exec(result.stdout.trim());
      globalOmo = match?.[1] ?? (result.stdout.trim() || null);
    } else
      reasonList.push(
        result.timedOut ? "omo --version timed out" : `omo --version exited ${result.code}`,
      );
  } else if (globalResult && "error" in globalResult) {
    reasonList.push(globalResult.error);
  }

  let failed = false;
  for (const { name, available, error } of outputs) {
    const pin = pinned?.[name] ?? "unknown";
    if (available === undefined || pinned === undefined) {
      failed = true;
      packages[name] = {
        state: "unknown",
        pinned: pin,
        available: null,
        tag: tags[name],
        ...(error ? { reason: error } : {}),
      };
      if (error) reasonList.push(`${name}: ${error}`);
      continue;
    }
    const comparison = compareVersions(available, pin);
    packages[name] = {
      state: comparison === null ? "unknown" : comparison > 0 ? "update_available" : "current",
      pinned: pin,
      available,
      tag: tags[name],
      ...(comparison === null ? { reason: "Version strings could not be compared" } : {}),
    };
    if (comparison === null) failed = true;
  }
  const unavailable =
    !expired &&
    outputs.every((item) => item.available === undefined && item.offline === true) &&
    outputs.every((item) => item.timedOut !== true);
  const hasUpdate = Object.values(packages).some((item) => item.state === "update_available");
  const routingAdvice = options.routing
    ? await checkRoutingAdvice(options.routing)
    : await readRoutingAdvice(
        options.routingStateDir ?? join(process.env["HOME"] ?? "", ".omo/proxy-routing"),
      );
  const overall: UpdateCheck = {
    checkedAt: (options.now ?? (() => new Date().toISOString()))(),
    state:
      expired || timer.now() >= deadline
        ? "unknown"
        : unavailable
          ? "unavailable"
          : hasUpdate
            ? "available"
            : failed
              ? "unknown"
              : "current",
    packages,
    globalOmo,
    routingAdvice,
    ...(reasonList.length ? { reason: reasonList.join("; ") } : {}),
  };
  try {
    await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
    const temporary = `${statePath}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(overall, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, statePath);
    } finally {
      await rm(temporary, { force: true });
    }
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return {
      ...overall,
      state: "unavailable",
      reason: [overall.reason, `Could not persist update check: ${reason}`]
        .filter(Boolean)
        .join("; "),
    };
  }
  return overall;
}
