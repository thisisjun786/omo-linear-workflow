import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Ref, Result, ScopeSnapshot } from "../core/contracts";
import { scopeSnapshotSchema } from "../core/schema";

function error<T>(code: string, message: string, details?: unknown): Result<T> {
  return { ok: false, error: { code, message, details } };
}

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function digestOf(snapshot: ScopeSnapshot): string {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

function allRefs(snapshot: ScopeSnapshot): Ref[] {
  const refs: Ref[] = [snapshot.initiative, ...snapshot.decisionRefs];
  for (const project of snapshot.projects) {
    refs.push(project.project, ...project.issues);
  }
  return refs;
}

function validateSnapshot(value: ScopeSnapshot): Result<ScopeSnapshot> {
  const seen = new Set<string>();
  for (const ref of allRefs(value)) {
    if (ref.revision.trim().length === 0) {
      return error("malformed_revision", `Missing or empty revision for ${ref.id}`);
    }
    if (seen.has(ref.id)) {
      return error("duplicate_membership", `Duplicate scope membership ID: ${ref.id}`);
    }
    seen.add(ref.id);
  }
  return ok(value);
}

export async function readScopeSnapshot(path: string): Promise<Result<ScopeSnapshot>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    return error("read_error", cause instanceof Error ? cause.message : String(cause));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    return error("parse_error", cause instanceof Error ? cause.message : String(cause));
  }

  const validated = scopeSnapshotSchema.safeParse(parsed);
  if (!validated.success) {
    return error(
      "schema_violation",
      "Scope snapshot does not match the frozen schema",
      validated.error.issues,
    );
  }

  return validateSnapshot(validated.data);
}
