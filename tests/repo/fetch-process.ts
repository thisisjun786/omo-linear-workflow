import { fetchMirror } from "../../src/repo/mirror";

const root = process.argv[2];
const remote = process.argv[3];
if (root === undefined || remote === undefined) throw new Error("root and remote are required");

try {
  process.stdout.write(`${JSON.stringify({ ok: true, value: await fetchMirror(root, remote) })}\n`);
} catch (cause) {
  process.stdout.write(
    `${JSON.stringify({
      ok: false,
      error: cause instanceof Error ? cause.message : String(cause),
    })}\n`,
  );
  process.exitCode = 2;
}
