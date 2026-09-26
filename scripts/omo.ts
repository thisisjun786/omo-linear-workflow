import { interactiveLaunch, launcherRoot } from "../src/proxy/interactive-launch";

try {
  const command = await interactiveLaunch(
    launcherRoot(process.argv[1] ?? ""),
    process.env["HOME"] ?? "",
    process.argv.slice(2),
  );
  const child = Bun.spawn(command, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
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
  process.stderr.write(`OMO launcher: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
