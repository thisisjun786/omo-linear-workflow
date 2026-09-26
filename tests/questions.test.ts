import { Database } from "bun:sqlite";
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
import { modelForRole } from "../src/core/policy";
import { envelopeSchema } from "../src/core/schema";
import { openRegistry } from "../src/core/store";

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}
const scope: ScopeSnapshot = {
  version: 1,
  source: "fixture",
  initiative: { id: "i", url: "i", revision: "r" },
  projects: [
    {
      project: { id: "p", url: "p", revision: "r" },
      issues: [
        { id: "c", url: "c", revision: "r" },
        { id: "c2", url: "c2", revision: "r" },
      ],
    },
  ],
  decisionRefs: [],
};
async function fixture(
  run: (
    r: Registry,
    bindings: { supervisor: Binding; parent: Binding; child: Binding },
    digest: string,
    path: string,
    make: (id: string, assignment: Assignment) => Binding,
  ) => void,
) {
  const dir = await mkdtemp(join(tmpdir(), "olw-questions-"));
  const path = join(dir, "registry.sqlite");
  const r = openRegistry(path);
  try {
    const digest = value(r.importScope(scope)).digest;
    const make = (id: string, assignment: Assignment) => {
      const b = value(
        r.reserve({
          bindingId: id,
          durableSessionId: `session-${id}`,
          designation: {
            id: "d",
            snapshotDigest: digest,
            designatedBy: "user",
            designatedAt: "today",
            execute: true,
            create: true,
            contact: true,
          },
          snapshot: scope,
          assignment,
          cwd: "/repo",
          checkout: null,
          herdrSocket: "/herdr",
          omoSocket: "/omo",
        }),
      );
      value(r.provision(id, `workspace-${id}`, `pane-${id}`));
      value(r.observeSession(id, `/sessions/${id}`));
      value(
        r.activate(id, {
          durableSessionId: b.durableSessionId,
          sessionPath: `/sessions/${id}`,
          cwd: "/repo",
          ...modelForRole(assignment.role),
          extensionProtocol: 1,
        }),
      );
      value(r.beginInitialization(id, "brief"));
      return value(r.finishInitialization(id, "accepted"));
    };
    const supervisor = make("supervisor", { role: "supervisor", initiativeId: "i" });
    const parent = make("parent", {
      role: "parent",
      initiativeId: "i",
      projectId: "p",
      ownerBindingId: supervisor.id,
    });
    const child = make("child", {
      role: "child",
      initiativeId: "i",
      projectId: "p",
      issueId: "c",
      ownerBindingId: parent.id,
    });
    run(r, { supervisor, parent, child }, digest, path, make);
  } finally {
    r.close();
    await rm(dir, { recursive: true, force: true });
  }
}
function question(from: Binding, to: Binding | null, digest: string): Envelope {
  return {
    version: 1,
    id: `question:${from.id}:1`,
    fromBindingId: from.id,
    toBindingId: to?.id ?? null,
    designationId: from.designationId,
    snapshotDigest: digest,
    kind: "question",
    text: "Decision?",
    outcome: null,
    evidence: [],
    question: {
      questions: [
        { id: "choice", question: "Choose", options: [{ label: "yes" }], multiSelect: false },
      ],
      escalates: null,
    },
  };
}
function answer(from: Binding | null, to: Binding, q: Envelope, digest: string): Envelope {
  return {
    version: 1,
    id: `answer:${q.id}`,
    fromBindingId: from?.id ?? null,
    toBindingId: to.id,
    designationId: to.designationId,
    snapshotDigest: digest,
    kind: "answer",
    text: "yes",
    outcome: null,
    evidence: [],
    answer: { questionId: q.id, answers: { choice: { selected: ["yes"] } }, unanswered: [] },
  };
}
const receipt = (to: Binding) => ({
  kind: "ok" as const,
  thread_id: to.durableSessionId,
  message_seq: 1,
  deduplicated: false,
  delivery: { kind: "started" as const, turn_id: "turn" },
});

