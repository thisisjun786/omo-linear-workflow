import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Binding, Result, ScopeSnapshot } from "../src/core/contracts";
import { buildRoleBrief, readScopeSnapshot } from "../src/linear";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function tempFile(name: string, content: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "omo-linear-"));
  const path = join(directory, name);
  await writeFile(path, content);
  cleanups.push(async () => rm(directory, { recursive: true, force: true }));
  return path;
}

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function fixtureSnapshot(): ScopeSnapshot {
  return {
    version: 1,
    source: "fixture",
    initiative: {
      id: "initiative-omo-1",
      url: "linear://initiative/OMO-1",
      revision: "rev-2026-09-22-001",
    },
    projects: [
      {
        project: {
          id: "project-omo-1",
          url: "linear://project/PROJ-1",
          revision: "rev-2026-09-22-001",
        },
        issues: [
          { id: "issue-omo-1", url: "linear://issue/ISS-1", revision: "rev-2026-09-22-001" },
          { id: "issue-omo-2", url: "linear://issue/ISS-2", revision: "rev-2026-09-22-001" },
        ],
      },
    ],
    decisionRefs: [],
  };
}

function makeBinding(
  role: Binding["assignment"]["role"],
  overrides: Partial<Binding> = {},
): Binding {
  const assignment: Binding["assignment"] =
    role === "parent"
      ? {
          role: "parent",
          initiativeId: "initiative-omo-1",
          projectId: "project-omo-1",
          ownerBindingId: "binding-supervisor",
        }
      : role === "child"
        ? {
            role: "child",
            initiativeId: "initiative-omo-1",
            projectId: "project-omo-1",
            issueId: "issue-omo-1",
            ownerBindingId: "binding-parent",
          }
        : { role: "supervisor", initiativeId: "initiative-omo-1" };
  const base: Binding = {
    id: `binding-${role}`,
    designationId: "designation-1",
    assignment,
    durableSessionId: `session-${role}`,
    cwd: "/repo",
    checkout: null,
    herdrSocket: "/tmp/herdr.sock",
    omoSocket: "/tmp/omo.sock",
    workspaceId: null,
    paneId: null,
    sessionPath: null,
    launchState: "reserved",
    initialization: { state: "pending", text: null },
    contactState: "active",
  };
  return { ...base, ...overrides };
}

