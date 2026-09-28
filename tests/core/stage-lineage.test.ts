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
      checkout: {
        originalRepoRoot: "/repo",
        path: "/repo",
        branch: "issue",
        baseBranch: "main",
        baseCommit: "base",
      },
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

test("closing an uncertain successor retires its lineage and preserves launch history", async () => {
  await fixture((path, registry, _parent, plan, next) => {
    ready(registry, plan);
    value(registry.recordStage(plan.id, "issue", "plan", 0, null));
    value(registry.recordHandoff(plan.id, handoff));
    const execute = value(registry.successorReservation(plan.id, next, "execute"));
    value(registry.provision(execute.id, "workspace", "execute-pane"));
    const claim = value(registry.beginSuccessorLaunch(execute.id, "execute-pane", "now", "before"));
    if (!claim.claimed) throw new Error("missing launch claim");
    value(registry.dispatchSuccessorLaunch(execute.id, claim.token));
    value(registry.failSuccessorLaunch(execute.id, claim.token));
    value(registry.beginUncertainSuccessorClose(execute.id));
    value(registry.closeUncertainSuccessor(execute.id));

    expect(value(registry.stageOf(execute.id))).toBeNull();
    expect(value(registry.lineageFor(plan.id)).stages.map((stage) => stage.bindingId)).toEqual([
      plan.id,
    ]);
    expect(value(registry.successorLaunchIntent(execute.id))).toEqual({
      attemptId: claim.token,
      state: "uncertain",
    });
    const replacement = value(
      registry.successorReservation(
        plan.id,
        { ...next, bindingId: "execute-2", durableSessionId: "session-execute-2" },
        "execute",
      ),
    );
    expect(value(registry.stageOf(replacement.id))).toMatchObject({ ordinal: 2 });
    const db = new Database(path, { readonly: true });
    try {
      expect(
        db.query<{ count: number }, []>("SELECT count(*) AS count FROM successor_launch").get()
          ?.count,
      ).toBe(1);
    } finally {
      db.close();
    }
  });
});

