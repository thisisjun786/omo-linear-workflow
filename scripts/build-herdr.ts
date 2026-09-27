import { resolve } from "node:path";
import { ensureHerdrBuild } from "../src/herdr/build";

const root = resolve(import.meta.dir, "..");
const artifact = await ensureHerdrBuild(root);
process.stdout.write(
  `${JSON.stringify({
    result: "HERDR_READY",
    binary: artifact.binaryPath,
    version: artifact.manifest.version,
    url: artifact.url,
    sha256: artifact.asset.sha256,
  })}\n`,
);
