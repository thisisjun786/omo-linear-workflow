import { delimiter, join, resolve } from "node:path";
import { RoutingError } from "./routing-plan";

/** Resolve the global installation, never this wrapper or a repository's pinned CLI. */
export function globalOmo(): string {
  const wrapperDirectory = resolve(process.env["HOME"] ?? "", ".local/bin");
  const path = (process.env["PATH"] ?? "")
    .split(delimiter)
    .filter((entry) => resolve(entry) !== wrapperDirectory && !entry.includes("/node_modules/"));
  const executable = Bun.which("omo", { PATH: path.join(delimiter) });
  if (!executable)
    throw new RoutingError("Global OMO executable is unavailable outside the managed wrapper");
  return executable;
}

export async function ensureRouting(root: string, upstream = globalOmo()): Promise<void> {
  const child = Bun.spawn(
    [process.execPath, join(root, "dist/proxy/routing.js"), "sync", "--upstream", upstream],
    { stdin: "ignore", stdout: "ignore", stderr: "inherit" },
  );
  const code = await child.exited;
  if (code !== 0)
    throw new RoutingError(
      `Upstream routing check failed (${code}); previous settings were retained`,
    );
}
