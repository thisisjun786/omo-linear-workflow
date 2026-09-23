import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { HerdrBuild } from "./artifact";

export async function runHerdrBuildCommand(
  command: readonly string[],
  cwd: string,
  options: { readonly env?: NodeJS.ProcessEnv; readonly capture?: boolean } = {},
): Promise<string> {
  const child = Bun.spawn([...command], {
    cwd,
    env: options.env ?? process.env,
    stdin: "inherit",
    stdout: options.capture ? "pipe" : "inherit",
    stderr: "inherit",
  });
  const output = child.stdout ? new Response(child.stdout).text() : Promise.resolve("");
  const [code, text] = await Promise.all([child.exited, output]);
  if (code !== 0) throw new Error(`${command.join(" ")} exited ${code}`);
  return text.trim();
}

const sourceStampSchema = z.strictObject({
  sourceKey: z.string(),
  revision: z.string(),
  patchSha256: z.string(),
});

export async function prepareHerdrSource(build: HerdrBuild): Promise<void> {
  const stampName = ".olw-source.json";
  const existing = Bun.file(join(build.sourceDir, stampName));
  if (await existing.exists()) {
    const stamp = sourceStampSchema.parse(await existing.json());
    if (
      stamp.sourceKey !== build.sourceKey ||
      stamp.revision !== build.manifest.revision ||
      stamp.patchSha256 !== build.manifest.patchSha256
    ) {
      throw new Error(`Managed Herdr source identity mismatch at ${build.sourceDir}`);
    }
    return;
  }
  await mkdir(dirname(build.sourceDir), { recursive: true });
  const staging = await mkdtemp(join(dirname(build.sourceDir), "prepare-"));
  try {
    await runHerdrBuildCommand(["git", "init", "--quiet"], staging);
    await runHerdrBuildCommand(
      ["git", "remote", "add", "origin", build.manifest.repository],
      staging,
    );
    await runHerdrBuildCommand(
      ["git", "fetch", "--depth=1", "--no-tags", "origin", build.manifest.revision],
      staging,
    );
    await runHerdrBuildCommand(["git", "checkout", "--detach", "--quiet", "FETCH_HEAD"], staging);
    const actual = await runHerdrBuildCommand(["git", "rev-parse", "HEAD"], staging, {
      capture: true,
    });
    if (actual !== build.manifest.revision) throw new Error(`Unexpected Herdr revision ${actual}`);
    await runHerdrBuildCommand(["git", "apply", "--check", build.patchPath], staging);
    await runHerdrBuildCommand(["git", "apply", build.patchPath], staging);
    const toolchain = z
      .object({
        toolchain: z.object({ channel: z.string() }),
      })
      .parse(Bun.TOML.parse(await readFile(join(staging, "rust-toolchain.toml"), "utf8")));
    if (toolchain.toolchain.channel !== build.manifest.rustToolchain) {
      throw new Error("Herdr source Rust toolchain does not match its manifest");
    }
    await writeFile(
      join(staging, stampName),
      JSON.stringify({
        sourceKey: build.sourceKey,
        revision: build.manifest.revision,
        patchSha256: build.manifest.patchSha256,
      }),
    );
    await rename(staging, build.sourceDir);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
