import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Envelope,
  NativeReceipt,
  Registry,
  Result,
  ScopeSnapshot,
} from "../src/core/contracts";
import { modelForRole } from "../src/core/policy";
import { openRegistry } from "../src/core/store";

const fixtures: { directory: string; registry: Registry }[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.registry.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "olw-delivery-attempts-"));
  const path = join(directory, "registry.sqlite");
  const registry = openRegistry(path);
  fixtures.push({ directory, registry });
  const snapshot: ScopeSnapshot = {
    version: 1,
    source: "fixture",
    initiative: { id: "i", url: "linear://i", revision: "1" },
    projects: [{ project: { id: "p", url: "linear://p", revision: "1" }, issues: [] }],
    decisionRefs: [],
  };
  const digest = value(registry.importScope(snapshot)).digest;
  const designation = {
    id: "approval",
    snapshotDigest: digest,
    designatedBy: "qa",
    designatedAt: "2026-09-23",
    execute: true,
    create: true,
    contact: true,
  };
  for (const assignment of [
    { role: "supervisor", initiativeId: "i" },
    { role: "parent", initiativeId: "i", projectId: "p", ownerBindingId: "s" },
  ] as const) {
    const id = assignment.role === "supervisor" ? "s" : "p";
    value(
      registry.reserve({
        bindingId: id,
        durableSessionId: `session-${id}`,
        designation,
        snapshot,
        assignment,
        cwd: "/repo",
        herdrSocket: "/tmp/herdr.sock",
        omoSocket: "/tmp/omo.sock",
        checkout:
          assignment.role === "supervisor"
            ? null
            : {
                originalRepoRoot: "/repo",
                path: "/repo",
                branch: "parent",
                baseBranch: "main",
                baseCommit: "base",
              },
      }),
    );
    value(registry.provision(id, `workspace-${id}`, `pane-${id}`));
    value(registry.observeSession(id, `/sessions/${id}.jsonl`));
    value(
      registry.activate(id, {
        durableSessionId: `session-${id}`,
        sessionPath: `/sessions/${id}.jsonl`,
        cwd: "/repo",
        ...modelForRole(assignment.role),
        extensionProtocol: 1,
      }),
    );
    value(registry.beginInitialization(id, "fixture"));
    value(registry.finishInitialization(id, "accepted"));
  }
  const envelope: Envelope = {
    version: 1,
    id: "logical",
    fromBindingId: "s",
    toBindingId: "p",
    designationId: "approval",
    snapshotDigest: digest,
    kind: "instruction",
    text: "one immutable instruction",
    outcome: null,
    evidence: [],
  };
  return { path, registry, envelope, sender: "session-s" };
}
const preDelivery: NativeReceipt = {
  kind: "error",
  error: { code: "turn_conflict_before_delivery", message: "fixture", next_action: "retry" },
};
const accepted: NativeReceipt = {
  kind: "ok",
  thread_id: "session-p",
  message_seq: 2,
  deduplicated: false,
  delivery: { kind: "started", turn_id: "work" },
};

test("a proven pre-delivery rejection retains its receipt and allocates one successor key", async () => {
  const f = await fixture();
  const before = value(f.registry.get("p"));
  value(f.registry.claim(f.sender, f.envelope));
  value(f.registry.finish(f.envelope.id, preDelivery));
  const next = value(f.registry.claim(f.sender, f.envelope));
  expect(next.disposition).toBe("new");
  if (!next.nativeKey) throw new Error("Missing successor native key");
  expect(next.nativeKey).not.toBe(f.envelope.id);
  expect(next.record.envelope).toEqual(f.envelope);
  expect(next.record.attempts).toMatchObject([
    { number: 1, nativeKey: f.envelope.id, state: "rejected", receipt: preDelivery },
    { number: 2, nativeKey: next.nativeKey, state: "sending", receipt: null },
  ]);
  expect(value(f.registry.claim(f.sender, f.envelope)).disposition).toBe("in_progress");
  expect(f.registry.finish(f.envelope.id, preDelivery, f.envelope.id)).toMatchObject({
    ok: false,
    error: { code: "stale_attempt" },
  });
  expect(f.registry.uncertain(f.envelope.id, "late failure", f.envelope.id)).toMatchObject({
    ok: false,
    error: { code: "stale_attempt" },
  });
  const finished = value(f.registry.finish(f.envelope.id, accepted, next.nativeKey));
  expect(finished.attempts).toMatchObject([
    { number: 1, nativeKey: f.envelope.id, state: "rejected", receipt: preDelivery },
    { number: 2, nativeKey: next.nativeKey, state: "accepted", receipt: accepted },
  ]);
  expect(value(f.registry.claim(f.sender, f.envelope)).disposition).toBe("replay");
  expect(value(f.registry.get("p"))).toEqual(before);
});

test.each(["turn_conflict", "idempotency_uncertain"])(
  "ambiguous native %s retains its receipt without a successor",
  async (code) => {
    const f = await fixture();
    value(f.registry.claim(f.sender, f.envelope));
    const receipt: NativeReceipt = {
      kind: "error",
      error: { code, message: "fixture", next_action: "inspect" },
    };
    const finished = value(f.registry.finish(f.envelope.id, receipt));
    expect(finished.state).toBe("uncertain");
    expect(finished.receipt).toEqual(receipt);
    const replay = value(f.registry.claim(f.sender, f.envelope));
    expect(replay.disposition).toBe("in_progress");
    expect(replay.record.attempts).toMatchObject([{ number: 1, state: "uncertain", receipt }]);
  },
);

test("retry rechecks current authorization and cannot change the logical payload", async () => {
  const f = await fixture();
  value(f.registry.claim(f.sender, f.envelope));
  value(f.registry.finish(f.envelope.id, preDelivery));
  value(f.registry.setContactState("p", "paused"));
  expect(f.registry.claim(f.sender, f.envelope)).toMatchObject({
    ok: false,
    error: { code: "contact_paused" },
  });
  value(f.registry.setContactState("p", "active"));
  expect(f.registry.claim(f.sender, { ...f.envelope, text: "different" })).toMatchObject({
    ok: false,
    error: { code: "message_conflict" },
  });
  expect(value(f.registry.claim(f.sender, f.envelope)).disposition).toBe("new");
});
