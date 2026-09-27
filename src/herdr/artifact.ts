import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";

const assetSchema = z.strictObject({
  name: z.enum([
    "herdr-linux-x86_64",
    "herdr-linux-aarch64",
    "herdr-macos-x86_64",
    "herdr-macos-aarch64",
  ]),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
const manifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  assets: z.record(z.string(), assetSchema),
});
export type HerdrManifest = z.output<typeof manifestSchema>;
export interface HerdrArtifact {
  readonly manifest: HerdrManifest;
  readonly asset: z.output<typeof assetSchema>;
  readonly url: string;
  readonly artifactDir: string;
  readonly binaryPath: string;
}

export function verifyHerdrChecksum(binary: Uint8Array, expected: string): void {
  const actual = new Bun.CryptoHasher("sha256").update(binary).digest("hex");
  if (actual !== expected)
    throw new Error(`Managed Herdr SHA256 mismatch: expected ${expected}, received ${actual}`);
}

/** Resolve only this checkout's pinned official release, never a PATH installation. */
export async function loadHerdrBuild(root: string): Promise<HerdrArtifact> {
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(join(root, "herdr-release.json"), "utf8")),
  );
  const target = `${process.platform}-${process.arch}`;
  const asset = manifest.assets[target];
  if (asset === undefined) throw new Error(`No pinned official Herdr asset for ${target}`);
  const artifactDir = join(
    resolve(root),
    ".omo/herdr/bin",
    `v${manifest.version}-${target}-${asset.sha256}`,
  );
  return {
    manifest,
    asset,
    url: `https://github.com/herdrdev/herdr/releases/download/v${manifest.version}/${asset.name}`,
    artifactDir,
    binaryPath: join(artifactDir, "herdr"),
  };
}

export async function resolveHerdrArtifact(root: string): Promise<HerdrArtifact> {
  const artifact = await loadHerdrBuild(root);
  try {
    await access(artifact.binaryPath, constants.X_OK);
    verifyHerdrChecksum(await readFile(artifact.binaryPath), artifact.asset.sha256);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `${detail}; inspect and move only the affected ${artifact.artifactDir} aside, then run bun run herdr:build from the OLW root`,
      { cause },
    );
  }
  return artifact;
}
