import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
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

function fixtureSnapshot(): ScopeSnapshot & {
  readonly initiative: NonNullable<ScopeSnapshot["initiative"]>;
} {
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
    expect(snapshot.initiative?.id).toBe("initiative-omo-1");
    expect(snapshot.projects).toHaveLength(1);
    expect(snapshot.projects[0]?.project.id).toBe("project-omo-1");
    expect(snapshot.projects[0]?.issues.map((issue) => issue.id)).toEqual([
      "issue-omo-1",
      "issue-omo-2",
    ]);
  });

  test("imports a project-only snapshot with explicit null initiative", async () => {
    const snapshot: ScopeSnapshot = { ...fixtureSnapshot(), initiative: null };
    const file = await tempFile("project-only.json", JSON.stringify(snapshot));
    expect(value(await readScopeSnapshot(file))).toEqual(snapshot);
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

  test("standalone parent brief exposes its approved issues and user contact without an initiative", () => {
    const binding = makeBinding("parent", {
      assignment: {
        role: "parent",
        projectId: "project-omo-1",
        initiativeId: null,
        ownerBindingId: null,
      },
    });
    const parsed: unknown = Bun.YAML.parse(
      buildRoleBrief(binding, { ...snapshot, initiative: null }),
    );
    expect(parsed).toMatchObject({
      scope_refs: {
        initiative_id: null,
        project_id: "project-omo-1",
        issue_ids: ["issue-omo-1", "issue-omo-2"],
      },
      initial_manager_binding_id: null,
      user_contact: "direct_prompt_in_this_session",
      user_report_state: "posted_not_native_acceptance",
      behavior: {
        no_autonomous_goal_loop: true,
        wait_for_explicit_instruction: true,
        report_route: "current_manager_or_user_inbox",
        management_link_changes_approval: false,
      },
    });
  });

  test("child brief embeds project and issue scope refs", () => {
    const binding = makeBinding("child");
    const brief = buildRoleBrief(binding, snapshot);
    expect(brief).toContain("role: child");
    expect(brief).toContain("project_id: project-omo-1");
    expect(brief).toContain("issue_id: issue-omo-1");
  });

  test.each(["fixture", "linear-export"] as const)(
    "child selects packet-bound workflow execution for %s scope",
    (source) => {
      const brief = buildRoleBrief(makeBinding("child"), { ...snapshot, source });
      const parsed = z.record(z.string(), z.unknown()).parse(Bun.YAML.parse(brief));
      expect(parsed).toMatchObject({
        role: "child",
        scope_refs: { issue_id: "issue-omo-1" },
        behavior: {
          execution_mode: "mass-ulw",
          execution_trigger: "explicit_issue_packet",
          execution_skills: ["olw-run", "mass-ulw"],
          internal_workers: "native_workflow_nodes_not_roles",
          issue_goal: "packet_bound",
          verify_artifacts_before_report: true,
          wait_for_explicit_instruction: true,
        },
      });
      const behavior = z.record(z.string(), z.unknown()).parse(parsed["behavior"]);
      expect(behavior["no_autonomous_goal_loop"]).toBeUndefined();
      if (source === "fixture") {
        expect(parsed).toMatchObject({
          qa_standby: true,
          respond_only_to_explicit_messages: true,
          never_fetch_live_linear: true,
          never_create_additional_olw_roles: true,
          never_implement_repository_work_autonomously: true,
        });
        expect(parsed["never_create_additional_sessions"]).toBeUndefined();
      } else {
        expect(parsed["qa_standby"]).toBeUndefined();
      }
    },
  );

  test.each(["parent", "supervisor"] as const)(
    "%s retains event-driven coordination without an issue workflow",
    (role) => {
      const brief = buildRoleBrief(makeBinding(role), snapshot);
      const parsed = z
        .object({ behavior: z.record(z.string(), z.unknown()) })
        .parse(Bun.YAML.parse(brief.slice(brief.indexOf("behavior:"))));
      expect(parsed.behavior["no_autonomous_goal_loop"]).toBe(true);
      expect(parsed.behavior["wait_for_explicit_instruction"]).toBe(true);
      expect(parsed.behavior["execution_mode"]).toBeUndefined();
      expect(parsed.behavior["issue_goal"]).toBeUndefined();
    },
  );

  test("fixture brief instructs qa standby without autonomous loops", () => {
    const binding = makeBinding("supervisor");
    const brief = buildRoleBrief(binding, snapshot);
    expect(brief).toContain("source: fixture");
    expect(brief).toContain("qa_standby: true");
    expect(brief).toContain("no_autonomous_goal_loop: true");
    expect(brief).toContain("respond_only_to_explicit_messages: true");
  });
});
