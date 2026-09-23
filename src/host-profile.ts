import { chmod, mkdir, realpath, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

const EXTENSIONS = [
  "./node_modules/omo-ai/plugin",
  "./node_modules/omo-ai/plugin/extensions/omo-member.js",
  "./dist/extension/index.js",
  "./dist/proxy/index.js",
] as const;

function isContained(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child !== "" && !child.startsWith("..") && !isAbsolute(child);
}

export async function createHostProfile(rootInput: string): Promise<string> {
  const root = await realpath(rootInput);
  for (const extension of EXTENSIONS) {
    const resolved = await realpath(join(root, extension));
    if (!isContained(root, resolved)) {
      throw new Error(`Host extension escapes the control root: ${extension}`);
    }
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
    },
  };
  await writeFile(temporary, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
  return path;
}
