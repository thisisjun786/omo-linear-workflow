import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Assignment,
  Binding,
  Designation,
  Envelope,
  NativeReceipt,
  ReserveInput,
  Result,
  ScopeSnapshot,
} from "../src/core/contracts";
import { runtimeIdentitySchema } from "../src/core/schema";
import { openRegistry } from "../src/core/store";

const snapshot: ScopeSnapshot = {
  version: 1,
  source: "fixture",
  initiative: { id: "initiative-1", url: "linear://initiative-1", revision: "rev-1" },
  projects: [
    {
      project: { id: "project-1", url: "linear://project-1", revision: "rev-1" },
      issues: [
        { id: "issue-1", url: "linear://issue-1", revision: "rev-1" },
        { id: "issue-2", url: "linear://issue-2", revision: "rev-1" },
      ],
    },
  ],
  decisionRefs: [],
};

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function designation(digest: string, id = "designation-1"): Designation {
  return {
    id,
    snapshotDigest: digest,
    designatedBy: "user",
    designatedAt: "2026-09-22T00:00:00Z",
    execute: true,
    create: true,
    contact: true,
  };
}

function reserveInput(
  bindingId: string,
  digest: string,
  assignment: Assignment,
  designationId = "designation-1",
): ReserveInput {
  return {
    bindingId,
    durableSessionId: `session-${bindingId}`,
    designation: designation(digest, designationId),
    snapshot,
    assignment,
    cwd: "/repo",
    checkout:
      assignment.role === "supervisor"
        ? null
        : {
            originalRepoRoot: "/repo",
            path: `/worktrees/${bindingId}`,
            branch: `omo/${bindingId}`,
            baseBranch: "main",
            baseCommit: "0123456789abcdef",
          },
    herdrSocket: "/tmp/herdr.sock",
    omoSocket: "/tmp/omo.sock",
  };
}

function envelope(
  from: Binding,
  to: Binding,
  digest: string,
  kind: Envelope["kind"],
  id = "message-1",
): Envelope {
  return {
    version: 1,
    id,
    fromBindingId: from.id,
    toBindingId: to.id,
    designationId: from.designationId,
    snapshotDigest: digest,
    kind,
    text: "payload",
    outcome: kind === "report" ? "completed" : null,
    evidence: [],
  };
}

function activate(registry: ReturnType<typeof openRegistry>, binding: Binding): Binding {
  value(registry.provision(binding.id, `workspace-${binding.id}`, `pane-${binding.id}`));
  value(registry.observeSession(binding.id, `/sessions/${binding.id}.jsonl`));
  const roles = {
    supervisor: { provider: "cliproxyapi", modelId: "gpt-6-astra", thinking: "high" },
    parent: { provider: "cliproxyapi", modelId: "claude-opus-5-5", thinking: "xhigh" },
    child: { provider: "cliproxyapi", modelId: "claude-opus-5-5", thinking: "xhigh" },
  };
  const configured = value(
    registry.activate(
      binding.id,
      runtimeIdentitySchema.parse({
        durableSessionId: binding.durableSessionId,
        sessionPath: `/sessions/${binding.id}.jsonl`,
        cwd: binding.cwd,
        ...roles[binding.assignment.role],
        extensionProtocol: 1,
      }),
    ),
  );
  value(registry.beginInitialization(configured.id, "Fixture initialization"));
  return value(registry.finishInitialization(configured.id, "accepted"));
}

