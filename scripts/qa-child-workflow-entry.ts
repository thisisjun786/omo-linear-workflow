import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { globalOmo } from "../src/proxy/routing-launch";
import { checkedQaCommand, runQaCommand } from "./qa-world";

const mode = process.argv[2];
assert.ok(mode === "happy" || mode === "failed-node", "Expected happy|failed-node");
const root = resolve(import.meta.dir, "..");
const originalHome = process.env["HOME"];
assert.ok(originalHome);
const upstream = globalOmo();
const home = await mkdtemp(join(tmpdir(), "olw-child-qa-home-"));
const agent = join(home, ".omo/agent");
const artifact = join(root, ".omo/herdr");
let linked = false;
const receipt = { home, homeRemoved: false, artifactLinkRemoved: false, code: -1 };
try {
  await mkdir(agent, { recursive: true });
  await writeFile(join(home, ".zshrc"), "# Isolated QA shell.\n");
  for (const file of ["auth.json", "models.json", "settings.json"])
    await cp(join(originalHome, ".omo/agent", file), join(agent, file));
  await cp(join(originalHome, ".omo/omo.jsonc"), join(home, ".omo/omo.jsonc"));
  const bin = join(home, "bin");
  await mkdir(bin);
  await symlink(upstream, join(bin, "omo"));
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(PI_|HERDR_|OLW_|OMO_|SENPI_)/.test(key)) delete env[key];
  }
  Object.assign(env, {
    HOME: home,
    HERDR_ENV: "1",
    OMO_CODING_AGENT_DIR: agent,
    SENPI_CODING_AGENT_DIR: agent,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local/state"),
    PATH: `${bin}:${process.env["PATH"]}`,
  });
  if (!existsSync(artifact)) {
    await symlink("/home/jun/code/omo-linear-workflow/.omo/herdr", artifact);
    linked = true;
  }
  await checkedQaCommand(["bun", "run", "build"], root, env);
  await checkedQaCommand(
    ["bun", join(root, "dist/proxy/routing.js"), "sync", "--adopt", "--upstream", join(bin, "omo")],
    root,
    env,
  );
  await writeFile(
    join(agent, "trust.json"),
    JSON.stringify({ [join(root, ".omo/evidence")]: true }),
  );
  const result = await runQaCommand(
    ["bun", join(root, "scripts/qa-child-workflow.ts"), mode],
    root,
    env,
  );
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  receipt.code = result.code;
  process.exitCode = result.code;
} finally {
  await rm(home, { recursive: true, force: true });
  receipt.homeRemoved = !existsSync(home);
  if (linked) await rm(artifact);
  receipt.artifactLinkRemoved = !existsSync(artifact);
  const directory = join(root, ".omo/evidence/child-mass-ulw");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `${mode}-isolation.json`),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
}
