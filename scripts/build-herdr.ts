import { resolve } from "node:path";
import { ensureHerdrBuild } from "../src/herdr/build";

const root = resolve(import.meta.dir, "..");
const artifact = await ensureHerdrBuild(root);
process.stdout.write(
  `${JSON.stringify({
    result: "HERDR_READY",
    binary: artifact.binaryPath,
    sourceKey: artifact.sourceKey,
    sha256: artifact.receipt.binarySha256,
  })}\n`,
);
