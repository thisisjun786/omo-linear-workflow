import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Assignment,
  Binding,
  Envelope,
  Registry,
  Result,
  ScopeSnapshot,
} from "../src/core/contracts";
import { matchesRuntime, modelForRole } from "../src/core/policy";
import { openRegistry } from "../src/core/store";

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}
const empty: ScopeSnapshot = {
  version: 1,
  source: "linear-export",
  initiative: null,
  projects: [],
  decisionRefs: [],
};
const project: ScopeSnapshot = {
  ...empty,
  projects: [
    {
      project: { id: "p", url: "p", revision: "r" },
      issues: [{ id: "c", url: "c", revision: "r" }],
    },
  ],
};
const receipt = (to: Binding) => ({
  kind: "ok" as const,
  thread_id: to.durableSessionId,
  message_seq: 1,
  deduplicated: false,
  delivery: { kind: "started" as const, turn_id: "turn" },
});

async function world(
  run: (
    r: Registry,
    make: (id: string, assignment: Assignment, snapshot: ScopeSnapshot, ready?: boolean) => Binding,
    digest: (snapshot: ScopeSnapshot) => string,
  ) => void,
) {
  const dir = await mkdtemp(join(tmpdir(), "olw-manager-"));
  const r = openRegistry(join(dir, "registry.sqlite"));
  try {
    const digest = (snapshot: ScopeSnapshot) => value(r.importScope(snapshot)).digest;
    const make = (id: string, assignment: Assignment, snapshot: ScopeSnapshot, ready = true) => {
      const b = value(
        r.reserve({
          bindingId: id,
          durableSessionId: `session-${id}`,
          designation: {
            id: assignment.role === "manager" ? "d-manager" : "d-project",
            snapshotDigest: digest(snapshot),
            designatedBy: "user",
            designatedAt: "today",
            execute: true,
            create: true,
            contact: true,
          },
          snapshot,
          assignment,
          cwd: "/repo",
          checkout: null,
          herdrSocket: "/herdr",
          omoSocket: "/omo",
        }),
      );
      if (ready) {
        value(r.provision(id, `workspace-${id}`, `pane-${id}`));
        value(r.observeSession(id, `/sessions/${id}`));
        value(
          r.activate(id, {
            durableSessionId: b.durableSessionId,
            sessionPath: `/sessions/${id}`,
            cwd: "/repo",
            ...(assignment.role === "manager"
              ? { provider: "opencodex", modelId: "anthropic/claude-opus-5-5", thinking: "medium" }
              : modelForRole(assignment.role)),
            extensionProtocol: 2,
          }),
        );
        value(r.beginInitialization(id, "brief"));
        return value(r.finishInitialization(id, "accepted"));
      }
      return b;
    };
    run(r, make, digest);
  } finally {
    r.close();
    await rm(dir, { recursive: true, force: true });
  }
}
function message(
  from: Binding,
  to: Binding,
  kind: Envelope["kind"],
  digest: string,
  id: string,
): Envelope {
  return {
    version: 1,
    id,
    fromBindingId: from.id,
    toBindingId: to.id,
    designationId: from.designationId,
    snapshotDigest: digest,
    kind,
    text: "message",
    outcome: kind === "report" ? "completed" : null,
    evidence: [],
    ...(kind === "question" ? { question: { questions: [], escalates: null } } : {}),
    ...(kind === "answer"
      ? { answer: { questionId: id.slice("answer:".length), answers: {}, unanswered: [] } }
      : {}),
  };
}

test("one scope-free manager, no delegated scope and model-independent identity", async () =>
  world((r, make, digest) => {
    const manager = make("manager", { role: "manager" }, empty);
    expect(
      r.reserve({
        bindingId: "manager-2",
        durableSessionId: "session-manager-2",
        designation: {
          id: "d-manager-2",
          snapshotDigest: digest(empty),
          designatedBy: "user",
          designatedAt: "today",
          execute: true,
          create: true,
          contact: true,
        },
        snapshot: empty,
        assignment: { role: "manager" },
        cwd: "/repo",
        checkout: null,
        herdrSocket: "/herdr",
        omoSocket: "/omo",
      }),
    ).toMatchObject({ ok: false, error: { code: "ownership_conflict" } });
    for (const assignment of [
      { role: "parent", initiativeId: null, projectId: "p", ownerBindingId: manager.id },
      {
        role: "child",
        initiativeId: null,
        projectId: "p",
        issueId: "c",
        ownerBindingId: manager.id,
      },
    ] as Assignment[]) {
      expect(
        r.reserve({
          bindingId: `bad-${assignment.role}`,
          durableSessionId: `bad-session-${assignment.role}`,
          designation: {
            id: manager.designationId,
            snapshotDigest: digest(empty),
            designatedBy: "user",
            designatedAt: "today",
            execute: true,
            create: true,
            contact: true,
          },
          snapshot: empty,
          assignment,
          cwd: "/repo",
          checkout: null,
          herdrSocket: "/herdr",
          omoSocket: "/omo",
        }),
      ).toMatchObject({ ok: false, error: { code: "scope_violation" } });
    }
    expect(
      matchesRuntime(manager, {
        durableSessionId: manager.durableSessionId,
        sessionPath: manager.sessionPath ?? "",
        cwd: manager.cwd,
        provider: "other",
        modelId: "different",
        thinking: "high",
        extensionProtocol: 2,
      }),
    ).toBe(true);
  }));

test("linked parent instruction/report and question/answer; child cannot address manager", async () =>
  world((r, make, digest) => {
    const manager = make("manager", { role: "manager" }, empty);
    const parent = make(
      "parent",
      { role: "parent", initiativeId: null, projectId: "p", ownerBindingId: null },
      project,
    );
    value(r.setOwner(parent.id, manager.id));
    const child = make(
      "child",
      {
        role: "child",
        initiativeId: null,
        projectId: "p",
        issueId: "c",
        ownerBindingId: parent.id,
      },
      project,
    );
    for (const [from, to, kind, id] of [
      [manager, parent, "instruction", "instruction:1"],
      [parent, manager, "report", "report:1"],
      [parent, manager, "question", `question:${parent.id}:1`],
      [manager, parent, "answer", `answer:question:${parent.id}:1`],
    ] as const) {
      const envelope = message(
        from,
        to,
        kind,
        digest(kind === "instruction" || kind === "answer" ? empty : project),
        id,
      );
      expect(value(r.claim(from.durableSessionId, envelope)).target?.id).toBe(to.id);
      value(r.finish(id, receipt(to)));
    }
    expect(
      r.claim(
        child.durableSessionId,
        message(child, manager, "question", digest(project), `question:${child.id}:1`),
      ),
    ).toMatchObject({ ok: false, error: { code: "route_denied" } });
    value(r.setContactState(manager.id, "paused"));
    const q = {
      ...message(parent, manager, "question", digest(project), `question:${parent.id}:paused`),
      toBindingId: null,
    };
    expect(value(r.post(parent.durableSessionId, q)).state).toBe("posted");
  }));
