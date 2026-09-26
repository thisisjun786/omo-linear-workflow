import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Binding, ReserveInput, Result, ScopeSnapshot } from "../../src/core/contracts";
import { modelForRole } from "../../src/core/policy";
import { openRegistry } from "../../src/core/store";

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}
function code<T>(result: Result<T>): string {
  return result.ok ? "ok" : result.error.code;
}
const snapshot: ScopeSnapshot = {
  version: 1,
  source: "fixture",
  initiative: null,
  decisionRefs: [],
  projects: [
    {
      project: { id: "project", url: "linear://project", revision: "1" },
      issues: [{ id: "issue", url: "linear://issue", revision: "1" }],
    },
  ],
};
const handoff = {
  planPath: "/tmp/plan.md",
  planSha256: "a".repeat(64),
  head: "abcdef",
  completedAt: "2026-09-26T00:00:00Z",
};

async function fixture(
  run: (
    path: string,
    registry: ReturnType<typeof openRegistry>,
    parent: Binding,
    plan: Binding,
    next: ReserveInput,
  ) => void,
) {
  const dir = await mkdtemp(join(tmpdir(), "olw-lineage-"));
  const path = join(dir, "registry.sqlite");
  const registry = openRegistry(path);
  try {
    const digest = value(registry.importScope(snapshot)).digest;
    const designation = {
      id: "designation",
      snapshotDigest: digest,
      designatedBy: "user",
      designatedAt: "now",
      create: true,
      execute: true,
      contact: true,
    };
    const base = {
      designation,
      snapshot,
      cwd: "/repo",
      checkout: null,
      herdrSocket: "/tmp/herdr",
      omoSocket: "/tmp/omo",
    };
    const parent = value(
      registry.reserve({
        ...base,
        bindingId: "parent",
        durableSessionId: "session-parent",
        assignment: {
          role: "parent",
          initiativeId: null,
          projectId: "project",
          ownerBindingId: null,
        },
      }),
    );
    const assignment = {
      role: "child" as const,
      initiativeId: null,
      projectId: "project",
      issueId: "issue",
      ownerBindingId: parent.id,
    };
    const plan = value(
      registry.reserve({
        ...base,
        bindingId: "plan",
        durableSessionId: "session-plan",
        assignment,
      }),
    );
    const next = { ...base, bindingId: "execute", durableSessionId: "session-execute", assignment };
    run(path, registry, parent, plan, next);
  } finally {
    registry.close();
    await rm(dir, { recursive: true, force: true });
  }
}
function ready(registry: ReturnType<typeof openRegistry>, binding: Binding) {
  value(registry.provision(binding.id, "workspace", "pane"));
  value(registry.observeSession(binding.id, `/sessions/${binding.id}`));
  value(
    registry.activate(binding.id, {
      durableSessionId: binding.durableSessionId,
      sessionPath: `/sessions/${binding.id}`,
      cwd: binding.cwd,
      ...modelForRole(binding.assignment.role),
      extensionProtocol: 1,
    }),
  );
  value(registry.beginInitialization(binding.id, "hello"));
  value(registry.finishInitialization(binding.id, "accepted"));
}

test("plan succession is atomic, persists, and retires old route", async () => {
  await fixture((path, registry, parent, plan, next) => {
    value(registry.recordStage(plan.id, "issue", "plan", 0, null));
    ready(registry, plan);
    value(registry.recordHandoff(plan.id, handoff));
    const successor = value(registry.successorReservation(plan.id, next, "execute"));
    expect(
      code(
        registry.successorReservation(
          plan.id,
          { ...next, bindingId: "another", durableSessionId: "another" },
          "execute",
        ),
      ),
    ).not.toBe("ok");
    expect(value(registry.get(plan.id)).launchState).toBe("closed");
    expect(value(registry.get(successor.id)).launchState).toBe("reserved");
    expect(value(registry.lineageFor(successor.id))).toEqual({
      issueId: "issue",
      mode: "planned",
      stages: [
        { bindingId: plan.id, stage: "plan", ordinal: 0, launchState: "closed" },
        { bindingId: successor.id, stage: "execute", ordinal: 1, launchState: "reserved" },
      ],
    });
    const route = registry.authorize(parent.durableSessionId, {
      version: 1,
      id: "instruction",
      fromBindingId: parent.id,
      toBindingId: plan.id,
      designationId: parent.designationId,
      snapshotDigest: next.designation.snapshotDigest,
      kind: "instruction",
      text: "old",
      outcome: null,
      evidence: [],
    });
    expect(route).toMatchObject({
      ok: false,
      error: { code: "target_retired", details: { successorBindingId: successor.id } },
    });
    const db = new Database(path, { readonly: true });
    try {
      expect(
        db
          .query(
            "SELECT id FROM bindings WHERE ownership_key = 'issue:issue' AND launch_state <> 'closed'",
          )
          .all(),
      ).toEqual([{ id: successor.id }]);
    } finally {
      db.close();
    }
    const reopened = openRegistry(path, { readonly: true });
    try {
      expect(value(reopened.stageChain("issue"))).toHaveLength(2);
      expect(value(reopened.stageOf(successor.id))?.previousBindingId).toBe(plan.id);
    } finally {
      reopened.close();
    }
  });
});

