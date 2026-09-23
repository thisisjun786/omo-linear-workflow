import type { Stats } from "node:fs";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import manifest from "../package.json";

export class InstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallError";
  }
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function ownedLauncher(path: string, expected: string): Promise<boolean> {
  let info: Stats;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
  if (!info.isFile() || (await readFile(path, "utf8")) !== expected) {
    throw new InstallError(`${path} already exists and is not this checkout's OLW launcher`);
  }
  if ((info.mode & 0o111) === 0) throw new InstallError(`${path} exists but is not executable`);
  return true;
}

async function run(argv: readonly string[], cwd: string): Promise<void> {
  const child = Bun.spawn([...argv], {
    cwd,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0) throw new InstallError(`${argv.join(" ")} exited ${code}`);
}

export async function installLocal(options: {
  readonly root: string;
  readonly binDir: string;
}): Promise<string> {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new InstallError("The supported installer target is Linux x64");
  }
  if (!Bun.semver.satisfies(Bun.version, manifest.engines.bun)) {
    throw new InstallError(`Bun ${manifest.engines.bun} is required`);
  }
  const root = await realpath(options.root);
  const binDir = resolve(options.binDir);
  const launcher = join(binDir, "olw");
  const content = `#!/bin/sh\n# OLW source-checkout launcher\nexec ${quote(process.execPath)} ${quote(join(root, "dist/cli.js"))} --root ${quote(root)} "$@"\n`;
  await ownedLauncher(launcher, content);
  for (const tool of ["git", "node", "pnpm"]) {
    if (!Bun.which(tool))
      throw new InstallError(`Missing ${tool}; install the documented prerequisites first`);
  }
  const nodeCheck = Bun.spawn(["node", "--version"], { stdout: "pipe", stderr: "pipe" });
  const nodeVersion = (await new Response(nodeCheck.stdout).text()).trim().replace(/^v/, "");
  if ((await nodeCheck.exited) !== 0 || !Bun.semver.satisfies(nodeVersion, manifest.engines.node)) {
    throw new InstallError(`Node.js ${manifest.engines.node} is required`);
  }
  const pnpmCheck = Bun.spawn(["pnpm", "--version"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const pnpmVersion = (await new Response(pnpmCheck.stdout).text()).trim();
  if ((await pnpmCheck.exited) !== 0 || `pnpm@${pnpmVersion}` !== manifest.packageManager) {
    throw new InstallError(`${manifest.packageManager} is required`);
  }
  await run(["pnpm", "install", "--frozen-lockfile"], root);
  await run([process.execPath, "run", "build"], root);
  if (!(await Bun.file(join(root, "dist/cli.js")).exists())) {
    throw new InstallError("Build did not produce dist/cli.js; no launcher installed");
  }
  await mkdir(binDir, { recursive: true });
  // Recheck after external build commands; never overwrite a concurrently created command.
  if (!(await ownedLauncher(launcher, content))) {
    await writeFile(launcher, content, { mode: 0o755, flag: "wx" });
  }
  console.log(`OLW_INSTALL_OK ${launcher}`);
  console.log(`Keep this checkout at ${root}; add ${binDir} to PATH if needed.`);
  return launcher;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--") args.shift();
  if (args.length === 1 && args[0] === "--help") {
    console.log(
      "Usage: bun run install:local [--bin-dir PATH]\nBuild this Linux x64 checkout and install a non-overwriting olw launcher.\nDefault: ~/.local/bin. Requires Bun >=1.4.0, Node >=24.20.0, pnpm and Git.\nA first uncached Herdr build also requires the manifest-pinned Rustup toolchain and Zig.",
    );
    return;
  }
  if (
    args.length !== 0 &&
    (args.length !== 2 || args[0] !== "--bin-dir" || !args[1] || args[1].startsWith("--"))
  ) {
    throw new InstallError("Expected no arguments or --bin-dir PATH; use --help");
  }
  await installLocal({
    root: resolve(import.meta.dir, ".."),
    binDir: args[1] ?? join(homedir(), ".local/bin"),
  });
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    console.error(`OLW_INSTALL_FAILED: ${error.message}`);
    process.exitCode = 1;
  }
}
