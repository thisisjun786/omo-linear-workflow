import { expect, test } from "bun:test";
import type { Assignment, ScopeSnapshot } from "../src/core/contracts";
import { roleLabel } from "../src/linear";

const snapshot: ScopeSnapshot = {
  version: 1,
  source: "linear-export",
  initiative: {
    id: "init-uuid",
    url: "https://linear.app/acme/initiative/q4-billing-overhaul-0a1b2c3d4e5f",
    revision: "r1",
    key: "I-13",
  },
  projects: [
    {
      project: {
        id: "project-uuid",
        url: "https://linear.app/acme/project/tally-cli-%EA%B0%80%EA%B3%84%EB%B6%80-5da532c1a443",
        revision: "r1",
        key: "P-JUN-68",
      },
      issues: [
        {
          id: "issue-uuid",
          url: "https://linear.app/acme/issue/JUN-274/tally-add-and-tally-list-commands",
          revision: "r1",
        },
      ],
    },
  ],
  decisionRefs: [],
};
const parent: Assignment = {
  role: "parent",
  initiativeId: null,
  projectId: "project-uuid",
  ownerBindingId: null,
};

test("labels a parent with its decoded project name", () => {
  expect(roleLabel(parent, snapshot, "7c57be9a-3fcb-4376")).toBe("P-JUN-68 tally cli 가계부");
});

test("labels a child with its issue key and title words", () => {
  const child: Assignment = {
    role: "child",
    initiativeId: null,
    projectId: "project-uuid",
    issueId: "issue-uuid",
    ownerBindingId: "p",
  };
  expect(roleLabel(child, snapshot, "8e6883c7-8e7d")).toBe(
    "JUN-274 tally add and tally list commands",
  );
});

test("labels a supervisor with its initiative name", () => {
  expect(
    roleLabel({ role: "supervisor", initiativeId: "init-uuid" }, snapshot, "aaaaaaaa-bbbb"),
  ).toBe("I-13 q4 billing overhaul");
});

test("uses the slug alone when a project ref has no key", () => {
  const unkeyed: ScopeSnapshot = {
    ...snapshot,
    projects: [
      {
        project: {
          id: "project-uuid",
          url: "https://linear.app/acme/project/tally-cli-5da532c1a443",
          revision: "r1",
        },
        issues: [],
      },
    ],
  };
  expect(roleLabel(parent, unkeyed, "12345678-9abc")).toBe("tally cli");
});

test("falls back to the role and short binding ID for non-Linear refs", () => {
  const fixture: ScopeSnapshot = {
    ...snapshot,
    projects: [
      { project: { id: "project-uuid", url: "linear://project", revision: "r1" }, issues: [] },
    ],
  };
  expect(roleLabel(parent, fixture, "12345678-9abc")).toBe("parent 12345678");
});

test("truncates long names", () => {
  const long: ScopeSnapshot = {
    ...snapshot,
    projects: [
      {
        project: {
          id: "project-uuid",
          url: `https://linear.app/acme/project/${"word-".repeat(30)}5da532c1a443`,
          revision: "r1",
        },
        issues: [],
      },
    ],
  };
  const label = roleLabel(parent, long, "12345678-9abc");
  expect(label.endsWith("…")).toBe(true);
  expect(label.length).toBe(120);
  expect(roleLabel(parent, snapshot, "x")).not.toContain("…");
});
