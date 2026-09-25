import { writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { prepareQaWorld } from "./qa-world";

type World = Pick<
  Awaited<ReturnType<typeof prepareQaWorld>>,
  "herdrSocket" | "environment" | "repository"
>;

export async function captureTui(world: World, path: string, requiredLabel: string) {
  const complete = Promise.withResolvers<void>();
  const decoder = new TextDecoder();
  let output = "";
  let captured: string | undefined;
  const end = "\u001b[?2026l";
  const process = Bun.spawn(
    [world.environment.QA_HERDR_BINARY, "--session", basename(dirname(world.herdrSocket))],
    {
      cwd: world.repository,
      env: {
        ...world.environment,
        HERDR_ENV: undefined,
        HERDR_WORKSPACE_ID: undefined,
        HERDR_PANE_ID: undefined,
        TERM: "xterm-256color",
      },
      terminal: {
        cols: 130,
        rows: 40,
        data(_terminal, bytes) {
          if (captured !== undefined) return;
          output += decoder.decode(bytes, { stream: true });
          const label = output.lastIndexOf(requiredLabel);
          const frameEnd = label < 0 ? -1 : output.indexOf(end, label);
          if (frameEnd !== -1) {
            captured = output.slice(0, frameEnd + end.length);
            complete.resolve();
          }
        },
      },
    },
  );
  const timer = setTimeout(
    () => complete.reject(new Error(`No completed TUI frame containing ${requiredLabel}`)),
    30_000,
  );
  void process.exited.then((code) =>
    complete.reject(new Error(`TUI exited before capture: ${code}`)),
  );
  try {
    await complete.promise;
    if (captured === undefined) throw new Error("Capture completion had no frame");
    await writeFile(path, captured);
    return {
      path,
      pid: process.pid,
      columns: 130,
      rows: 40,
      bytes: Buffer.byteLength(captured),
      requiredLabel,
    };
  } finally {
    clearTimeout(timer);
    process.kill("SIGTERM");
    await process.exited;
    process.terminal?.close();
  }
}