describe("readScopeSnapshot", () => {
  test("accepts the committed fixture with stable ids", async () => {
    const snapshot = value(
      await readScopeSnapshot(join(import.meta.dir, "fixtures", "scope.json")),
    );
    expect(snapshot.version).toBe(1);
    expect(snapshot.source).toBe("fixture");
    expect(snapshot.initiative.id).toBe("initiative-omo-1");
    expect(snapshot.projects).toHaveLength(1);
    expect(snapshot.projects[0]?.project.id).toBe("project-omo-1");
    expect(snapshot.projects[0]?.issues.map((issue) => issue.id)).toEqual([
      "issue-omo-1",
      "issue-omo-2",
    ]);
  });

  test("rejects a missing file", async () => {
    const result = await readScopeSnapshot("/nonexistent/scope.json");
    expect(result.ok).toBe(false);
    expect(result.ok || result.error.code).not.toBe("ok");
    if (!result.ok) expect(result.error.code).toBe("read_error");
  });

  test("rejects malformed json", async () => {
    const path = await tempFile("bad.json", "{ not json");
    const result = await readScopeSnapshot(path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("parse_error");
  });

  test("rejects schema violations", async () => {
    const path = await tempFile("no-version.json", JSON.stringify({ source: "fixture" }));
    const result = await readScopeSnapshot(path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("schema_violation");
  });

  test("rejects whitespace-only revision as malformed", async () => {
    const original = fixtureSnapshot();
    const bad: ScopeSnapshot = {
      ...original,
      initiative: { ...original.initiative, revision: "   " },
    };
    const path = await tempFile("whitespace-revision.json", JSON.stringify(bad));
    const result = await readScopeSnapshot(path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("malformed_revision");
  });

  test("rejects duplicate project ids", async () => {
    const original = fixtureSnapshot();
    const bad: ScopeSnapshot = {
      ...original,
      projects: [
        {
          project: { id: "project-omo-1", url: "linear://project/PROJ-1", revision: "rev-1" },
          issues: [],
        },
        {
          project: {
            id: "project-omo-1",
            url: "linear://project/PROJ-1-dup",
            revision: "rev-1",
          },
          issues: [],
        },
      ],
    };
    const path = await tempFile("dup-projects.json", JSON.stringify(bad));
    const result = await readScopeSnapshot(path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("duplicate_membership");
  });

  test("rejects duplicate issue ids within a project", async () => {
    const original = fixtureSnapshot();
    const firstProject = original.projects[0];
    if (firstProject === undefined) throw new Error("fixture project is missing");
    const bad: ScopeSnapshot = {
      ...original,
      projects: [
        {
          project: firstProject.project,
          issues: [
            { id: "issue-omo-1", url: "linear://issue/ISS-1", revision: "rev-1" },
            { id: "issue-omo-1", url: "linear://issue/ISS-1-dup", revision: "rev-1" },
          ],
        },
      ],
    };
    const path = await tempFile("dup-issues.json", JSON.stringify(bad));
    const result = await readScopeSnapshot(path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("duplicate_membership");
  });

  test("rejects duplicate issue ids across projects", async () => {
    const original = fixtureSnapshot();
    const firstProject = original.projects[0];
    if (firstProject === undefined) throw new Error("fixture project is missing");
    const bad: ScopeSnapshot = {
      ...original,
      projects: [
        firstProject,
        {
          project: { id: "project-omo-2", url: "linear://project/PROJ-2", revision: "rev-1" },
          issues: [{ id: "issue-omo-1", url: "linear://issue/ISS-1", revision: "rev-1" }],
        },
      ],
    };
    const path = await tempFile("cross-dup-issues.json", JSON.stringify(bad));
    const result = await readScopeSnapshot(path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("duplicate_membership");
  });
});

describe("buildRoleBrief", () => {
  const snapshot = fixtureSnapshot();

  test("supervisor brief embeds machine bindings and scope refs", () => {
    const binding = makeBinding("supervisor", {
      id: "binding-supervisor",
      durableSessionId: "session-supervisor",
      designationId: "designation-1",
    });
    const brief = buildRoleBrief(binding, snapshot);
    expect(brief).toContain("binding_id: binding-supervisor");
    expect(brief).toContain("durable_session_id: session-supervisor");
    expect(brief).toContain("designation_id: designation-1");
    expect(brief).toContain("snapshot_digest:");
    expect(brief).toContain("role: supervisor");
    expect(brief).toContain("initiative_id: initiative-omo-1");
    expect(brief).toContain("source: fixture");
  });

  test("parent brief embeds project scope ref", () => {
    const binding = makeBinding("parent");
    const brief = buildRoleBrief(binding, snapshot);
    expect(brief).toContain("role: parent");
    expect(brief).toContain("project_id: project-omo-1");
    expect(brief).toContain("initiative_id: initiative-omo-1");
  });

  test("child brief embeds project and issue scope refs", () => {
    const binding = makeBinding("child");
    const brief = buildRoleBrief(binding, snapshot);
    expect(brief).toContain("role: child");
    expect(brief).toContain("project_id: project-omo-1");
    expect(brief).toContain("issue_id: issue-omo-1");
  });

  test("fixture brief instructs qa standby without autonomous loops", () => {
    const binding = makeBinding("supervisor");
    const brief = buildRoleBrief(binding, snapshot);
    expect(brief).toContain("source: fixture");
    expect(brief).toContain("qa_standby: true");
    expect(brief).toContain("no_autonomous_goal_loop: true");
    expect(brief).toContain("respond_only_to_explicit_messages: true");
  });
});
