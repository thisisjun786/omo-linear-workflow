import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { type HerdrArtifact, loadHerdrBuild, resolveHerdrArtifact } from "./artifact";
import { prepareHerdrSource, runHerdrBuildCommand } from "./source";

export interface HerdrBuildOptions {
  readonly cargo?: string;
  readonly zig?: string;
}

export async function ensureHerdrBuild(
  root: string,
  options: HerdrBuildOptions = {},
): Promise<HerdrArtifact> {
  const build = await loadHerdrBuild(root);
  if (await Bun.file(build.receiptPath).exists()) return resolveHerdrArtifact(root);
  const cargo = Bun.which(options.cargo ?? process.env["CARGO"] ?? "cargo");
  if (!cargo) throw new Error("Cargo executable unavailable; install Rustup or set CARGO");
  const zig = Bun.which(options.zig ?? process.env["ZIG"] ?? "zig");
  if (!zig) throw new Error(`Zig ${build.manifest.zigVersion} unavailable; set ZIG`);
  const cargoVersion = await runHerdrBuildCommand(
    [cargo, `+${build.manifest.rustToolchain}`, "--version"],
    root,
    { capture: true },
  );
  if (!cargoVersion.startsWith(`cargo ${build.manifest.rustToolchain} `)) {
    throw new Error(`Cargo toolchain mismatch: ${cargoVersion}`);
  }
  const zigVersion = await runHerdrBuildCommand([zig, "version"], root, { capture: true });
  if (zigVersion !== build.manifest.zigVersion) {
    throw new Error(`Zig version mismatch: ${zigVersion}`);
  }
  await prepareHerdrSource(build);
  const env = {
    ...process.env,
    PATH: [dirname(cargo), dirname(zig), process.env["PATH"] ?? ""].join(delimiter),
    CARGO_TARGET_DIR: build.targetDir,
    CARGO_BUILD_JOBS:
      process.env["CARGO_BUILD_JOBS"] ?? String(Math.min(8, availableParallelism())),
    ZIG: zig,
    HERDR_BUILD_COMMIT: build.manifest.revision,
  };
  const cargoCommand = [cargo, `+${build.manifest.rustToolchain}`];
  await runHerdrBuildCommand([...cargoCommand, "fmt", "--all", "--", "--check"], build.sourceDir, {
    env,
  });
  await runHerdrBuildCommand(
    [...cargoCommand, "test", "--locked", "--bin", "herdr", "senpi"],
    build.sourceDir,
    { env },
  );
  await runHerdrBuildCommand(
    [process.execPath, "test", "src/integration/assets/senpi/herdr-agent-state.test.ts"],
    build.sourceDir,
    { env },
  );
  await runHerdrBuildCommand(
    [...cargoCommand, "build", "--release", "--locked", "--bin", "herdr"],
    build.sourceDir,
    { env },
  );
  const name = process.platform === "win32" ? "herdr.exe" : "herdr";
  const executable = join(build.targetDir, "release", name);
  const version = await runHerdrBuildCommand([executable, "--version"], build.sourceDir, {
    capture: true,
  });
  if (version !== `herdr ${build.manifest.version}`) {
    throw new Error(`Built Herdr version mismatch: ${version}`);
  }
  const binarySha256 = new Bun.CryptoHasher("sha256")
    .update(await readFile(executable))
    .digest("hex");
  await mkdir(dirname(build.artifactDir), { recursive: true });
  const staging = await mkdtemp(join(dirname(build.artifactDir), "publish-"));
  try {
    await copyFile(executable, join(staging, name));
    await chmod(join(staging, name), 0o755);
    await copyFile(join(root, "vendor/herdr/LICENSE"), join(staging, "LICENSE"));
    await writeFile(
      join(staging, "build.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          sourceKey: build.sourceKey,
          version: build.manifest.version,
          revision: build.manifest.revision,
          patchSha256: build.manifest.patchSha256,
          rustToolchain: build.manifest.rustToolchain,
          zigVersion: build.manifest.zigVersion,
          platform: process.platform,
          arch: process.arch,
          binarySha256,
          builtAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    await rename(staging, build.artifactDir);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  const artifact = await resolveHerdrArtifact(root);
  process.stdout.write(`HERDR_BUILD_OK ${artifact.binaryPath}\n`);
  return artifact;
}
