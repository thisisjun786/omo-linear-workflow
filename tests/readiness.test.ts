import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Binding } from "../src/core/contracts";
import { publishReadiness, subscribeReadiness } from "../src/readiness";

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
