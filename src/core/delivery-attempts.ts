import type { Database } from "bun:sqlite";
import type { DeliveryAttempt } from "./contracts";
import { deliveryAttemptSchema } from "./schema";

interface AttemptRow {
  readonly attempt_number: number;
  readonly native_key: string;
  readonly state: string;
  readonly receipt_json: string | null;
  readonly uncertain_reason: string | null;
}

// All writes participate in the registry caller's existing IMMEDIATE transaction.
export function createDeliveryAttempts(db: Database, readonly: boolean) {
  if (!readonly) {
    db.run(`CREATE TABLE IF NOT EXISTS delivery_attempts (
      message_id TEXT NOT NULL REFERENCES deliveries(message_id),
      attempt_number INTEGER NOT NULL,
      native_key TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL,
      receipt_json TEXT,
      uncertain_reason TEXT,
      PRIMARY KEY (message_id, attempt_number)
    )`);
  }
  const available =
    db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'delivery_attempts'")
      .get() !== null;
  return {
    list(messageId: string): DeliveryAttempt[] {
      // Old read-only registries have no history table; opening them must not migrate.
      if (!available) return [];
      return db
        .query<AttemptRow, [string]>(
          "SELECT attempt_number, native_key, state, receipt_json, uncertain_reason FROM delivery_attempts WHERE message_id = ? ORDER BY attempt_number",
        )
        .all(messageId)
        .map((row) =>
          deliveryAttemptSchema.parse({
            number: row.attempt_number,
            nativeKey: row.native_key,
            state: row.state,
            receipt: row.receipt_json === null ? null : JSON.parse(row.receipt_json),
            uncertaintyReason: row.uncertain_reason,
          }),
        );
    },
    append(messageId: string, attempt: DeliveryAttempt): void {
      db.query(
        "INSERT INTO delivery_attempts (message_id, attempt_number, native_key, state, receipt_json, uncertain_reason) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        messageId,
        attempt.number,
        attempt.nativeKey,
        attempt.state,
        attempt.receipt === null ? null : JSON.stringify(attempt.receipt),
        attempt.uncertaintyReason,
      );
    },
    settle(messageId: string, attempt: DeliveryAttempt): void {
      db.query(
        "UPDATE delivery_attempts SET state = ?, receipt_json = ?, uncertain_reason = ? WHERE message_id = ? AND attempt_number = ? AND native_key = ?",
      ).run(
        attempt.state,
        attempt.receipt === null ? null : JSON.stringify(attempt.receipt),
        attempt.uncertaintyReason,
        messageId,
        attempt.number,
        attempt.nativeKey,
      );
    },
  };
}
