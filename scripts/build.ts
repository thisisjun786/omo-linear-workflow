import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { ensureHerdrBuild } from "../src/herdr/build";

const root = join(import.meta.dir, "..");
const output = join(root, "dist");
await ensureHerdrBuild(root);
await rm(output, { recursive: true, force: true });
await mkdir(join(output, "core"), { recursive: true });
await mkdir(join(output, "extension"), { recursive: true });
await mkdir(join(output, "proxy"), { recursive: true });

async function build(entrypoint: string, outfile: string, target: "bun" | "node"): Promise<void> {
  const result = await Bun.build({
    entrypoints: [join(root, entrypoint)],
    outdir: join(root, outfile, ".."),
    naming: outfile.split("/").at(-1) ?? "[name].[ext]",
    target,
    format: "esm",
    packages: "external",
    sourcemap: "external",
    minify: false,
  });
  if (!result.success) {
    for (const log of result.logs) process.stderr.write(`${log.message}\n`);
    throw new Error(`Build failed for ${entrypoint}`);
  }
}

await build("src/cli.ts", "dist/cli.js", "bun");
await build("src/core/worker.ts", "dist/core/worker.js", "bun");
await build("src/extension/index.ts", "dist/extension/index.js", "node");
await build("src/extension/model-catalog.ts", "dist/extension/model-catalog.js", "node");
await build("scripts/proxy-routing.ts", "dist/proxy/routing.js", "bun");
await build("scripts/omo.ts", "dist/omo.js", "bun");
process.stdout.write(
  "Built CLI, worker, extensions, routing synchronizer and managed OMO launcher\n",
);
