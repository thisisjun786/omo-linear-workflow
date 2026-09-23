import { dirname, resolve } from "node:path";
import { modelScopeArguments } from "../src/proxy/model-scope";
import { ensureRouting, globalOmo } from "../src/proxy/routing-launch";

const upstream = globalOmo();
const args = process.argv.slice(2);
// Inspection and maintenance commands stay usable when the proxy is offline.
const flags = args.slice(0, args.includes("--") ? args.indexOf("--") : args.length);
const inspection =
  flags.some((arg) => ["--version", "-v", "--help", "-h"].includes(arg)) ||
  ["install", "remove", "list", "config", "auth", "setup", "update"].includes(args[0] ?? "");
try {
  if (!inspection) await ensureRouting(resolve(dirname(process.argv[1] ?? ""), ".."), upstream);
  const scopeArgs = inspection ? [] : await modelScopeArguments(process.env["HOME"] ?? "", flags);
  const child = Bun.spawn([upstream, ...scopeArgs, ...args], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const forward = (signal: NodeJS.Signals) => child.kill(signal);
  const interrupt = () => forward("SIGINT");
  const terminate = () => forward("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    process.exitCode = await child.exited;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
} catch (error) {
  process.stderr.write(
    `OMO routing preflight: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
