import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const manifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  version: z.string().min(1),
  repository: z.url(),
  revision: z.string().regex(/^[0-9a-f]{40}$/),
  rustToolchain: z.string().min(1),
  zigVersion: z.string().min(1),
  patch: z.string().min(1),
  patchSha256: sha256Schema,
  referenceBinarySha256: sha256Schema,
});
const receiptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sourceKey: sha256Schema,
  version: z.string().min(1),
  revision: z.string().min(1),
  patchSha256: sha256Schema,
  rustToolchain: z.string().min(1),
  zigVersion: z.string().min(1),
  platform: z.string().min(1),
  arch: z.string().min(1),
  binarySha256: sha256Schema,
  builtAt: z.iso.datetime(),
});

export type HerdrManifest = z.output<typeof manifestSchema>;
export type HerdrBuildReceipt = z.output<typeof receiptSchema>;

export interface HerdrBuild {
  readonly manifest: HerdrManifest;
  readonly sourceKey: string;
  readonly patchPath: string;
  readonly sourceDir: string;
  readonly targetDir: string;
  readonly artifactDir: string;
  readonly binaryPath: string;
  readonly receiptPath: string;
}

export interface HerdrArtifact extends HerdrBuild {
  readonly receipt: HerdrBuildReceipt;
}

function sha256(content: string | Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(content).digest("hex");
}

function managedArtifactError(message: string): Error {
  return new Error(
    `${message}; inspect and move the affected .omo/herdr/bin artifact directory aside, then run bun run herdr:build from the OLW root`,
  );
}

async function parseJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function loadHerdrBuild(root: string): Promise<HerdrBuild> {
  const resolvedRoot = resolve(root);
  const manifestPath = join(resolvedRoot, "vendor/herdr/manifest.json");
  const manifest = manifestSchema.parse(await parseJson(manifestPath));
  if (isAbsolute(manifest.patch)) {
    throw new Error(`Managed Herdr patch path must be relative: ${manifest.patch}`);
  }
  const patchPath = resolve(resolvedRoot, manifest.patch);
  const patchRelative = relative(resolvedRoot, patchPath);
  if (patchRelative === "" || patchRelative.startsWith("..") || isAbsolute(patchRelative)) {
    throw new Error(`Managed Herdr patch path escapes the OLW root: ${manifest.patch}`);
  }
  const patchSha256 = sha256(await readFile(patchPath));
  if (patchSha256 !== manifest.patchSha256) {
    throw new Error(
      `Managed Herdr patch SHA256 mismatch: expected ${manifest.patchSha256}, received ${patchSha256}`,
    );
  }
  const sourceKey = sha256(JSON.stringify(manifest));
  const sourceDir = join(resolvedRoot, ".omo/herdr/sources", sourceKey);
  const targetDir = join(resolvedRoot, ".omo/herdr/target");
  const artifactDir = join(
    resolvedRoot,
    ".omo/herdr/bin",
    `${sourceKey}-${process.platform}-${process.arch}`,
  );
  const binaryPath = join(artifactDir, process.platform === "win32" ? "herdr.exe" : "herdr");
  return {
    manifest,
    sourceKey,
    patchPath,
    sourceDir,
    targetDir,
    artifactDir,
    binaryPath,
    receiptPath: join(artifactDir, "build.json"),
  };
}

export async function resolveHerdrArtifact(root: string): Promise<HerdrArtifact> {
  const build = await loadHerdrBuild(root);
  let receipt: HerdrBuildReceipt;
  try {
    receipt = receiptSchema.parse(await parseJson(build.receiptPath));
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw managedArtifactError(`Managed Herdr build receipt is missing or invalid (${detail})`);
  }
  const receiptFields = [
    ["sourceKey", build.sourceKey, receipt.sourceKey],
    ["version", build.manifest.version, receipt.version],
    ["revision", build.manifest.revision, receipt.revision],
    ["patchSha256", build.manifest.patchSha256, receipt.patchSha256],
    ["rustToolchain", build.manifest.rustToolchain, receipt.rustToolchain],
    ["zigVersion", build.manifest.zigVersion, receipt.zigVersion],
    ["platform", process.platform, receipt.platform],
    ["arch", process.arch, receipt.arch],
  ];
  for (const [field, expected, received] of receiptFields) {
    if (received !== expected) {
      throw managedArtifactError(
        `Managed Herdr receipt ${field} mismatch: expected ${expected}, received ${received}`,
      );
    }
  }
  let binary: Uint8Array;
  try {
    await access(build.binaryPath, constants.X_OK);
    binary = await readFile(build.binaryPath);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw managedArtifactError(`Managed Herdr executable is missing or not executable (${detail})`);
  }
  const binarySha256 = sha256(binary);
  if (binarySha256 !== receipt.binarySha256) {
    throw managedArtifactError(
      `Managed Herdr binary SHA256 mismatch: expected ${receipt.binarySha256}, received ${binarySha256}`,
    );
  }
  return { ...build, receipt };
}
