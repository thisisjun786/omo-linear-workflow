import { chmod, lstat, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type HerdrArtifact,
  loadHerdrBuild,
  resolveHerdrArtifact,
  verifyHerdrChecksum,
} from "./artifact";

export interface HerdrBuildOptions {
  readonly download?: (url: string) => Promise<Response>;
}

/** Publish a checksum-verified official asset; existing caches are never overwritten. */
export async function ensureHerdrBuild(
  root: string,
  options: HerdrBuildOptions = {},
): Promise<HerdrArtifact> {
  const artifact = await loadHerdrBuild(root);
  let occupied = false;
  try {
    await lstat(artifact.artifactDir);
    occupied = true;
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
  }
  if (occupied) return resolveHerdrArtifact(root);
  const download =
    options.download ?? ((url: string) => fetch(url, { signal: AbortSignal.timeout(120_000) }));
  const response = await download(artifact.url);
  if (!response.ok) throw new Error(`Official Herdr download failed: HTTP ${response.status}`);
  const binary = new Uint8Array(await response.arrayBuffer());
  verifyHerdrChecksum(binary, artifact.asset.sha256);
  await mkdir(dirname(artifact.artifactDir), { recursive: true });
  const staging = await mkdtemp(join(dirname(artifact.artifactDir), "download-"));
  try {
    const path = join(staging, "herdr");
    await writeFile(path, binary, { mode: 0o700 });
    await chmod(path, 0o755);
    await rename(staging, artifact.artifactDir);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  const verified = await resolveHerdrArtifact(root);
  process.stdout.write(`HERDR_RELEASE_OK ${verified.binaryPath}\n`);
  return verified;
}
