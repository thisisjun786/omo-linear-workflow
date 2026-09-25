import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { readChainReport, summarizeChains } from "../src/proxy/chain-check";
import { readReferencedModels, scopePreferenceSchema } from "../src/proxy/model-scope";
import { atomicText, digest, optionalText, receiptSchema } from "../src/proxy/routing-config";
import { globalOmo } from "../src/proxy/routing-launch";
import { RoutingError } from "../src/proxy/routing-plan";
import { syncRouting } from "../src/proxy/routing-sync";

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const command = args[0] ?? "status";
  if (!["status", "check", "sync", "scope", "chains"].includes(command))
    throw new RoutingError(
      "Usage: proxy:routing status|check|sync [--adopt] [--force] [--upstream PATH] [--catalog PATH] | chains | scope [referenced|all]",
    );
  const value = (name: string, fallback: string): string => {
    const index = args.indexOf(name);
    if (index < 0) return fallback;
    const result = args[index + 1];
    if (!result || result.startsWith("--")) throw new RoutingError(`${name} requires a path`);
    return result;
  };
  const home = process.env["HOME"] ?? "";
  const stateDir = value("--state-dir", join(home, ".omo/proxy-routing"));
  const chainPaths = {
    configPath: value("--config", join(home, ".omo/omo.jsonc")),
    catalogPath: value("--catalog", join(home, ".omo/agent/models.json")),
    stateDir,
  };
  if (command === "chains") {
    const report = await readChainReport(chainPaths);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }
  if (command === "scope") {
    const path = join(stateDir, "model-scope.json");
    const previous = await optionalText(path);
    const modeArgument = args[1]?.startsWith("--") ? undefined : args[1];
    const preference = scopePreferenceSchema.parse(
      modeArgument ? { mode: modeArgument } : previous ? JSON.parse(previous) : { mode: "all" },
    );
    const models =
      preference.mode === "referenced"
        ? await readReferencedModels(
            value("--config", join(home, ".omo/omo.jsonc")),
            value("--settings", join(home, ".omo/agent/settings.json")),
          )
        : undefined;
    let backup: string | undefined;
    if (modeArgument) {
      backup = join(stateDir, "backups", `model-scope-${crypto.randomUUID()}.json`);
      await atomicText(backup, previous ?? '{"mode":"all"}\n');
      await atomicText(path, `${JSON.stringify(preference, null, 2)}\n`);
    }
    process.stdout.write(`${JSON.stringify({ ...preference, models, backup }, null, 2)}\n`);
    return 0;
  }
  if (command === "status") {
    process.stdout.write(
      `${JSON.stringify(receiptSchema.parse(JSON.parse(await readFile(join(stateDir, "state.json"), "utf8"))), null, 2)}\n`,
    );
    return 0;
  }
  if (command === "sync" && !args.includes("--locked")) {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const entry = process.argv[1];
    if (!entry) throw new RoutingError("Routing command entry is missing");
    const child = Bun.spawn(
      [
        "flock",
        "--wait",
        "30",
        join(stateDir, "sync.lock"),
        process.execPath,
        entry,
        ...args,
        "--locked",
      ],
      { stdin: "ignore", stdout: "inherit", stderr: "inherit" },
    );
    return await child.exited;
  }
  const result = await syncRouting({
    upstream: args.includes("--upstream") ? value("--upstream", "") : globalOmo(),
    configPath: chainPaths.configPath,
    stateDir,
    catalogPath: chainPaths.catalogPath,
    adopt: args.includes("--adopt"),
    check: command === "check",
    force: args.includes("--force"),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  let report: Awaited<ReturnType<typeof readChainReport>>;
  try {
    report = await readChainReport(chainPaths);
  } catch (error) {
    // Like an unchanged routing start, an unreadable input must not block OMO by itself.
    process.stderr.write(
      `Proxy routing: fallback chain check skipped: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 0;
  }
  const summary = summarizeChains(report);
  // Known warnings are shown once per change, not on every start.
  const seenPath = join(stateDir, "chain-warnings.digest");
  const seen = digest(summary ?? "");
  const previous = await optionalText(seenPath);
  if (summary && previous !== seen) process.stderr.write(`Proxy routing: ${summary}\n`);
  if (command === "sync" && previous !== seen) await atomicText(seenPath, seen);
  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(
    `Proxy routing: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
