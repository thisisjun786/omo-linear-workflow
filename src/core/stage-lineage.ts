import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { ChildStage, StageHandoff, StageRecord } from "./contracts";

const stageHandoffSchema = z.strictObject({
  planPath: z.string().min(1),
  planSha256: z.string().regex(/^[a-f0-9]{64}$/),
  head: z.string().min(1),
  completedAt: z.string().min(1),
});

export class StageHandoffStorageError extends Error {
  readonly details: unknown;

  constructor(details: unknown) {
    super("Stored stage handoff is invalid");
    this.name = "StageHandoffStorageError";
    this.details = details;
  }
}

interface StageRow {
  readonly binding_id: string;
  readonly issue_id: string;
  readonly stage: ChildStage;
  readonly ordinal: number;
  readonly previous_binding_id: string | null;
  readonly handoff_json: string | null;
  readonly generation?: number | null;
}

// Writes are made inside the registry's IMMEDIATE transaction.
export function createStageLineage(db: Database, readonly: boolean) {
  if (!readonly) {
    db.run(`CREATE TABLE IF NOT EXISTS stage_lineage (
      binding_id TEXT PRIMARY KEY REFERENCES bindings(id),
      issue_id TEXT NOT NULL,
      stage TEXT NOT NULL CHECK(stage IN ('direct','plan','execute','research')),
      ordinal INTEGER NOT NULL,
      previous_binding_id TEXT REFERENCES bindings(id),
      handoff_json TEXT
    )`);
    const columns = db.query<{ name: string }, []>("PRAGMA table_info(stage_lineage)").all();
    if (!columns.some((column) => column.name === "generation"))
      db.run("ALTER TABLE stage_lineage ADD COLUMN generation INTEGER NOT NULL DEFAULT 0");
  }
  const available =
    db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'stage_lineage'")
      .get() !== null;
  const hasGeneration =
    available &&
    db
      .query<{ name: string }, []>("PRAGMA table_info(stage_lineage)")
      .all()
      .some((column) => column.name === "generation");
  const generationOfRow = (row: StageRow): number => (hasGeneration ? (row.generation ?? 0) : 0);
  const parseHandoff = (value: string): StageHandoff => {
    let decoded: unknown;
    try {
      decoded = JSON.parse(value);
    } catch (cause) {
      throw new StageHandoffStorageError(cause instanceof Error ? cause.message : String(cause));
    }
    const parsed = stageHandoffSchema.safeParse(decoded);
    if (!parsed.success) throw new StageHandoffStorageError(parsed.error.issues);
    return parsed.data;
  };
  const parse = (row: StageRow): StageRecord => ({
    bindingId: row.binding_id,
    issueId: row.issue_id,
    stage: row.stage,
    ordinal: row.ordinal,
    previousBindingId: row.previous_binding_id,
    handoff: row.handoff_json === null ? null : parseHandoff(row.handoff_json),
  });
  return {
    get(bindingId: string): StageRecord | null {
      if (!available) return null;
      const row = db
        .query<StageRow, [string]>("SELECT * FROM stage_lineage WHERE binding_id = ?")
        .get(bindingId);
      return row === null ? null : parse(row);
    },
    rows(issueId: string): StageRow[] {
      if (!available) return [];
      return db
        .query<StageRow, [string]>("SELECT * FROM stage_lineage WHERE issue_id = ? ORDER BY rowid")
        .all(issueId);
    },
    chain(issueId: string): StageRecord[] {
      const rows = this.rows(issueId);
      const latest = rows.filter((row) => row.previous_binding_id === null).at(-1);
      if (latest === undefined) return [];
      const generation = generationOfRow(latest);
      return rows
        .filter((row) => generationOfRow(row) === generation)
        .sort(
          (left, right) =>
            left.ordinal - right.ordinal || left.binding_id.localeCompare(right.binding_id),
        )
        .map(parse);
    },
    generationOf(bindingId: string): StageRecord[] {
      if (!available) return [];
      const row = db
        .query<StageRow, [string]>("SELECT * FROM stage_lineage WHERE binding_id = ?")
        .get(bindingId);
      if (row === null) return [];
      if (!hasGeneration) {
        return db
          .query<StageRow, [string]>(
            "SELECT * FROM stage_lineage WHERE issue_id = ? ORDER BY ordinal, binding_id",
          )
          .all(row.issue_id)
          .map(parse);
      }
      return db
        .query<StageRow, [string, number]>(
          "SELECT * FROM stage_lineage WHERE issue_id = ? AND generation = ? ORDER BY ordinal, binding_id",
        )
        .all(row.issue_id, row.generation ?? 0)
        .map(parse);
    },
    successor(bindingId: string): string | null {
      if (!available) return null;
      return (
        db
          .query<{ binding_id: string }, [string]>(
            "SELECT binding_id FROM stage_lineage WHERE previous_binding_id = ? LIMIT 1",
          )
          .get(bindingId)?.binding_id ?? null
      );
    },
    nextGeneration(issueId: string): number {
      const latest = this.rows(issueId)
        .filter((row) => row.previous_binding_id === null)
        .at(-1);
      return (latest?.generation ?? -1) + 1;
    },
    generationNumber(bindingId: string): number {
      if (!available || !hasGeneration) return 0;
      return (
        db
          .query<{ generation: number | null }, [string]>(
            "SELECT generation FROM stage_lineage WHERE binding_id = ?",
          )
          .get(bindingId)?.generation ?? 0
      );
    },
    insert(
      bindingId: string,
      issueId: string,
      stage: ChildStage,
      ordinal: number,
      previousBindingId: string | null,
      generation: number,
    ): void {
      db.query(
        "INSERT INTO stage_lineage (binding_id, issue_id, stage, ordinal, previous_binding_id, generation) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(bindingId, issueId, stage, ordinal, previousBindingId, generation);
    },
    handoff(bindingId: string, value: StageHandoff): void {
      db.query("UPDATE stage_lineage SET handoff_json = ? WHERE binding_id = ?").run(
        JSON.stringify(value),
        bindingId,
      );
    },
  };
}