test("a read-only registry without a generation column still returns lineage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "olw-lineage-ro-"));
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
    const parent = value(
      registry.reserve({
        designation,
        snapshot,
        cwd: "/repo",
        checkout: null,
        herdrSocket: "/tmp/herdr",
        omoSocket: "/tmp/omo",
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
    const child = value(
      registry.reserve({
        designation,
        snapshot,
        cwd: "/repo",
        checkout: null,
        herdrSocket: "/tmp/herdr",
        omoSocket: "/tmp/omo",
        bindingId: "child",
        durableSessionId: "session-child",
        assignment: {
          role: "child",
          initiativeId: null,
          projectId: "project",
          issueId: "issue",
          ownerBindingId: parent.id,
        },
      }),
    );
    value(registry.recordStage(child.id, "issue", "direct", 0, null));
  } finally {
    registry.close();
  }
  const stripped = new Database(path);
  try {
    stripped.run(`CREATE TABLE stage_lineage_old (
      binding_id TEXT PRIMARY KEY,
      issue_id TEXT NOT NULL,
      stage TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      previous_binding_id TEXT,
      handoff_json TEXT
    )`);
    stripped.run(
      "INSERT INTO stage_lineage_old (binding_id, issue_id, stage, ordinal, previous_binding_id, handoff_json) SELECT binding_id, issue_id, stage, ordinal, previous_binding_id, handoff_json FROM stage_lineage",
    );
    stripped.run("DROP TABLE stage_lineage");
    stripped.run("ALTER TABLE stage_lineage_old RENAME TO stage_lineage");
  } finally {
    stripped.close();
  }
  const readonly = openRegistry(path, { readonly: true });
  try {
    expect(value(readonly.lineageFor("child"))).toEqual({
      issueId: "issue",
      mode: "direct",
      stages: [{ bindingId: "child", stage: "direct", ordinal: 0, launchState: "reserved" }],
    });
    expect(value(readonly.stageChain("issue"))).toEqual([
      expect.objectContaining({
        bindingId: "child",
        stage: "direct",
        ordinal: 0,
        previousBindingId: null,
      }),
    ]);
    expect(value(readonly.stageOf("child"))?.stage).toBe("direct");
  } finally {
    readonly.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("writable migration backfills legacy successor launch attempts without changing read-only bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "olw-successor-attempt-migration-"));
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
    const parent = value(
      registry.reserve({
        designation,
        snapshot,
        cwd: "/repo",
        checkout: null,
        herdrSocket: "/tmp/herdr",
        omoSocket: "/tmp/omo",
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
    value(
      registry.reserve({
        designation,
        snapshot,
        cwd: "/repo",
        checkout: null,
        herdrSocket: "/tmp/herdr",
        omoSocket: "/tmp/omo",
        bindingId: "execute",
        durableSessionId: "session-execute",
        assignment: {
          role: "child",
          initiativeId: null,
          projectId: "project",
          issueId: "issue",
          ownerBindingId: parent.id,
        },
      }),
    );
  } finally {
    registry.close();
  }
  const legacy = new Database(path);
  try {
    legacy.run("DROP TABLE successor_launch_attempts");
    legacy
      .query(
        "INSERT INTO successor_launch (binding_id, state, claimed_at, owner) VALUES ('execute', 'uncertain', 'legacy-time', 'legacy-owner')",
      )
      .run();
  } finally {
    legacy.close();
  }
  const before = await Bun.file(path).arrayBuffer();
  const readonly = openRegistry(path, { readonly: true });
  readonly.close();
  expect(Buffer.from(await Bun.file(path).arrayBuffer())).toEqual(Buffer.from(before));

  const migrated = openRegistry(path);
  migrated.close();
  const reopened = openRegistry(path);
  reopened.close();
  const inspected = new Database(path, { readonly: true });
  try {
    expect(
      inspected
        .query<{ attempt_number: number; owner: string; state: string; claimed_at: string }, []>(
          "SELECT attempt_number, owner, state, claimed_at FROM successor_launch_attempts WHERE binding_id = 'execute'",
        )
        .all(),
    ).toEqual([
      {
        attempt_number: 1,
        owner: "legacy-owner",
        state: "uncertain",
        claimed_at: "legacy-time",
      },
    ]);
  } finally {
    inspected.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("malformed persisted handoff returns storage_corrupt from every lineage and transaction path", async () => {
  await fixture((path, registry, _parent, plan, next) => {
    value(registry.recordStage(plan.id, "issue", "plan", 0, null));
    ready(registry, plan);
    value(registry.recordHandoff(plan.id, handoff));
    const successor = value(registry.successorReservation(plan.id, next, "execute"));
    const db = new Database(path);
    try {
      db.query("UPDATE stage_lineage SET handoff_json = ? WHERE binding_id = ?").run(
        JSON.stringify({ head: 7 }),
        plan.id,
      );
    } finally {
      db.close();
    }
    const corrupt = {
      ok: false,
      error: { code: "storage_corrupt", message: "Stored stage handoff is invalid" },
    };
    expect(registry.stageOf(plan.id)).toMatchObject(corrupt);
    expect(registry.stageChain("issue")).toMatchObject(corrupt);
    expect(registry.lineageFor(plan.id)).toMatchObject(corrupt);
    expect(registry.lineageFor(successor.id)).toMatchObject(corrupt);
    expect(registry.recordHandoff(plan.id, handoff)).toMatchObject(corrupt);
    expect(
      registry.successorReservation(
        plan.id,
        { ...next, bindingId: "another", durableSessionId: "another" },
        "execute",
      ),
    ).toMatchObject(corrupt);
  });
});

test("an existing lineage table gains generation without rewriting its rows", async () => {
  const dir = await mkdtemp(join(tmpdir(), "olw-lineage-old-"));
  const path = join(dir, "registry.sqlite");
  const created = new Database(path);
  try {
    created.run("CREATE TABLE scopes (digest TEXT PRIMARY KEY, json TEXT NOT NULL)");
    created.run(
      "CREATE TABLE designations (id TEXT PRIMARY KEY, scope_digest TEXT NOT NULL, json TEXT NOT NULL)",
    );
    created.run(
      "CREATE TABLE bindings (id TEXT PRIMARY KEY, designation_id TEXT NOT NULL, durable_session_id TEXT NOT NULL UNIQUE, ownership_key TEXT NOT NULL, launch_state TEXT NOT NULL, json TEXT NOT NULL)",
    );
    created.run(
      "CREATE TABLE stage_lineage (binding_id TEXT PRIMARY KEY, issue_id TEXT NOT NULL, stage TEXT NOT NULL, ordinal INTEGER NOT NULL, previous_binding_id TEXT, handoff_json TEXT)",
    );
    created.run(
      "INSERT INTO stage_lineage (binding_id, issue_id, stage, ordinal, previous_binding_id) VALUES ('old', 'issue', 'direct', 0, NULL)",
    );
  } finally {
    created.close();
  }
  const registry = openRegistry(path);
  try {
    const columns = new Database(path, { readonly: true });
    try {
      expect(
        columns
          .query<{ name: string }, []>("PRAGMA table_info(stage_lineage)")
          .all()
          .some((column) => column.name === "generation"),
      ).toBe(true);
      expect(
        columns
          .query<{ generation: number }, []>(
            "SELECT generation FROM stage_lineage WHERE binding_id = 'old'",
          )
          .get()?.generation,
      ).toBe(0);
    } finally {
      columns.close();
    }
  } finally {
    registry.close();
    await rm(dir, { recursive: true, force: true });
  }
});

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

test("a closed generation allows a new root and keeps its own history", async () => {
  await fixture((_path, registry, _parent, first, next) => {
    value(registry.recordStage(first.id, "issue", "direct", 0, null));
    ready(registry, first);
    value(registry.beginClose(first.id));
    value(registry.finishClose(first.id));
    const second = value(
      registry.reserve({
        ...next,
        bindingId: "direct-2",
        durableSessionId: "session-direct-2",
      }),
    );
    value(registry.recordStage(second.id, "issue", "direct", 0, null));
    expect(value(registry.lineageFor(first.id))).toEqual({
      issueId: "issue",
      mode: "direct",
      stages: [{ bindingId: first.id, stage: "direct", ordinal: 0, launchState: "closed" }],
    });
    expect(value(registry.lineageFor(second.id))).toEqual({
      issueId: "issue",
      mode: "direct",
      stages: [{ bindingId: second.id, stage: "direct", ordinal: 0, launchState: "reserved" }],
    });
    expect(value(registry.stageChain("issue"))).toEqual([
      expect.objectContaining({ bindingId: second.id, ordinal: 0, previousBindingId: null }),
    ]);

    value(registry.beginClose(second.id));
    value(registry.finishClose(second.id));
    const planned = value(
      registry.reserve({
        ...next,
        bindingId: "plan-2",
        durableSessionId: "session-plan-2",
      }),
    );
    value(registry.recordStage(planned.id, "issue", "plan", 0, null));
    expect(value(registry.lineageFor(planned.id)).mode).toBe("planned");
    expect(value(registry.lineageFor(second.id)).stages.map((stage) => stage.bindingId)).toEqual([
      second.id,
    ]);
  });
});

test("a second root is refused while an earlier generation is still live", async () => {
  await fixture((path, registry, _parent, first, next) => {
    value(registry.recordStage(first.id, "issue", "plan", 0, null));
    value(registry.beginClose(first.id));
    value(registry.finishClose(first.id));
    const parked = value(registry.reserve(next));
    const db = new Database(path);
    try {
      db.query("UPDATE bindings SET ownership_key = 'parked' WHERE id = ?").run(parked.id);
      db.query(
        "UPDATE bindings SET launch_state = 'uncertain', json = json_set(json, '$.launchState', 'uncertain') WHERE id = ?",
      ).run(first.id);
    } finally {
      db.close();
    }
    expect(code(registry.recordStage(parked.id, "issue", "direct", 0, null))).toBe(
      "stage_conflict",
    );
    expect(value(registry.get(first.id)).launchState).toBe("uncertain");
    expect(value(registry.stageOf(parked.id))).toBeNull();
    expect(value(registry.lineageFor(first.id)).stages.map((stage) => stage.bindingId)).toEqual([
      first.id,
    ]);
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

test("an ordinarily closed plan cannot reserve an execute successor", async () => {
  await fixture((_path, registry, _parent, plan, next) => {
    value(registry.recordStage(plan.id, "issue", "plan", 0, null));
    ready(registry, plan);
    value(registry.recordHandoff(plan.id, handoff));
    value(registry.beginClose(plan.id));
    value(registry.finishClose(plan.id));

    expect(registry.successorReservation(plan.id, next, "execute")).toMatchObject({
      ok: false,
      error: { code: "stage_predecessor_closed" },
    });
    expect(value(registry.stageChain("issue"))).toHaveLength(1);
    expect(registry.get(next.bindingId)).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
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
