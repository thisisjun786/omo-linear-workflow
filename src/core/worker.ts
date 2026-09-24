import type { Result } from "./contracts";
import { workerRequestSchema } from "./schema";
import { openRegistry } from "./store";

function invalid(code: string, message: string, details?: unknown): Result<never> {
  return details === undefined
    ? { ok: false, error: { code, message } }
    : { ok: false, error: { code, message, details } };
}

async function run(): Promise<void> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(process.argv[2] ?? (await Bun.stdin.text()));
  } catch (cause) {
    const details = cause instanceof Error ? cause.message : String(cause);
    process.stdout.write(
      `${JSON.stringify(invalid("invalid_request", "Worker input is not JSON", details))}\n`,
    );
    return;
  }
  const request = workerRequestSchema.safeParse(decoded);
  if (!request.success) {
    process.stdout.write(
      `${JSON.stringify(invalid("invalid_request", "Worker request is invalid", request.error.issues))}\n`,
    );
    return;
  }

  const registry = openRegistry(request.data.dbPath);
  try {
    let result: Result<unknown>;
    if (request.data.action === "lookup-session") {
      result = registry.bySession(request.data.input.durableSessionId);
    } else if (request.data.action === "authorize") {
      result = registry.authorize(request.data.input.senderSessionId, request.data.input.envelope);
    } else if (request.data.action === "claim") {
      result = registry.claim(request.data.input.senderSessionId, request.data.input.envelope);
    } else if (request.data.action === "finish") {
      result = registry.finish(
        request.data.input.messageId,
        request.data.input.receipt,
        request.data.input.nativeKey,
      );
    } else if (request.data.action === "uncertain") {
      result = registry.uncertain(
        request.data.input.messageId,
        request.data.input.reason,
        request.data.input.nativeKey,
      );
    } else {
      result = invalid("invalid_request", "Worker action is invalid");
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    registry.close();
  }
}

try {
  await run();
} catch (cause) {
  process.stderr.write(
    `${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}\n`,
  );
  process.exitCode = 1;
}