async function temporaryDatabase(run: (path: string) => void | Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "omo-core-"));
  try {
    await run(join(directory, "registry.sqlite"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function ready(process: Bun.Subprocess<"pipe", "pipe", "inherit">) {
  const reader = process.stdout.getReader();
  const first = await reader.read();
  expect(first.done).toBe(false);
  expect(new TextDecoder().decode(first.value)).toBe("READY\n");
  return reader;
}

async function response(reader: Awaited<ReturnType<typeof ready>>) {
  let output = "";
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    output += new TextDecoder().decode(part.value);
  }
  const decoded: unknown = JSON.parse(output);
  return decoded;
}

describe("SQLite registry", () => {
  test("keeps verified runtime initializing until its first instruction is accepted", async () => {
    await temporaryDatabase((path) => {
      const registry = openRegistry(path);
      try {
        const digest = value(registry.importScope(snapshot)).digest;
        const binding = value(
          registry.reserve(
            reserveInput("initial", digest, {
              role: "supervisor",
              initiativeId: "initiative-1",
            }),
          ),
        );
        value(registry.provision(binding.id, "workspace", "pane"));
        value(registry.observeSession(binding.id, "/sessions/initial.jsonl"));
        const configured = value(
          registry.activate(binding.id, {
            durableSessionId: binding.durableSessionId,
            sessionPath: "/sessions/initial.jsonl",
            cwd: binding.cwd,
            provider: "cliproxyapi",
            modelId: "gpt-6-astra",
            thinking: "high",
            extensionProtocol: 1,
          }),
        );
        expect(configured.launchState).toBe("initializing");
        const claim = value(registry.beginInitialization(binding.id, "Initial instruction"));
        expect(claim.disposition).toBe("new");
        expect(
          value(registry.beginInitialization(binding.id, "Initial instruction")).disposition,
        ).toBe("in_progress");
        expect(registry.beginInitialization(binding.id, "Changed instruction").ok).toBe(false);
        expect(value(registry.finishInitialization(binding.id, "accepted")).launchState).toBe(
          "ready",
        );
        expect(
          value(registry.beginInitialization(binding.id, "Initial instruction")).disposition,
        ).toBe("replay");
      } finally {
        registry.close();
      }
    });
  });

  test("uses a real transaction for unique live ownership and survives reopen", async () => {
    await temporaryDatabase(async (path) => {
      const seed = openRegistry(path);
      const digest = value(seed.importScope(snapshot)).digest;
      seed.close();
      const assignment: Assignment = { role: "supervisor", initiativeId: "initiative-1" };
      const inputs = [
        reserveInput("supervisor-a", digest, assignment),
        reserveInput("supervisor-b", digest, assignment),
      ];
      const children = inputs.map((input) =>
        Bun.spawn(["bun", "tests/core/reserve-process"], {
          cwd: import.meta.dir.replace(/\/tests$/, ""),
          stdin: "pipe",
          stdout: "pipe",
          stderr: "inherit",
          env: { ...process.env, TEST_DB_PATH: path, TEST_RESERVE_INPUT: JSON.stringify(input) },
        }),
      );
      const readers = await Promise.all(children.map(ready));
      for (const child of children) {
        child.stdin.write("go\n");
        child.stdin.end();
      }
      const results = await Promise.all(readers.map(response));
      await Promise.all(children.map((child) => child.exited));
      const parsed = results.flatMap((result) => {
        if (typeof result !== "object" || result === null || !("ok" in result)) return [];
        return [result.ok];
      });
      expect(parsed.sort()).toEqual([false, true]);

      const reopened = openRegistry(path);
      expect(value(reopened.list())).toHaveLength(1);
      expect(
        value(reopened.bySession(`session-${value(reopened.list())[0]?.id}`)).assignment,
      ).toEqual(assignment);
      reopened.close();
    });
  });

  test("validates scope membership, owner edges, and readiness identity", async () => {
    await temporaryDatabase((path) => {
      const registry = openRegistry(path);
      const digest = value(registry.importScope(snapshot)).digest;
      const supervisor = value(
        registry.reserve(
          reserveInput("supervisor", digest, { role: "supervisor", initiativeId: "initiative-1" }),
        ),
      );
      const badProject = registry.reserve(
        reserveInput("bad", digest, {
          role: "parent",
          initiativeId: "initiative-1",
          projectId: "foreign",
          ownerBindingId: supervisor.id,
        }),
      );
      expect(badProject.ok ? "ok" : badProject.error.code).toBe("scope_violation");
      const parent = value(
        registry.reserve(
          reserveInput("parent", digest, {
            role: "parent",
            initiativeId: "initiative-1",
            projectId: "project-1",
            ownerBindingId: supervisor.id,
          }),
        ),
      );
      const wrongOwner = registry.reserve(
        reserveInput("child", digest, {
          role: "child",
          initiativeId: "initiative-1",
          projectId: "project-1",
          issueId: "issue-1",
          ownerBindingId: supervisor.id,
        }),
      );
      expect(wrongOwner.ok ? "ok" : wrongOwner.error.code).toBe("owner_mismatch");
      expect(registry.setLaunchState(parent.id, "ready").ok).toBe(false);
      value(registry.provision(parent.id, "workspace", "pane"));
      value(registry.observeSession(parent.id, "/sessions/parent"));
      const mismatch = registry.activate(parent.id, {
        durableSessionId: parent.durableSessionId,
        sessionPath: "/sessions/parent",
        cwd: parent.cwd,
        provider: "chatgpt-subscription",
        modelId: "gpt-6-astra",
        thinking: "high",
        extensionProtocol: 1,
      });
      expect(mismatch.ok ? "ok" : mismatch.error.code).toBe("identity_mismatch");
      registry.close();
    });
  });

  test("enforces immediate-owner routes, designation contact permission, and paused state", async () => {
    await temporaryDatabase((path) => {
      const registry = openRegistry(path);
      const digest = value(registry.importScope(snapshot)).digest;
      const supervisor = activate(
        registry,
        value(
          registry.reserve(
            reserveInput("supervisor", digest, {
              role: "supervisor",
              initiativeId: "initiative-1",
            }),
          ),
        ),
      );
      const parent = activate(
        registry,
        value(
          registry.reserve(
            reserveInput("parent", digest, {
              role: "parent",
              initiativeId: "initiative-1",
              projectId: "project-1",
              ownerBindingId: supervisor.id,
            }),
          ),
        ),
      );
      const child = activate(
        registry,
        value(
          registry.reserve(
            reserveInput("child", digest, {
              role: "child",
              initiativeId: "initiative-1",
              projectId: "project-1",
              issueId: "issue-1",
              ownerBindingId: parent.id,
            }),
          ),
        ),
      );
      expect(
        value(
          registry.authorize(
            supervisor.durableSessionId,
            envelope(supervisor, parent, digest, "instruction"),
          ),
        ).id,
      ).toBe(parent.id);
      const skipped = registry.authorize(
        supervisor.durableSessionId,
        envelope(supervisor, child, digest, "instruction", "skip"),
      );
      expect(skipped.ok ? "ok" : skipped.error.code).toBe("route_denied");
      expect(
        value(
          registry.authorize(
            child.durableSessionId,
            envelope(child, parent, digest, "report", "report"),
          ),
        ).id,
      ).toBe(parent.id);
      const foreignSnapshot: ScopeSnapshot = {
        version: 1,
        source: "fixture",
        initiative: { id: "initiative-2", url: "linear://initiative-2", revision: "rev-1" },
        projects: [],
        decisionRefs: [],
      };
      const foreignDigest = value(registry.importScope(foreignSnapshot)).digest;
      const foreignBase = reserveInput("foreign", foreignDigest, {
        role: "supervisor",
        initiativeId: "initiative-2",
      });
      const foreign = activate(
        registry,
        value(
          registry.reserve({
            ...foreignBase,
            snapshot: foreignSnapshot,
            designation: designation(foreignDigest, "designation-2"),
          }),
        ),
      );
      const foreignRoute = registry.authorize(
        supervisor.durableSessionId,
        envelope(supervisor, foreign, digest, "instruction", "foreign"),
      );
      expect(foreignRoute.ok ? "ok" : foreignRoute.error.code).toBe("foreign_designation");
      value(registry.setContactState(parent.id, "paused"));
      const paused = registry.authorize(
        child.durableSessionId,
        envelope(child, parent, digest, "report", "paused"),
      );
      expect(paused.ok ? "ok" : paused.error.code).toBe("contact_paused");
      registry.close();
    });
  });

  test("claims immutable payloads and preserves uncertain sends without retry", async () => {
    await temporaryDatabase((path) => {
      const registry = openRegistry(path);
      const digest = value(registry.importScope(snapshot)).digest;
      const supervisor = activate(
        registry,
        value(
          registry.reserve(
            reserveInput("supervisor", digest, {
              role: "supervisor",
              initiativeId: "initiative-1",
            }),
          ),
        ),
      );
      const parent = activate(
        registry,
        value(
          registry.reserve(
            reserveInput("parent", digest, {
              role: "parent",
              initiativeId: "initiative-1",
              projectId: "project-1",
              ownerBindingId: supervisor.id,
            }),
          ),
        ),
      );
      const message = envelope(supervisor, parent, digest, "instruction");
      expect(value(registry.claim(supervisor.durableSessionId, message)).disposition).toBe("new");
      expect(value(registry.claim(supervisor.durableSessionId, message)).disposition).toBe(
        "in_progress",
      );
      const { text, ...otherFields } = message;
      expect(
        value(registry.claim(supervisor.durableSessionId, { text, ...otherFields })).disposition,
      ).toBe("in_progress");
      const changed = registry.claim(supervisor.durableSessionId, { ...message, text: "changed" });
      expect(changed.ok ? "ok" : changed.error.code).toBe("message_conflict");
      const completed = { ...message, id: "message-completed" };
      value(registry.claim(supervisor.durableSessionId, completed));
      const receipt: NativeReceipt = {
        kind: "ok",
        thread_id: parent.durableSessionId,
        message_seq: 1,
        deduplicated: false,
        delivery: { kind: "started", turn_id: "turn-1" },
      };
      expect(value(registry.finish(completed.id, receipt)).state).toBe("accepted");
      const replay = value(registry.claim(supervisor.durableSessionId, completed));
      expect(replay.disposition).toBe("replay");
      expect(replay.record.receipt).toEqual(receipt);
      expect(
        value(registry.uncertain(message.id, "worker lost after native invocation")).state,
      ).toBe("uncertain");
      registry.close();

      const reopened = openRegistry(path);
      expect(value(reopened.delivery(message.id)).state).toBe("uncertain");
      expect(value(reopened.claim(supervisor.durableSessionId, message)).disposition).toBe(
        "in_progress",
      );
      reopened.close();
    });
  });

  test.each(["stdin", "argv"] as const)(
    "worker executes one validated JSON operation through %s and releases the database",
    async (mode) => {
      await temporaryDatabase(async (path) => {
        const registry = openRegistry(path);
        const digest = value(registry.importScope(snapshot)).digest;
        const binding = value(
          registry.reserve(
            reserveInput("worker-target", digest, {
              role: "supervisor",
              initiativeId: "initiative-1",
            }),
          ),
        );
        registry.close();
        const request = JSON.stringify({
          version: 1,
          dbPath: path,
          action: "lookup-session",
          input: { durableSessionId: binding.durableSessionId },
        });
        const worker = Bun.spawn(
          ["bun", "src/core/worker", ...(mode === "argv" ? [request] : [])],
          {
            cwd: import.meta.dir.replace(/\/tests$/, ""),
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        if (mode === "stdin") worker.stdin.write(request);
        worker.stdin.end();
        const output = await new Response(worker.stdout).text();
        const stderr = await new Response(worker.stderr).text();
        expect(await worker.exited).toBe(0);
        expect(stderr).toBe("");
        expect(JSON.parse(output)).toEqual({ ok: true, value: binding });
        const reopened = openRegistry(path);
        expect(value(reopened.get(binding.id))).toEqual(binding);
        reopened.close();
      });
    },
  );
});