test("question/answer boundary rejects malformed structures and IDs", () => {
  const q = question({ id: "child", designationId: "d" } as Binding, null, "digest");
  expect(envelopeSchema.safeParse(q).success).toBe(true);
  for (const bad of [
    { ...q, id: "wrong" },
    {
      ...q,
      question: { questions: [{ id: "x", options: [], multiSelect: "no" }], escalates: null },
    },
    { ...q, question: { questions: [], escalates: 3 } },
    { ...q, outcome: "completed" },
  ])
    expect(envelopeSchema.safeParse(bad).success).toBe(false);
  const a = answer(null, { id: "parent", designationId: "d" } as Binding, q, "digest");
  expect(envelopeSchema.safeParse(a).success).toBe(true);
  for (const bad of [
    { ...a, id: "wrong" },
    { ...a, answer: { ...a.answer, answers: { choice: { selected: "yes" } } } },
    { ...a, answer: { questionId: 1, answers: {}, unanswered: [] } },
    { ...a, outcome: "blocked" },
  ])
    expect(envelopeSchema.safeParse(bad).success).toBe(false);
});

test("owner routes, accepted question prerequisite, replay and conflicting answer", async () =>
  fixture((r, { supervisor, parent, child }, digest) => {
    for (const [from, to] of [
      [child, parent],
      [parent, supervisor],
    ] as const) {
      const q = question(from, to, digest);
      expect(value(r.claim(from.durableSessionId, q)).disposition).toBe("new");
      value(r.finish(q.id, receipt(to)));
      expect(value(r.claim(from.durableSessionId, q)).disposition).toBe("replay");
      expect(r.claim(from.durableSessionId, { ...q, text: "different" })).toMatchObject({
        ok: false,
        error: { code: "message_conflict" },
      });
      const a = answer(to, from, q, digest);
      expect(value(r.claim(to.durableSessionId, a)).disposition).toBe("new");
      value(r.finish(a.id, receipt(from)));
      expect(value(r.claim(to.durableSessionId, a)).disposition).toBe("replay");
      expect(r.claim(to.durableSessionId, { ...a, text: "different" })).toMatchObject({
        ok: false,
        error: { code: "message_conflict" },
      });
    }
    expect(r.claim(child.durableSessionId, question(child, supervisor, digest))).toMatchObject({
      ok: false,
      error: { code: "route_denied" },
    });
    expect(r.post(child.durableSessionId, question(child, null, digest))).toMatchObject({
      ok: false,
      error: { code: "route_denied" },
    });
    const unknown = question(child, parent, digest);
    expect(
      r.claim(
        parent.durableSessionId,
        answer(parent, child, { ...unknown, id: "question:child:unknown" }, digest),
      ),
    ).toMatchObject({ ok: false, error: { code: "question_unknown" } });
    expect(
      r.claim(supervisor.durableSessionId, answer(supervisor, child, unknown, digest)).ok,
    ).toBe(false);
    expect(
      r.authorize(parent.durableSessionId, {
        ...question(parent, child, digest),
        kind: "instruction",
        question: undefined,
      }),
    ).toMatchObject({ ok: true });
    expect(
      r.authorize(child.durableSessionId, {
        ...question(child, parent, digest),
        kind: "report",
        outcome: "completed",
        question: undefined,
      }),
    ).toMatchObject({ ok: true });
  }));

