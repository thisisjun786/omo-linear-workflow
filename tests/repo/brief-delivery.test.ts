import { expect, test } from "bun:test";
import { z } from "zod";
import type { Binding, ChildStage, ScopeSnapshot } from "../../src/core/contracts";
import { buildRoleBrief } from "../../src/linear/brief";

const snapshot: ScopeSnapshot = {
  version: 1,
  source: "fixture",
  initiative: null,
  projects: [
    {
      project: { id: "project", url: "linear://project", revision: "1" },
      issues: [{ id: "issue", key: "QA-1", url: "linear://issue", revision: "1" }],
    },
  ],
  decisionRefs: [],
};
const parent: Binding = {
  id: "parent",
  designationId: "approval",
  durableSessionId: "parent-session",
  assignment: { role: "parent", initiativeId: null, projectId: "project", ownerBindingId: null },
  cwd: "/fixture/parent",
  checkout: {
    kind: "owned-clone",
    originalRepoRoot: "/fixture/parent",
    path: "/fixture/parent",
    branch: "integration",
    baseBranch: "main",
    baseCommit: "base",
  },
  herdrSocket: "/fixture/herdr",
  omoSocket: "/fixture/omo",
  workspaceId: null,
  paneId: null,
  sessionPath: null,
  launchState: "reserved",
  contactState: "active",
  initialization: { state: "pending", text: null },
};
const child: Binding = {
  ...parent,
  id: "child",
  durableSessionId: "child-session",
  assignment: {
    role: "child",
    initiativeId: null,
    projectId: "project",
    issueId: "issue",
    ownerBindingId: parent.id,
  },
  cwd: "/fixture/child",
  checkout: {
    kind: "linked-worktree",
    originalRepoRoot: parent.cwd,
    path: "/fixture/child",
    branch: "issue",
    baseBranch: "integration",
    baseCommit: "base",
  },
};
const parsed = (brief: string) => z.record(z.string(), z.unknown()).parse(Bun.YAML.parse(brief));

test.each(["plan", "execute", "direct", "research"] as const)(
  "owned child %s combines stage and delivery fields",
  (stage: ChildStage) => {
    const brief = parsed(
      buildRoleBrief(child, snapshot, {
        stage,
        owner: { ok: true, value: parent },
        planPath: ".omo/plans/QA-1.md",
        planHead: "plan-sha",
      }),
    );
    expect(brief["stage"]).toBe(stage);
    expect(brief["your_user"]).toBe("parent");
    expect(brief["deliverable"]).toBe(stage === "research" ? "report" : "pr");
    expect(brief["delivery_policy"]).toBeDefined();
    if (stage === "plan" || stage === "execute") {
      expect(brief["plan_path"]).toBe(".omo/plans/QA-1.md");
      expect(brief["plan_head"]).toBe("plan-sha");
    }
    if (stage === "plan" || stage === "research") {
      expect(brief["pr_body"]).toBeUndefined();
      expect(brief["final_report"]).toBeUndefined();
    } else {
      expect(brief["integration_branch"]).toBe(parent.checkout?.branch);
      expect(brief["pr_body"]).toBeDefined();
      expect(brief["final_report"]).toBeDefined();
    }
  },
);

test("explicit document deliverable retains execute handoff metadata without PR fields", () => {
  const brief = parsed(
    buildRoleBrief({ ...child, deliverable: "document" }, snapshot, {
      stage: "execute",
      owner: { ok: true, value: parent },
      planPath: ".omo/plans/QA-1.md",
      planHead: "plan-sha",
    }),
  );
  expect(brief["deliverable"]).toBe("document");
  expect(brief["plan_head"]).toBe("plan-sha");
  expect(brief["pr_body"]).toBeUndefined();
  expect(brief["final_report"]).toBeUndefined();
});

test("owned parent adds integration fields without losing parent guidance", () => {
  const brief = parsed(buildRoleBrief(parent, snapshot, { includeParentGuidance: true }));
  expect(brief["approve_child_plans"]).toBe(true);
  for (const key of [
    "child_modes",
    "answer_child_questions",
    "start_execute_stage",
    "escalate_to",
    "integration_policy",
    "project_finish",
  ])
    expect(brief[key]).toBeDefined();
});

test("legacy parent runtime guidance has local integration but no project PR finish", () => {
  const legacy: Binding = { ...parent, checkout: child.checkout };
  const brief = parsed(buildRoleBrief(legacy, snapshot, { includeParentGuidance: true }));
  expect(brief["approve_child_plans"]).toBe(true);
  expect(brief["integration_policy"]).toBeDefined();
  expect(brief["project_finish"]).toBeUndefined();
});
