import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { readChainReport, summarizeChains } from "../src/proxy/chain-check";
import { exportedModels, planCatalog } from "../src/proxy/model-catalog";
import { readReferencedModels, scopePreferenceSchema } from "../src/proxy/model-scope";
import { atomicText, digest, optionalText, receiptSchema } from "../src/proxy/routing-config";
import { globalOmo } from "../src/proxy/routing-launch";
import { RoutingError } from "../src/proxy/routing-plan";
import {
  checkRoutingAdvice,
  dismissRoutingAdvice,
  saveRoutingBaseline,
  syncRouting,
} from "../src/proxy/routing-sync";

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const command = args[0] ?? "status";
  if (
    ![
      "status",
      "check",
      "sync",
      "apply",
      "dismiss",
      "baseline",
      "scope",
      "chains",
      "catalog",
    ].includes(command)
  )
    throw new RoutingError(
      "Usage: proxy:routing status|check|sync|apply <path...>|--all|dismiss <path...>|baseline save [--adopt] [--force] [--follow] [--upstream PATH] [--catalog PATH] | chains | catalog | scope [referenced|all]",
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
  if (command === "catalog") {
    const plan = planCatalog(
      exportedModels(JSON.parse(await readFile(chainPaths.catalogPath, "utf8"))),
    );
    const { models: _models, ...report } = plan;
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }
  const scopeMode = command === "scope" && !args[1]?.startsWith("--") ? args[1] : undefined;
  if (command === "scope" && scopeMode === undefined) {
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
    const receipt = receiptSchema.parse(
      JSON.parse(await readFile(join(stateDir, "state.json"), "utf8")),
    );
    const summary = await checkRoutingAdvice({
      upstream: args.includes("--upstream") ? value("--upstream", "") : globalOmo(),
      configPath: chainPaths.configPath,
      stateDir,
      catalogPath: chainPaths.catalogPath,
      adopt: false,
      check: true,
      force: true,
      managerSettingsPath: value("--settings", join(home, ".omo/agent/settings.json")),
    });
    process.stdout.write(
      `${JSON.stringify({ ...receipt, advice: summary.routes, catalogFindings: summary.catalog, summary }, null, 2)}\n`,
    );
    return 0;
  }
  const mutating =
    command === "sync" ||
    command === "apply" ||
    command === "dismiss" ||
    command === "baseline" ||
    scopeMode !== undefined;
  if (mutating && !args.includes("--locked")) {
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
  if (command === "scope") {
    const path = join(stateDir, "model-scope.json");
    const previous = await optionalText(path);
    const preference = scopePreferenceSchema.parse({ mode: scopeMode });
    const models =
      preference.mode === "referenced"
        ? await readReferencedModels(
            value("--config", join(home, ".omo/omo.jsonc")),
            value("--settings", join(home, ".omo/agent/settings.json")),
          )
        : undefined;
    const backup = join(stateDir, "backups", `model-scope-${crypto.randomUUID()}.json`);
    await atomicText(backup, previous ?? '{"mode":"all"}\n');
    await atomicText(path, `${JSON.stringify(preference, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ ...preference, models, backup }, null, 2)}\n`);
    return 0;
  }
  if (command === "baseline") {
    if (args[1] !== "save") throw new RoutingError("Usage: proxy:routing baseline save");
    const path = await saveRoutingBaseline(chainPaths.configPath, chainPaths.catalogPath, stateDir);
    process.stdout.write(`${JSON.stringify({ path }, null, 2)}\n`);
    return 0;
  }
  const optionNames = new Set(["--upstream", "--config", "--state-dir", "--catalog", "--settings"]);
  const positional = args.slice(1).filter((arg, index) => {
    if (arg.startsWith("--")) return false;
    return !optionNames.has(args[index] ?? "");
  });
  if (command === "dismiss") {
    if (!positional.length) throw new RoutingError("dismiss requires at least one routing path");
    process.stdout.write(
      `${JSON.stringify(await dismissRoutingAdvice(stateDir, positional), null, 2)}\n`,
    );
    return 0;
  }
  const result = await syncRouting({
    upstream: args.includes("--upstream") ? value("--upstream", "") : globalOmo(),
    configPath: chainPaths.configPath,
    stateDir,
    catalogPath: chainPaths.catalogPath,
    adopt: args.includes("--adopt"),
    check: command === "check",
    force: args.includes("--force"),
    managerSettingsPath: value("--settings", join(home, ".omo/agent/settings.json")),
    ...(args.includes("--follow") ? { routingPolicy: "follow" as const } : {}),
    ...(command === "apply"
      ? {
          apply: args.includes("--all") ? ("all" as const) : positional,
        }
      : {}),
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