test("legacy child remains direct when a replacement on the same issue has lineage", async () => {
  await fixture((_path, registry, _parent, legacy, next) => {
    value(registry.beginClose(legacy.id));
    value(registry.finishClose(legacy.id));
    const replacement = value(registry.reserve(next));
    value(registry.recordStage(replacement.id, "issue", "plan", 0, null));
    expect(value(registry.lineageFor(legacy.id))).toEqual({
      issueId: "issue",
      mode: "direct",
      stages: [{ bindingId: legacy.id, stage: "direct", ordinal: 0, launchState: "closed" }],
    });
    expect(value(registry.lineageFor(replacement.id))).toEqual({
      issueId: "issue",
      mode: "planned",
      stages: [{ bindingId: replacement.id, stage: "plan", ordinal: 0, launchState: "reserved" }],
    });
  });
});

test("handoff requires a ready plan and succession requires a handoff", async () => {
  await fixture((_path, registry, _parent, plan, next) => {
    value(registry.recordStage(plan.id, "issue", "plan", 0, null));
    expect(code(registry.recordHandoff(plan.id, handoff))).toBe("handoff_not_allowed");
    ready(registry, plan);
    expect(code(registry.successorReservation(plan.id, next, "execute"))).toBe("handoff_missing");
    expect(value(registry.get(plan.id)).launchState).toBe("ready");
  });
  await fixture((_path, registry, _parent, plan) => {
    value(registry.recordStage(plan.id, "issue", "direct", 0, null));
    ready(registry, plan);
    expect(code(registry.recordHandoff(plan.id, handoff))).toBe("handoff_not_allowed");
  });
});

test("in-flight delivery and invalid successor reservation leave the old owner live", async () => {
  await fixture((path, registry, _parent, plan, next) => {
    value(registry.recordStage(plan.id, "issue", "plan", 0, null));
    ready(registry, plan);
    value(registry.recordHandoff(plan.id, handoff));
    const db = new Database(path);
    try {
      db.query(
        "INSERT INTO deliveries (message_id, envelope_json, state) VALUES (?, ?, 'sending')",
      ).run("in-flight", JSON.stringify({ toBindingId: plan.id }));
    } finally {
      db.close();
    }
    expect(code(registry.successorReservation(plan.id, next, "execute"))).toBe("stage_in_flight");
    expect(value(registry.get(plan.id)).launchState).toBe("ready");
    const db2 = new Database(path);
    try {
      db2.query("DELETE FROM deliveries WHERE message_id = 'in-flight'").run();
    } finally {
      db2.close();
    }
    expect(
      code(
        registry.successorReservation(
          plan.id,
          {
            ...next,
            assignment: {
              ...next.assignment,
              ownerBindingId: "missing",
            } as ReserveInput["assignment"],
          },
          "execute",
        ),
      ),
    ).not.toBe("ok");
    expect(value(registry.get(plan.id)).launchState).toBe("ready");
    expect(value(registry.stageChain("issue"))).toHaveLength(1);
    expect(
      value(registry.list()).filter(
        (binding) => binding.assignment.role === "child" && binding.launchState !== "closed",
      ),
    ).toHaveLength(1);
    expect(value(registry.lineageFor(plan.id)).stages).toHaveLength(1);
  });
});
