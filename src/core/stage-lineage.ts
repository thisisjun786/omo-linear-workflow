import type { Database } from "bun:sqlite";
import type { ChildStage, StageHandoff, StageRecord } from "./contracts";

interface StageRow {
  readonly binding_id: string;
  readonly issue_id: string;
  readonly stage: ChildStage;
  readonly ordinal: number;
  readonly previous_binding_id: string | null;
  readonly handoff_json: string | null;
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
  }
  const available =
    db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'stage_lineage'")
      .get() !== null;
  const parse = (row: StageRow): StageRecord => ({
    bindingId: row.binding_id,
    issueId: row.issue_id,
    stage: row.stage,
    ordinal: row.ordinal,
    previousBindingId: row.previous_binding_id,
    handoff: row.handoff_json === null ? null : (JSON.parse(row.handoff_json) as StageHandoff),
  });
  return {
    get(bindingId: string): StageRecord | null {
      if (!available) return null;
      const row = db
        .query<StageRow, [string]>("SELECT * FROM stage_lineage WHERE binding_id = ?")
        .get(bindingId);
      return row === null ? null : parse(row);
    },
    chain(issueId: string): StageRecord[] {
      if (!available) return [];
      return db
        .query<StageRow, [string]>(
          "SELECT * FROM stage_lineage WHERE issue_id = ? ORDER BY ordinal, binding_id",
        )
        .all(issueId)
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
    insert(
      bindingId: string,
      issueId: string,
      stage: ChildStage,
      ordinal: number,
      previousBindingId: string | null,
    ): void {
      db.query(
        "INSERT INTO stage_lineage (binding_id, issue_id, stage, ordinal, previous_binding_id) VALUES (?, ?, ?, ?, ?)",
      ).run(bindingId, issueId, stage, ordinal, previousBindingId);
    },
    handoff(bindingId: string, value: StageHandoff): void {
      db.query("UPDATE stage_lineage SET handoff_json = ? WHERE binding_id = ?").run(
        JSON.stringify(value),
        bindingId,
      );
    },
  };
}
