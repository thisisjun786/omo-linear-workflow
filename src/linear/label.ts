import type { Assignment, Ref, ScopeSnapshot } from "../core/contracts";

const MAX_LABEL = 120;

function slugWords(ref: Ref, kind: "initiative" | "project" | "issue"): string | null {
  if (!URL.canParse(ref.url)) return null;
  const url = new URL(ref.url);
  if (url.hostname !== "linear.app") return null;
  const parts = url.pathname.split("/").filter((part) => part.length > 0);
  const at = parts.indexOf(kind);
  if (at < 0) return null;
  if (kind === "issue") {
    const key = parts[at + 1];
    if (key === undefined) return null;
    const title = parts[at + 2];
    return title === undefined ? key : `${key} ${decodeURIComponent(title).replaceAll("-", " ")}`;
  }
  const slug = parts[at + 1];
  if (slug === undefined) return null;
  // Linear appends a 12-hex-digit ID to project and initiative slugs.
  const words = decodeURIComponent(slug)
    .replace(/-[0-9a-f]{12}$/, "")
    .replaceAll("-", " ");
  if (words.length === 0) return null;
  return ref.key === undefined ? words : `${ref.key} ${words}`;
}

function scopeName(assignment: Assignment, snapshot: ScopeSnapshot): string | null {
  switch (assignment.role) {
    case "supervisor":
      return snapshot.initiative === null ? null : slugWords(snapshot.initiative, "initiative");
    case "parent": {
      const entry = snapshot.projects.find((item) => item.project.id === assignment.projectId);
      return entry === undefined ? null : slugWords(entry.project, "project");
    }
    case "child": {
      const issue = snapshot.projects
        .flatMap((item) => item.issues)
        .find((item) => item.id === assignment.issueId);
      return issue === undefined ? null : slugWords(issue, "issue");
    }
  }
}

/** Human-readable Herdr workspace and session name; identity stays on stable IDs. */
export function roleLabel(
  assignment: Assignment,
  snapshot: ScopeSnapshot,
  bindingId: string,
): string {
  const name = scopeName(assignment, snapshot)?.trim();
  if (name === undefined || name.length === 0) return `${assignment.role} ${bindingId.slice(0, 8)}`;
  return name.length > MAX_LABEL ? `${name.slice(0, MAX_LABEL - 1).trimEnd()}…` : name;
}
