import { dirname, join, resolve } from "node:path";
import { modelScopeArguments } from "./model-scope";
import { ensureRouting, globalOmo } from "./routing-launch";

// Inspection and maintenance commands stay usable when the proxy is offline.
const INSPECTION_FLAGS = new Set(["--version", "-v", "--help", "-h"]);
const MAINTENANCE_COMMANDS = new Set([
  "install",
  "remove",
  "list",
  "config",
  "auth",
  "setup",
  "update",
]);

export interface LaunchDependencies {
  readonly upstream: () => string;
  readonly ensureRouting: (root: string, upstream: string) => Promise<void>;
  readonly scopeArguments: (home: string, flags: readonly string[]) => Promise<string[]>;
  readonly warn: (line: string) => void;
}

export const launchDependencies: LaunchDependencies = {
  upstream: globalOmo,
  ensureRouting,
  scopeArguments: modelScopeArguments,
  warn: (line) => process.stderr.write(line),
};

/** A failed preflight keeps the previous routing, so OMO still starts with a warning. */
export async function interactiveLaunch(
  root: string,
  home: string,
  args: readonly string[],
  deps: LaunchDependencies = launchDependencies,
): Promise<string[]> {
  const upstream = deps.upstream();
  const flags = args.slice(0, args.includes("--") ? args.indexOf("--") : args.length);
  const inspection =
    flags.some((arg) => INSPECTION_FLAGS.has(arg)) || MAINTENANCE_COMMANDS.has(args[0] ?? "");
  if (inspection) return [upstream, ...args];
  try {
    await deps.ensureRouting(root, upstream);
  } catch (error) {
    deps.warn(
      `OMO routing preflight: ${error instanceof Error ? error.message : String(error)}; starting OMO with the previous routing\n`,
    );
  }
  const scopeArgs = await deps.scopeArguments(home, flags).catch((error: unknown) => {
    deps.warn(
      `OMO model scope: ${error instanceof Error ? error.message : String(error)}; starting without a scope limit\n`,
    );
    return [];
  });
  return [upstream, "-e", join(root, "dist/extension/model-catalog.js"), ...scopeArgs, ...args];
}

export function launcherRoot(scriptPath: string): string {
  return resolve(dirname(scriptPath), "..");
}
