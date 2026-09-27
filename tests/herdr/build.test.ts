import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHerdrBuild } from "../../src/herdr/artifact";
import { ensureHerdrBuild } from "../../src/herdr/build";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(assets: unknown) {
  const root = await mkdtemp(join(tmpdir(), "olw-herdr-download-"));
  roots.push(root);
  await writeFile(
    join(root, "herdr-release.json"),
    JSON.stringify({ schemaVersion: 1, version: "0.9.1", assets }),
  );
  return root;
}
test("unsupported platforms fail before downloading", async () => {
  const root = await fixture({});
  await expect(
    ensureHerdrBuild(root, {
      download: async () => {
        throw new Error("network called");
      },
    }),
  ).rejects.toThrow("No pinned official Herdr asset");
});
test("unrecognized asset names and invalid checksums are rejected", async () => {
  for (const asset of [
    { name: "../../foreign", sha256: "a".repeat(64) },
    { name: "herdr-linux-x86_64", sha256: "not-a-checksum" },
  ]) {
    const root = await fixture({ [`${process.platform}-${process.arch}`]: asset });
    await expect(loadHerdrBuild(root)).rejects.toThrow();
  }
});
test("a partial occupied artifact is rejected instead of overwritten", async () => {
  const root = await fixture({
    [`${process.platform}-${process.arch}`]: { name: "herdr-linux-x86_64", sha256: "a".repeat(64) },
  });
  const artifact = await loadHerdrBuild(root);
  await mkdir(artifact.artifactDir, { recursive: true });
  await expect(
    ensureHerdrBuild(root, {
      download: async () => {
        throw new Error("network called");
      },
    }),
  ).rejects.toThrow("bun run herdr:build");
});
