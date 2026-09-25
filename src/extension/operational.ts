import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { DeliveryRecord, RuntimeFailureClaim } from "../core/contracts";
import type { SessionContextPort } from "./runtime";

const assistantErrorSchema = z.object({
  role: z.literal("assistant"),
  stopReason: z.literal("error"),
  provider: z.string().min(1),
  model: z.string().min(1),
  timestamp: z.number().nonnegative(),
  errorMessage: z.string().optional(),
});

export function runtimeFailureClaim(
  message: unknown,
  ctx: SessionContextPort,
): RuntimeFailureClaim | undefined {
  const error = assistantErrorSchema.safeParse(message);
  if (!error.success) return undefined;
  const sessionPath = ctx.sessionManager.getSessionFile();
  if (sessionPath === undefined) throw new Error("Runtime error has no durable session path");
  // turn_end follows message_end persistence in the pinned native event queue.
  // Prefer object identity when available. Native session materialization and replay
  // may return copies; reject ambiguous evidence instead of inventing an event ID.
  const entries = ctx.sessionManager.getBranch().filter((entry) => entry.type === "message");
  let entry = entries.findLast((candidate) => candidate.message === message);
  if (entry === undefined) {
    const matches = entries.filter((candidate) => {
      const parsed = assistantErrorSchema.safeParse(candidate.message);
      return parsed.success && JSON.stringify(parsed.data) === JSON.stringify(error.data);
    });
    if (matches.length !== 1)
      throw new Error("Runtime error cannot be attributed to one persisted session entry");
    entry = matches[0];
  }
  if (entry === undefined) throw new Error("Runtime error session entry is unavailable");
  return {
    version: 1,
    kind: "runtime_failure",
    failure: {
      source: "turn_end",
      sessionEntryId: entry.id,
      durableSessionId: ctx.sessionManager.getSessionId(),
      sessionPath,
      cwd: ctx.cwd,
      provider: error.data.provider,
      modelId: error.data.model,
      timestamp: error.data.timestamp,
      stopReason: "error",
      errorMessage: error.data.errorMessage ?? null,
    },
  };
}

// Immutable snapshots keep local telemetry visible even with no live owner or CLI.
// The registry is authoritative; a sending snapshot is never proof of acceptance.
export async function publishOperationalNotice(
  root: string,
  record: DeliveryRecord,
): Promise<string> {
  const directory = join(root, ".omo/state/operational-notices", record.envelope.id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${record.state}.json`);
  const temporary = join(directory, `.${record.state}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return path;
}
