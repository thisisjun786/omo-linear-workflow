import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadHerdrBuild } from "../../src/herdr/artifact";
import { ensureHerdrBuild } from "../../src/herdr/build";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const hash = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "olw-herdr-build-"));
  roots.push(root);
  await mkdir(join(root, "vendor/herdr"), { recursive: true });
  await mkdir(join(root, "patches"));
  const patch = "fixture patch\n";
  await writeFile(join(root, "patches/herdr.patch"), patch);
  const manifest = {
    schemaVersion: 1,
    version: "0.9.1",
    repository: "https://example.invalid/herdr.git",
    revision: "a".repeat(40),
    rustToolchain: "1.96.1",
    zigVersion: "0.16.0",
    patch: "patches/herdr.patch",
    patchSha256: hash(patch),
    referenceBinarySha256: "b".repeat(64),
  };
  await writeFile(join(root, "vendor/herdr/manifest.json"), JSON.stringify(manifest));
  return { root, build: await loadHerdrBuild(root) };
}

test("a verified managed build is reused without a compiler or source download", async () => {
  const { root, build } = await fixture();
  const executable = "#!/bin/sh\nexit 0\n";
  await mkdir(build.artifactDir, { recursive: true });
  await writeFile(build.binaryPath, executable, { mode: 0o700 });
  await writeFile(
    build.receiptPath,
    JSON.stringify({
      schemaVersion: 1,
      sourceKey: build.sourceKey,
      version: build.manifest.version,
      revision: build.manifest.revision,
      patchSha256: build.manifest.patchSha256,
      rustToolchain: build.manifest.rustToolchain,
      zigVersion: build.manifest.zigVersion,
      platform: process.platform,
      arch: process.arch,
      binarySha256: hash(executable),
      builtAt: new Date().toISOString(),
    }),
  );
  const result = await ensureHerdrBuild(root, { cargo: join(root, "missing-cargo") });
  expect(result.binaryPath).toBe(build.binaryPath);
  expect(await Bun.file(join(build.sourceDir, "Cargo.toml")).exists()).toBe(false);
});

test("missing compiler fails before fetching source or publishing an artifact", async () => {
  const { root, build } = await fixture();
  await expect(ensureHerdrBuild(root, { cargo: join(root, "missing-cargo") })).rejects.toThrow(
    /Cargo executable/,
  );
  expect(await Bun.file(build.receiptPath).exists()).toBe(false);
});

test("a different Cargo toolchain is rejected before source preparation", async () => {
  const { root, build } = await fixture();
  const cargo = join(root, "tools/cargo");
  const zig = join(root, "tools/zig");
  await mkdir(dirname(cargo), { recursive: true });
  await writeFile(cargo, "#!/bin/sh\nprintf 'cargo 0.0.0\\n'\n", { mode: 0o700 });
  await writeFile(zig, "#!/bin/sh\nprintf '0.16.0\\n'\n", { mode: 0o700 });
  await expect(ensureHerdrBuild(root, { cargo, zig })).rejects.toThrow(/Cargo toolchain/);
  expect(await Bun.file(join(build.sourceDir, "Cargo.toml")).exists()).toBe(false);
  expect(await Bun.file(build.receiptPath).exists()).toBe(false);
});
