import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHerdr } from "../../scripts/herdr";
import {
  type HerdrBuildReceipt,
  type HerdrManifest,
  loadHerdrBuild,
  resolveHerdrArtifact,
} from "../../src/herdr/artifact";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "olw-herdr-artifact-"));
  roots.push(root);
  const patch = "fixture patch\n";
  const patchSha256 = new Bun.CryptoHasher("sha256").update(patch).digest("hex");
  const manifest: HerdrManifest = {
    schemaVersion: 1,
    version: "0.9.1",
    repository: "https://example.test/herdr.git",
    revision: "1".repeat(40),
    rustToolchain: "1.96.1",
    zigVersion: "0.16.0",
    patch: "patches/herdr.patch",
    patchSha256,
    referenceBinarySha256: "0".repeat(64),
  };
  await mkdir(join(root, "vendor/herdr"), { recursive: true });
  await mkdir(join(root, "patches"), { recursive: true });
  await writeFile(join(root, "vendor/herdr/manifest.json"), JSON.stringify(manifest));
  await writeFile(join(root, manifest.patch), patch);
  return { root, manifest };
}

async function installArtifact(root: string) {
  const build = await loadHerdrBuild(root);
  const binary = '#!/bin/sh\noutput=$1\nshift\nprintf \'%s\\n\' "$HOME" "$@" > "$output"\n';
  await mkdir(build.artifactDir, { recursive: true });
  await writeFile(build.binaryPath, binary, { mode: 0o700 });
  await chmod(build.binaryPath, 0o700);
  const binarySha256 = new Bun.CryptoHasher("sha256").update(binary).digest("hex");
  const receipt: HerdrBuildReceipt = {
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
    builtAt: "2026-09-23T00:00:00.000Z",
  };
  await writeFile(build.receiptPath, JSON.stringify(receipt));
  return { build, receipt };
}

describe("managed Herdr artifact", () => {
  test("loads a validated manifest and verifies its owned patch", async () => {
    const { root, manifest } = await fixture();
    const build = await loadHerdrBuild(root);
    expect(build.manifest).toEqual(manifest);
    expect(build.sourceKey).toBe(
      new Bun.CryptoHasher("sha256").update(JSON.stringify(manifest)).digest("hex"),
    );
    expect(build.sourceDir).toBe(join(root, ".omo/herdr/sources", build.sourceKey));
    expect(build.targetDir).toBe(join(root, ".omo/herdr/target"));
    expect(build.artifactDir).toBe(
      join(root, ".omo/herdr/bin", `${build.sourceKey}-${process.platform}-${process.arch}`),
    );
  });

  test.each(["/tmp/foreign.patch", "../foreign.patch", "patches/../../foreign.patch"])(
    "rejects an absolute or escaping patch path: %s",
    async (patch) => {
      const { root, manifest } = await fixture();
      await writeFile(
        join(root, "vendor/herdr/manifest.json"),
        JSON.stringify({ ...manifest, patch }),
      );
      expect(loadHerdrBuild(root)).rejects.toThrow("patch path");
    },
  );

  test("rejects a non-commit manifest revision", async () => {
    const { root, manifest } = await fixture();
    await writeFile(
      join(root, "vendor/herdr/manifest.json"),
      JSON.stringify({ ...manifest, revision: "main" }),
    );
    expect(loadHerdrBuild(root)).rejects.toThrow();
  });

  test("rejects patch tampering", async () => {
    const { root, manifest } = await fixture();
    await writeFile(join(root, manifest.patch), "tampered\n");
    expect(loadHerdrBuild(root)).rejects.toThrow("patch SHA256");
  });

  test("validates the receipt and executable digest", async () => {
    const { root } = await fixture();
    const { build, receipt } = await installArtifact(root);
    expect(await resolveHerdrArtifact(root)).toEqual({ ...build, receipt });
    await writeFile(build.binaryPath, "#!/bin/sh\nexit 1\n");
    expect(resolveHerdrArtifact(root)).rejects.toThrow("binary SHA256");
  });

  test("rejects stale receipt fields", async () => {
    const { root } = await fixture();
    const { build, receipt } = await installArtifact(root);
    await writeFile(build.receiptPath, JSON.stringify({ ...receipt, revision: "stale" }));
    expect(resolveHerdrArtifact(root)).rejects.toThrow("receipt revision");
  });

  test("missing managed artifact never resolves a global Herdr from PATH", async () => {
    const { root } = await fixture();
    const globalBin = join(root, "global-bin");
    await mkdir(globalBin);
    await writeFile(join(globalBin, "herdr"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "../../src/cli.ts"),
        "--root",
        root,
        "doctor",
        "--json",
      ],
      {
        env: { ...process.env, PATH: globalBin },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stdout] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(3);
    expect(JSON.parse(stdout)).toMatchObject({
      ok: false,
      error: {
        code: "runtime_unavailable",
        message: expect.stringContaining("bun run herdr:build"),
      },
    });
  });

  test("scripts/herdr forwards arbitrary argv with inherited environment", async () => {
    const { root } = await fixture();
    await installArtifact(root);
    const output = join(root, "forwarded.txt");
    expect(await runHerdr([output, "space value", "--flag", ""], root)).toBe(0);
    expect(await Bun.file(output).text()).toBe(
      `${process.env["HOME"] ?? ""}\nspace value\n--flag\n\n`,
    );
  });
});
