import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Designation, Result, ScopeSnapshot } from "../src/core/contracts";
import { openRegistry } from "../src/core/store";
import { authorizeHerdrRepublish } from "../src/extension";

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

test("Herdr republish rejects forged proofs and accepts the completed reattach proof", async () => {
  const root = await mkdtemp(join(tmpdir(), "olw-herdr-republish-"));
  await mkdir(join(root, ".omo/state"), { recursive: true });
  const registry = openRegistry(join(root, ".omo/state/registry.sqlite"));
  const snapshot: ScopeSnapshot = {
    version: 1,
    source: "linear-export",
    initiative: null,
    projects: [],
    decisionRefs: [],
  };
  const digest = value(registry.importScope(snapshot)).digest;
  const designation: Designation = {
    id: "manager",
    snapshotDigest: digest,
    designatedBy: "test",
    designatedAt: "2026-09-27T00:00:00.000Z",
    execute: true,
    create: true,
    contact: true,
  };
  const reserved = value(
    registry.reserve({
      bindingId: "manager-binding",
      durableSessionId: "manager-session",
      designation,
      snapshot,
      assignment: { role: "manager" },
      cwd: root,
      checkout: null,
      herdrSocket: "/tmp/herdr.sock",
      omoSocket: "/tmp/omo.sock",
    }),
  );
  value(registry.provision(reserved.id, "workspace", "pane-old"));
  value(registry.observeSession(reserved.id, "/sessions/manager.jsonl"));
  value(
    registry.activate(reserved.id, {
      durableSessionId: reserved.durableSessionId,
      sessionPath: "/sessions/manager.jsonl",
      cwd: root,
      provider: "opencodex",
      modelId: "anthropic/claude-opus-5-5",
      thinking: "medium",
      extensionProtocol: 2,
    }),
  );
  value(registry.beginInitialization(reserved.id, "brief"));
  value(registry.finishInitialization(reserved.id, "accepted"));
  const claim = value(
    registry.beginReattach(
      reserved.id,
      "pane-old",
      "2026-09-27T00:01:00.000Z",
      "2026-09-26T00:00:00.000Z",
    ),
  );
  if (!claim.claimed) throw new Error("Expected reattach claim");
  value(registry.recordReattachPane(reserved.id, claim.token, "pane-new"));
  expect(value(registry.finishReattach(reserved.id, claim.token, "2026-09-27T00:01:01.000Z"))).toBe(
    true,
  );
  registry.close();

  try {
    const requests: string[] = [];
    const invoke = (proof: Record<string, string>) =>
      authorizeHerdrRepublish(
        root,
        proof,
        (sessionId) => requests.push(sessionId),
        Date.parse("2026-09-27T00:02:00.000Z"),
      );
    for (const proof of [
      { sessionId: "forged-session", bindingId: reserved.id, claimToken: claim.token },
      {
        sessionId: reserved.durableSessionId,
        bindingId: "forged-binding",
        claimToken: claim.token,
      },
      { sessionId: reserved.durableSessionId, bindingId: reserved.id, claimToken: "forged-token" },
    ])
      expect(invoke(proof)).toMatchObject({
        ok: false,
        error: { code: "herdr_republish_unauthorized" },
      });
    expect(requests).toEqual([]);

    expect(
      invoke({
        sessionId: reserved.durableSessionId,
        bindingId: reserved.id,
        claimToken: claim.token,
      }),
    ).toEqual({ ok: true });
    expect(requests).toEqual([reserved.durableSessionId]);

    const writable = openRegistry(join(root, ".omo/state/registry.sqlite"));
    const closing = value(writable.beginClose(reserved.id));
    writable.close();
    expect(closing.launchState).toBe("closing");
    expect(
      invoke({
        sessionId: reserved.durableSessionId,
        bindingId: reserved.id,
        claimToken: claim.token,
      }),
    ).toMatchObject({ ok: false, error: { code: "herdr_republish_unauthorized" } });
    expect(requests).toEqual([reserved.durableSessionId]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
