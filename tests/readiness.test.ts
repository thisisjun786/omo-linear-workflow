import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Binding } from "../src/core/contracts";
import {
  processStarttime,
  proveTuiConnection,
  publishReadiness,
  subscribeReadiness,
} from "../src/readiness";

const binding: Binding = {
  id: "ready-supervisor",
  designationId: "designation",
  assignment: { role: "supervisor", initiativeId: "initiative" },
  durableSessionId: "native-supervisor",
  cwd: "/control",
  checkout: null,
  herdrSocket: "/herdr.sock",
  omoSocket: "/omo.sock",
  workspaceId: "w1",
  paneId: "w1:p1",
  sessionPath: null,
  launchState: "provisioning",
  initialization: { state: "pending", text: null },
  contactState: "active",
};
const receipt = {
  bindingId: binding.id,
  durableSessionId: binding.durableSessionId,
  sessionPath: "/sessions/supervisor.jsonl",
  cwd: binding.cwd,
  paneId: "w1:p1",
};

test.each(["before", "after"])(
  "receives a TUI receipt published %s subscription",
  async (order) => {
    const root = await mkdtemp(join(tmpdir(), "oi-ready-"));
    let close: (() => void) | undefined;
    try {
      if (order === "before") await publishReadiness(root, receipt);
      const subscription = await subscribeReadiness(root, binding);
      close = subscription.close;
      if (order === "after") await publishReadiness(root, receipt);
      expect(await subscription.promise).toEqual(receipt);
      expect((await stat(join(root, ".omo/state/ready/ready-supervisor.json"))).mode & 0o777).toBe(
        0o600,
      );
    } finally {
      close?.();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("rejects a receipt for the wrong checkout instead of accepting its path", async () => {
  const root = await mkdtemp(join(tmpdir(), "oi-ready-"));
  const subscription = await subscribeReadiness(root, binding);
  try {
    const accepted = subscription.promise.then(
      () => true,
      () => false,
    );
    await publishReadiness(root, { ...receipt, cwd: "/another-owner" });
    expect(await accepted).toBe(false);
  } finally {
    subscription.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("launch proof binds a live host peer to the nonce TUI PID, not an observer", async () => {
  const root = await mkdtemp(join(tmpdir(), "olw-tui-proof-"));
  const starttime = await processStarttime(process.pid);
  const rows = (pid: number) =>
    `u_str ESTAB 0 0 ${binding.omoSocket} 100 * 200 users:(("host",pid=999,fd=3))\nu_str ESTAB 0 0 * 200 * 100 users:(("tui",pid=${pid},fd=4))\n`;
  try {
    await publishReadiness(root, {
      ...receipt,
      launch: { nonce: "launch", pid: process.pid, starttime },
    });
    const allocated = { ...binding, sessionPath: receipt.sessionPath };
    expect(
      await proveTuiConnection(
        root,
        allocated,
        "launch",
        async () => true,
        async () => rows(process.pid),
      ),
    ).toBe(true);
    expect(
      await proveTuiConnection(
        root,
        allocated,
        "launch",
        async () => true,
        async () => rows(process.pid + 1),
      ),
    ).toBe(false);
    await expect(
      proveTuiConnection(
        root,
        allocated,
        "stale",
        async () => true,
        async () => rows(process.pid),
      ),
    ).rejects.toMatchObject({ reason: "attachment_unverified" });
    await expect(
      proveTuiConnection(
        root,
        allocated,
        "launch",
        async () => false,
        async () => rows(process.pid),
      ),
    ).rejects.toMatchObject({ reason: "attachment_unverified" });
    await expect(
      proveTuiConnection(
        root,
        allocated,
        "launch",
        async () => true,
        async () => rows(process.pid).replace(/users:.*$/gm, ""),
      ),
    ).rejects.toMatchObject({ reason: "attachment_unverified" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("launch proof accepts a peer of the handed-off host listener (omo.sock.next-N)", async () => {
  const root = await mkdtemp(join(tmpdir(), "olw-tui-handoff-"));
  const starttime = await processStarttime(process.pid);
  const rows = `u_str ESTAB 0 0 ${binding.omoSocket}.next-3 100 * 200 users:(("host",pid=999,fd=3))\nu_str ESTAB 0 0 * 200 * 100 users:(("tui",pid=${process.pid},fd=4))\nu_str ESTAB 0 0 ${binding.omoSocket}.next-3x 300 * 400 users:(("other",pid=998,fd=3))\nu_str ESTAB 0 0 * 400 * 300 users:(("tui",pid=${process.pid},fd=5))\n`;
  try {
    await publishReadiness(root, {
      ...receipt,
      launch: { nonce: "launch", pid: process.pid, starttime },
    });
    const allocated = { ...binding, sessionPath: receipt.sessionPath };
    expect(
      await proveTuiConnection(
        root,
        allocated,
        "launch",
        async () => true,
        async () => rows,
      ),
    ).toBe(true);
    const foreignOnly = `u_str ESTAB 0 0 ${binding.omoSocket}.next-3x 300 * 400 users:(("other",pid=998,fd=3))\nu_str ESTAB 0 0 * 400 * 300 users:(("tui",pid=${process.pid},fd=5))\n`;
    expect(
      await proveTuiConnection(
        root,
        allocated,
        "launch",
        async () => true,
        async () => foreignOnly,
      ),
    ).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TUI process proof reads a real established Unix peer and notices disconnect", async () => {
  const root = await mkdtemp(join(tmpdir(), "olw-tui-peer-"));
  const path = join(root, "host.sock");
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  const connected = Promise.withResolvers<void>();
  server.once("connection", () => connected.resolve());
  const client = createConnection(path);
  client.on("error", (cause) => connected.reject(cause));
  try {
    await connected.promise;
    await publishReadiness(root, {
      ...receipt,
      launch: { nonce: "real", pid: process.pid, starttime: await processStarttime(process.pid) },
    });
    const allocated = { ...binding, sessionPath: receipt.sessionPath, omoSocket: path };
    expect(await proveTuiConnection(root, allocated, "real", async () => true)).toBe(true);
    const closed = new Promise<void>((resolve) => client.once("close", () => resolve()));
    client.destroy();
    await closed;
    expect(await proveTuiConnection(root, allocated, "real", async () => true)).toBe(false);
  } finally {
    client.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
