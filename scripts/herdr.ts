#!/usr/bin/env bun
import { join } from "node:path";
import { resolveHerdrArtifact } from "../src/herdr/artifact";

export async function runHerdr(
  argv: readonly string[],
  root = join(import.meta.dir, ".."),
): Promise<number> {
  const artifact = await resolveHerdrArtifact(root);
  const child = Bun.spawn([artifact.binaryPath, ...argv], {
    cwd: process.cwd(),
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return child.exited;
}

if (import.meta.main) process.exitCode = await runHerdr(process.argv.slice(2));
