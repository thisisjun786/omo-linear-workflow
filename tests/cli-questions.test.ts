import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli";
import type {
  Binding,
  DeliveryRecord,
  NativeReceipt,
  Result,
  RuntimeIdentity,
} from "../src/core/contracts";
import { modelForRole } from "../src/core/policy";
import { openRegistry } from "../src/core/store";
import type { OrchestratorDependencies } from "../src/orchestrator";
import { Orchestrator } from "../src/orchestrator";

const question: DeliveryRecord = {
  envelope: {
    version: 1,
    id: "question:child:1",
    fromBindingId: "child",
    toBindingId: "parent",
    designationId: "designation",
    snapshotDigest: "digest",
    kind: "question",
    text: "Which default?",
    outcome: null,
    evidence: [],
  },
  state: "accepted",
  receipt: {
    kind: "ok",
    thread_id: "parent-session",
    message_seq: 1,
    deduplicated: false,
    delivery: { kind: "started", turn_id: "turn" },
  },
};

async function invoke(
  args: readonly string[],
  reply: Result<unknown> | undefined,
  method: "ask" | "answer" | "answerAsUser" | "questions",
) {
  const root = await mkdtemp(join(tmpdir(), "olw-cli-questions-"));
  const body = join(root, "payload.txt");
  const questions = join(root, "questions.json");
  const answers = join(root, "answers.json");
  await writeFile(body, "Which default?");
  await writeFile(
    questions,
    JSON.stringify({
      questions: [
        {
          id: "choice",
          question: "Choose",
          options: [{ label: "yes", description: "recommended" }],
          multiSelect: false,
        },
      ],
      escalates: null,
    }),
  );
  await writeFile(
    answers,
    JSON.stringify({ answers: { choice: { selected: ["yes"] } }, unanswered: [] }),
  );
  const resolved = args.map((arg) =>
    arg === "payload.txt"
      ? body
      : arg === "questions.json"
        ? questions
        : arg === "answers.json"
          ? answers
          : arg,
  );
  let output = "";
  const stdout = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  const operation =
    reply === undefined
      ? undefined
      : spyOn(Orchestrator.prototype, method).mockResolvedValue(reply as never);
  try {
    const code = await runCli(["--root", root, ...resolved, "--json"]);
    const decoded: unknown = JSON.parse(output);
    return { code, output: decoded, calls: operation?.mock.calls ?? [] };
  } finally {
    operation?.mockRestore();
    stdout.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
}

test("ask forwards the sender, id, text and optional structured questions", async () => {
  const reply = { ok: true as const, value: question };
  const result = await invoke(
    [
      "ask",
      "--from",
      "child",
      "--id",
      "1",
      "--text-file",
      "payload.txt",
      "--questions-file",
      "questions.json",
    ],
    reply,
    "ask",
  );
  expect(result.code).toBe(0);
  expect(result.output).toEqual(reply);
  expect(result.calls[0]?.[0]).toMatchObject({
    fromId: "child",
    messageId: "1",
    text: "Which default?",
    toUser: false,
    questions: { escalates: null },
  });
});

test("ask --to-user is forwarded and a posted question exits 0", async () => {
  const posted = {
    ...question,
    envelope: { ...question.envelope, toBindingId: null },
    state: "posted" as const,
    receipt: null,
  };
  const result = await invoke(
    ["ask", "--from", "parent", "--id", "1", "--text-file", "payload.txt", "--to-user"],
    { ok: true, value: posted },
    "ask",
  );
  expect(result).toMatchObject({ code: 0, calls: [[{ toUser: true }]] });
});

test.each([
  ["route_denied", 2],
  ["runtime_unavailable", 3],
  ["delivery_uncertain", 4],
] as const)("ask exits %s as %s", async (code, exit) => {
  const result = await invoke(
    ["ask", "--from", "child", "--id", "1", "--text-file", "payload.txt"],
    { ok: false, error: { code, message: code } },
    "ask",
  );
  expect(result.code).toBe(exit);
  expect(result.output).toMatchObject({ ok: false, error: { code } });
});

test("ask rejects a missing id before calling the orchestrator", async () => {
  const result = await invoke(
    ["ask", "--from", "child", "--text-file", "payload.txt"],
    undefined,
    "ask",
  );
  expect(result).toMatchObject({
    code: 2,
    output: { ok: false, error: { code: "invalid_arguments" } },
    calls: [],
  });
});

test("answer derives nothing itself and forwards the question id plus structured answers", async () => {
  const answer: DeliveryRecord = {
    ...question,
    envelope: { ...question.envelope, id: "answer:question:child:1", kind: "answer" },
  };
  const result = await invoke(
    [
      "answer",
      "--from",
      "parent",
      "--question",
      "question:child:1",
      "--text-file",
      "payload.txt",
      "--answers-file",
      "answers.json",
    ],
    { ok: true, value: answer },
    "answer",
  );
  expect(result.code).toBe(0);
  expect(result.calls[0]?.[0]).toEqual({
    fromId: "parent",
    questionId: "question:child:1",
    text: "Which default?",
    answers: { choice: { selected: ["yes"] } },
    unanswered: [],
  });
});

test("answer --as-user calls the user path and a rejected native receipt exits 2", async () => {
  const rejected: DeliveryRecord = {
    envelope: {
      ...question.envelope,
      id: "answer:question:parent:1",
      fromBindingId: null,
      toBindingId: "parent",
      kind: "answer",
      answer: { questionId: "question:parent:1", answers: {}, unanswered: [] },
    },
    state: "rejected",
    receipt: {
      kind: "error",
      error: { code: "denied", message: "Denied", next_action: "inspect" },
    },
  };
  const result = await invoke(
    ["answer", "--as-user", "--question", "question:parent:1", "--text-file", "payload.txt"],
    { ok: true, value: rejected },
    "answerAsUser",
  );
  expect(result.code).toBe(2);
  expect(result.output).toMatchObject({
    error: { code: "delivery_rejected", details: { delivery: rejected } },
  });
});

test("answer to an unknown question exits 2 with question_unknown", async () => {
  const reply = { ok: false as const, error: { code: "question_unknown", message: "missing" } };
  const result = await invoke(
    ["answer", "--from", "parent", "--question", "question:missing", "--text-file", "payload.txt"],
    reply,
    "answer",
  );
  expect(result).toMatchObject({ code: 2, output: reply });
});

test("answer --as-user on a native question exits 2 with question_not_in_inbox", async () => {
  const reply = {
    ok: false as const,
    error: { code: "question_not_in_inbox", message: "native" },
  };
  const result = await invoke(
    ["answer", "--as-user", "--question", "question:child:1", "--text-file", "payload.txt"],
    reply,
    "answerAsUser",
  );
  expect(result).toMatchObject({ code: 2, output: reply });
});

test("questions is read-only JSON and creates no registry", async () => {
  const root = await mkdtemp(join(tmpdir(), "olw-cli-questions-list-"));
  const process = Bun.spawn(
    [
      Bun.which("bun") ?? "bun",
      join(import.meta.dir, "../src/cli.ts"),
      "--root",
      root,
      "questions",
      "--json",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [code, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  try {
    expect({ code, stderr, output: JSON.parse(stdout) }).toEqual({
      code: 0,
      stderr: "",
      output: { ok: true, value: [] },
    });
    expect(await Bun.file(join(root, ".omo/state/registry.sqlite")).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("help JSON lists ask, answer and questions", async () => {
  const result = await invoke(["help"], undefined, "ask");
  expect(result.code).toBe(0);
  expect(result.output).toMatchObject({
    ok: true,
    value: {
      commands: expect.arrayContaining(["ask", "answer", "questions"]),
      options: {
        ask: expect.stringContaining("--questions-file"),
        answer: expect.stringContaining("--as-user"),
        questions: expect.stringContaining("read-only"),
      },
    },
  });
});

test("a parent with no ready owner posts a question and questions lists it open", async () => {
  const root = await mkdtemp(join(tmpdir(), "olw-cli-questions-flow-"));
  const body = join(root, "payload.txt");
  await writeFile(body, "Need a decision");
  await mkdir(join(root, ".omo/state"), { recursive: true });
  const registry = openRegistry(join(root, ".omo/state/registry.sqlite"));
  const digest = registry.importScope({
    version: 1,
    source: "fixture",
    initiative: null,
    projects: [
      {
        project: { id: "project", url: "p", revision: "r" },
        issues: [{ id: "issue", url: "issue", revision: "r" }],
      },
    ],
    decisionRefs: [],
  });
  if (!digest.ok) throw new Error(digest.error.message);
  const reserved = registry.reserve({
    bindingId: "parent",
    durableSessionId: "session-parent",
    designation: {
      id: "approval",
      snapshotDigest: digest.value.digest,
      designatedBy: "user",
      designatedAt: "today",
      execute: true,
      create: true,
      contact: true,
    },
    snapshot: {
      version: 1,
      source: "fixture",
      initiative: null,
      projects: [
        {
          project: { id: "project", url: "p", revision: "r" },
          issues: [{ id: "issue", url: "issue", revision: "r" }],
        },
      ],
      decisionRefs: [],
    },
    assignment: { role: "parent", initiativeId: null, projectId: "project", ownerBindingId: null },
    cwd: root,
    checkout: null,
    herdrSocket: "/herdr",
    omoSocket: "/omo",
  });
  if (!reserved.ok) throw new Error(reserved.error.message);
  const sessionPath = join(root, "session.jsonl");
  const ready = [
    registry.provision("parent", "workspace", "pane"),
    registry.observeSession("parent", sessionPath),
    registry.activate("parent", {
      durableSessionId: "session-parent",
      sessionPath,
      cwd: root,
      ...modelForRole("parent"),
      extensionProtocol: 2,
    }),
    registry.beginInitialization("parent", "brief"),
  ].every((step) => step.ok);
  const finished = registry.finishInitialization("parent", "accepted");
  registry.close();
  if (!ready || !finished.ok) throw new Error("parent was not ready");
  const identity: RuntimeIdentity = {
    durableSessionId: "session-parent",
    sessionPath,
    cwd: root,
    ...modelForRole("parent"),
    extensionProtocol: 2,
  };
  const sends: string[] = [];
  const deps: OrchestratorDependencies = {
    openRegistry,
    createHerdrClient: () => {
      throw new Error("questions must not open Herdr");
    },
    resolveHerdrArtifact: async () => ({ artifactDir: "/fixture/herdr" }),
    ensureHost: async () => {},
    checkHostProfile: async () => {},
    gitTip: async () => "base",
    now: () => "2026-09-26",
    uuid: () => "unused",
    terminateBinding: async () => {},
    prompt: async () => {},
    attachBinding: async (binding: Binding) => ({
      configure: async () => {},
      describe: async () => ({ ok: true as const, value: identity }),
      hasUserMessage: async () => false,
      deliverUserAnswer: async () => ({
        ok: false as const,
        error: { code: "route_denied", message: "receipt-only fake cannot deliver a user answer" },
      }),
      send: async (envelope) => {
        sends.push(`${envelope.kind}:${envelope.toBindingId ?? "inbox"}`);
        return {
          ok: true as const,
          value: {
            envelope,
            state: "accepted" as const,
            receipt: {
              kind: "ok" as const,
              thread_id: binding.durableSessionId,
              message_seq: sends.length,
              deduplicated: false,
              delivery: { kind: "started" as const, turn_id: "turn" },
            },
          },
        };
      },
      onEvent: () => () => {},
      close: async () => {},
    }),
  };
  let output = "";
  const stdout = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  const cli = async (args: string[]) => {
    output = "";
    const code = await runCli(["--root", root, ...args, "--json"], deps);
    return { code, output: JSON.parse(output) as unknown };
  };
  try {
    const asked = await cli(["ask", "--from", "parent", "--id", "1", "--text-file", body]);
    expect(asked).toMatchObject({
      code: 0,
      output: {
        ok: true,
        value: { state: "posted", envelope: { id: "question:parent:1", toBindingId: null } },
      },
    });
    expect(sends).toEqual([]);
    const open = await cli(["questions", "--project", "project"]);
    expect(open).toMatchObject({
      code: 0,
      output: {
        ok: true,
        value: [{ answered: false, record: { envelope: { id: "question:parent:1" } } }],
      },
    });
    const child = openRegistry(join(root, ".omo/state/registry.sqlite"));
    const childReserved = child.reserve({
      bindingId: "child",
      durableSessionId: "session-child",
      designation: {
        id: "approval",
        snapshotDigest: digest.value.digest,
        designatedBy: "user",
        designatedAt: "today",
        execute: true,
        create: true,
        contact: true,
      },
      snapshot: {
        version: 1,
        source: "fixture",
        initiative: null,
        projects: [
          {
            project: { id: "project", url: "p", revision: "r" },
            issues: [{ id: "issue", url: "issue", revision: "r" }],
          },
        ],
        decisionRefs: [],
      },
      assignment: {
        role: "child",
        initiativeId: null,
        projectId: "project",
        issueId: "issue",
        ownerBindingId: "parent",
      },
      cwd: root,
      checkout: null,
      herdrSocket: "/herdr",
      omoSocket: "/omo",
    });
    if (!childReserved.ok) throw new Error(childReserved.error.message);
    for (const step of [
      child.provision("child", "workspace-child", "pane-child"),
      child.observeSession("child", join(root, "child.jsonl")),
      child.activate("child", {
        durableSessionId: "session-child",
        sessionPath: join(root, "child.jsonl"),
        cwd: root,
        ...modelForRole("child"),
        extensionProtocol: 2,
      }),
      child.beginInitialization("child", "brief"),
    ]) {
      if (!step.ok) throw new Error(step.error.message);
    }
    const childReady = child.finishInitialization("child", "accepted");
    if (!childReady.ok) throw new Error(childReady.error.message);
    const nativeQuestion = child.claim("session-child", {
      version: 1,
      id: "question:child:native",
      fromBindingId: "child",
      toBindingId: "parent",
      designationId: "approval",
      snapshotDigest: digest.value.digest,
      kind: "question",
      text: "native?",
      outcome: null,
      evidence: [],
      question: {
        questions: [
          { id: "text", question: "native?", options: [{ label: "text" }], multiSelect: false },
        ],
        escalates: null,
      },
    });
    if (!nativeQuestion.ok) throw new Error(nativeQuestion.error.message);
    const nativeReceipt = child.finish("question:child:native", {
      kind: "ok",
      thread_id: "session-parent",
      message_seq: 1,
      deduplicated: false,
      delivery: { kind: "started", turn_id: "turn" },
    });
    child.close();
    if (!nativeReceipt.ok) throw new Error(nativeReceipt.error.message);
    const native = await cli([
      "answer",
      "--as-user",
      "--question",
      "question:child:native",
      "--text-file",
      body,
    ]);
    expect(native).toMatchObject({
      code: 2,
      output: { ok: false, error: { code: "question_not_in_inbox" } },
    });
    const missing = await cli([
      "answer",
      "--from",
      "parent",
      "--question",
      "question:missing",
      "--text-file",
      body,
    ]);
    expect(missing).toMatchObject({
      code: 2,
      output: { ok: false, error: { code: "question_unknown" } },
    });
  } finally {
    stdout.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

test("an accepted ask receipt keeps exit 0", async () => {
  const receipt: NativeReceipt = question.receipt as NativeReceipt;
  expect(receipt.kind).toBe("ok");
  const result = await invoke(
    ["ask", "--from", "child", "--id", "1", "--text-file", "payload.txt"],
    { ok: true, value: question },
    "ask",
  );
  expect(result).toMatchObject({ code: 0, output: { ok: true, value: { state: "accepted" } } });
});
