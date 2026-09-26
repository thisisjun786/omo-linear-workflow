import type { Assignment, Ref, ScopeSnapshot } from "../core/contracts";

const MAX_NAME = 56;

function slugWords(ref: Ref | undefined, kind: "initiative" | "project" | "issue"): string | null {
  if (ref === undefined || !URL.canParse(ref.url)) return null;
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
  return words.length > 0 ? words : null;
}

function scopeName(assignment: Assignment, snapshot: ScopeSnapshot): string | null {
  switch (assignment.role) {
    case "supervisor":
      return slugWords(snapshot.initiative ?? undefined, "initiative");
    case "parent":
      return slugWords(
        snapshot.projects.find((entry) => entry.project.id === assignment.projectId)?.project,
        "project",
      );
    case "child":
      return slugWords(
        snapshot.projects
          .flatMap((entry) => entry.issues)
          .find((issue) => issue.id === assignment.issueId),
        "issue",
      );
  }
}

/** Human-readable Herdr workspace and session name; identity stays on stable IDs. */
export function roleLabel(
  assignment: Assignment,
  snapshot: ScopeSnapshot,
  bindingId: string,
): string {
  const suffix = `${assignment.role} · ${bindingId.slice(0, 8)}`;
  const name = scopeName(assignment, snapshot)?.trim();
  if (name === undefined || name.length === 0) return suffix;
  const short = name.length > MAX_NAME ? `${name.slice(0, MAX_NAME - 1).trimEnd()}…` : name;
  return `${short} · ${suffix}`;
}