test("manager-linked parent asks and receives an answer; child cannot ask manager", async () =>
  fixture((r, { parent, child }, digest) => {
    const snapshot: ScopeSnapshot = {
      version: 1,
      source: "linear-export",
      initiative: null,
      projects: [],
      decisionRefs: [],
    };
    const managerDigest = value(r.importScope(snapshot)).digest;
    const manager = value(
      r.reserve({
        bindingId: "manager",
        durableSessionId: "session-manager",
        designation: {
          id: "manager-designation",
          snapshotDigest: managerDigest,
          designatedBy: "user",
          designatedAt: "today",
          execute: true,
          create: true,
          contact: true,
        },
        snapshot,
        assignment: { role: "manager" },
        cwd: "/repo",
        checkout: null,
        herdrSocket: "/herdr",
        omoSocket: "/omo",
      }),
    );
    value(r.provision(manager.id, "workspace-manager", "pane-manager"));
    value(r.observeSession(manager.id, "/sessions/manager"));
    value(
      r.activate(manager.id, {
        durableSessionId: manager.durableSessionId,
        sessionPath: "/sessions/manager",
        cwd: "/repo",
        provider: "opencodex",
        modelId: "anthropic/claude-opus-5-5",
        thinking: "medium",
        extensionProtocol: 2,
      }),
    );
    value(r.beginInitialization(manager.id, "brief"));
    value(r.finishInitialization(manager.id, "accepted"));
    value(r.setOwner(parent.id, manager.id));
    const q = question(parent, manager, digest);
    expect(value(r.claim(parent.durableSessionId, q)).target?.id).toBe(manager.id);
    value(r.finish(q.id, receipt(manager)));
    const a = {
      ...answer(manager, parent, q, managerDigest),
      designationId: manager.designationId,
    };
    expect(value(r.claim(manager.durableSessionId, a)).target?.id).toBe(parent.id);
    value(r.finish(a.id, receipt(parent)));
    expect(r.claim(child.durableSessionId, question(child, manager, digest))).toMatchObject({
      ok: false,
      error: { code: "route_denied" },
    });
    value(r.setContactState(manager.id, "paused"));
    expect(
      value(
        r.post(parent.durableSessionId, {
          ...question(parent, null, digest),
          id: `question:${parent.id}:paused`,
        }),
      ).state,
    ).toBe("posted");
  }));

test("role-valid answers cannot use another recipient's accepted question", async () =>
  fixture((r, { supervisor, parent, child }, digest, _path, make) => {
    const otherChild = make("child-b", {
      role: "child",
      initiativeId: "i",
      projectId: "p",
      issueId: "c2",
      ownerBindingId: parent.id,
    });
    const otherQuestion = question(otherChild, parent, digest);
    value(r.claim(otherChild.durableSessionId, otherQuestion));
    value(r.finish(otherQuestion.id, receipt(parent)));
    expect(
      r.claim(parent.durableSessionId, answer(parent, child, otherQuestion, digest)),
    ).toMatchObject({
      ok: false,
      error: { code: "question_unknown" },
    });

    // The posted question is from this parent, but was never addressed to its supervisor.
    const inboxQuestion = { ...question(parent, null, digest), id: `question:${parent.id}:inbox` };
    value(r.post(parent.durableSessionId, inboxQuestion));
    expect(
      r.claim(supervisor.durableSessionId, answer(supervisor, parent, inboxQuestion, digest)),
    ).toMatchObject({
      ok: false,
      error: { code: "question_unknown" },
    });
    expect(value(r.delivery(otherQuestion.id)).state).toBe("accepted");
  }));

test("parent inbox fallback and user answer claim", async () =>
  fixture((r, { parent, child }, digest, path) => {
    const q = question(parent, null, digest);
    expect(value(r.post(parent.durableSessionId, q)).state).toBe("posted");
    expect(value(r.postedQuestions({}))).toMatchObject([{ answered: false }]);
    const a = answer(null, parent, q, digest);
    expect(r.answerFromUser(q.id, { ...a, fromBindingId: child.id })).toMatchObject({
      ok: false,
      error: { code: "route_denied" },
    });
    expect(value(r.postedQuestions({}))).toMatchObject([{ answered: false }]);
    expect(r.delivery(a.id)).toMatchObject({ ok: false, error: { code: "not_found" } });
    const claimed = value(r.answerFromUser(q.id, a));
    expect(claimed).toMatchObject({ disposition: "new", target: { id: parent.id } });
    expect(claimed.nativeKey).toBe(a.id);
    value(r.finish(a.id, receipt(parent)));
    expect(value(r.answerFromUser(q.id, a)).disposition).toBe("replay");
    expect(value(r.postedQuestions({}))).toMatchObject([{ answered: true }]);
    expect(r.answerFromUser(q.id, { ...a, text: "different" })).toMatchObject({
      ok: false,
      error: { code: "message_conflict" },
    });
    const native = question(child, parent, digest);
    value(r.claim(child.durableSessionId, native));
    value(r.finish(native.id, receipt(parent)));
    expect(r.answerFromUser(native.id, answer(null, parent, native, digest))).toMatchObject({
      ok: false,
      error: { code: "question_not_in_inbox" },
    });
    const rows = new Database(path, { readonly: true })
      .query("SELECT message_id, state FROM deliveries ORDER BY rowid")
      .all();
    expect(rows).toHaveLength(3);
  }));
