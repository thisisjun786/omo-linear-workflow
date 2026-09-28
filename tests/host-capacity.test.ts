import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertHostCapacity,
  HostCapacityError,
  NATIVE_HOST_SESSION_LIMIT,
} from "../src/host-profile";

test("capacity guard counts workers and returns an actionable typed error at native cap", async () => {
  const root = await mkdtemp(join(tmpdir(), "olw-host-capacity-"));
  const socket = join(root, "host.sock");
  let request: unknown;
  const server = createServer((connection) => {
    let input = "";
    connection.on("data", (chunk) => {
      input += chunk.toString("utf8");
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      request = JSON.parse(input.slice(0, newline));
      const id =
        typeof request === "object" && request !== null && "id" in request ? request.id : "";
      connection.end(
        `${JSON.stringify({
          id,
          success: true,
          data: {
            sessions: Array.from({ length: NATIVE_HOST_SESSION_LIMIT }, (_, index) => ({
              sessionPath: `/sessions/${index}.jsonl`,
              kind: index % 2 === 0 ? "interactive" : "worker",
            })),
          },
        })}\n`,
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });

  try {
    const result = await assertHostCapacity(socket, "/sessions/new.jsonl", 100).then(
      () => null,
      (cause: unknown) => cause,
    );

    expect(request).toMatchObject({ type: "list_sessions", include_workers: true });
    expect(result).toBeInstanceOf(HostCapacityError);
    expect(result).toMatchObject({
      code: "host_session_capacity",
      count: 20,
      limit: 20,
      action: "close_an_existing_role",
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("capacity guard preserves attach-at-cap for an existing session path", async () => {
  const sessions = Array.from({ length: NATIVE_HOST_SESSION_LIMIT }, (_, index) => ({
    sessionPath: `/sessions/${index}.jsonl`,
    kind: index % 2 === 0 ? "interactive" : "worker",
  }));

  await expect(
    assertHostCapacity("/fixture.sock", sessions[0]?.sessionPath, 100, async () => ({ sessions })),
  ).resolves.toBeUndefined();
});

test("capacity guard fails closed when the mutating observation is unreadable", async () => {
  await expect(
    assertHostCapacity("/fixture.sock", "/sessions/new.jsonl", 100, async () => undefined),
  ).rejects.toThrow("capacity");
});
