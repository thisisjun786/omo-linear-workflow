import { fetchMirror } from "../../src/repo/mirror";

const root = process.argv[2];
const remote = process.argv[3];
if (root === undefined || remote === undefined) throw new Error("root and remote are required");

try {
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      value: await fetchMirror(root, remote, {
        ...(process.env["LOCK_TIMEOUT_MS"] === undefined
          ? {}
          : { lockTimeoutMs: Number(process.env["LOCK_TIMEOUT_MS"]) }),
        ...(process.env["REPORT_WAIT"] === "1"
          ? { onLockWait: () => process.stderr.write("WAITING\n") }
          : {}),
      }),
    })}\n`,
  );
} catch (cause) {
  process.stdout.write(
    `${JSON.stringify({
      ok: false,
      code:
        cause instanceof Error && "code" in cause && typeof cause.code === "string"
          ? cause.code
          : undefined,
      error: cause instanceof Error ? cause.message : String(cause),
    })}\n`,
  );
  process.exitCode = 2;
}
