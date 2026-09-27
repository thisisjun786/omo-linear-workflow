import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HostHandoffBusyError,
  type HostHandoffLockDependencies,
  withHostHandoffLock,
} from "../src/host-handoff-lock";

function dependencies(input: {
  readonly flock: (fd: number, operation: number) => number;
  readonly errno?: number;
  readonly wait?: HostHandoffLockDependencies["waitForLock"];
}) {
  const closed: number[] = [];
  const deps: HostHandoffLockDependencies = {
    open: () => 41,
    flock: input.flock,
    close: (fd) => {
      closed.push(fd);
      return 0;
    },
    errno: () => input.errno ?? 5,
    writeOwner: async () => {},
    waitForLock: input.wait ?? (async () => true),
  };
  return { deps, closed };
}

test("a failed flock attempt always closes its descriptor", async () => {
  const d = dependencies({ flock: () => -1, errno: 5 });
  await expect(withHostHandoffLock("/fixture/lock", async () => {}, d.deps)).rejects.toThrow(
    "Could not lock",
  );
  expect(d.closed).toEqual([41]);
});

test("a bounded lock wait closes its descriptor and returns host_handoff_busy", async () => {
  const root = await mkdtemp(join(tmpdir(), "olw-host-lock-"));
  try {
    const d = dependencies({
      flock: () => -1,
      errno: 11,
      wait: async (_fd, timeoutMs) => {
        expect(timeoutMs).toBeGreaterThan(0);
        return false;
      },
    });
    await expect(
      withHostHandoffLock(join(root, "handoff.lock"), async () => {}, d.deps),
    ).rejects.toBeInstanceOf(HostHandoffBusyError);
    expect(d.closed).toEqual([41]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
