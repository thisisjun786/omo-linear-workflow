import { createHash } from "node:crypto";
import { chmod, mkdir, realpath, rename, writeFile } from "node:fs/promises";
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
  sessions: z.object({ total: z.number(), worker: z.number() }),
  env_keys: z.array(z.string()).default([]),
});
export type HostStatus = z.infer<typeof hostStatusSchema>;

function runtimeNamespace(entry: string): string {
  return createHash("sha256").update(entry).digest("hex").slice(0, 16);
}
export const RUNTIME_CACHE_MARKER = `OMO_INITIATIVE_CACHE_V1_${runtimeNamespace(
  import.meta.resolve("@code-yeongyu/senpi"),
).toUpperCase()}`;

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
        readonly automatic: false;
        readonly argv: readonly string[];
        readonly env: Readonly<Record<string, string>>;
      };
    },
  ) {
    super(
      "Running host profile is incompatible; review its sessions before an explicit generation handoff",
    );
  }
}

export async function readHostStatus(
  root: string,
  socket: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<HostStatus> {
  const child = Bun.spawn(
    [join(root, "node_modules/.bin/omo"), "host", "status", "--socket", socket],
    { cwd: root, env, stdout: "pipe", stderr: "pipe" },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0 && code !== 3)
    throw new Error(`Native host status failed (${code}): ${stderr.trim()}`);
  return hostStatusSchema.parse(JSON.parse(stdout));
}

function isContained(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child !== "" && !child.startsWith("..") && !isAbsolute(child);
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
    const missingCapabilities =
      status.env_keys.includes(RUNTIME_CACHE_MARKER) && status.env_keys.includes("XDG_CACHE_HOME")
        ? []
        : ["runtime_cache_isolation"];
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
          automatic: false,
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
