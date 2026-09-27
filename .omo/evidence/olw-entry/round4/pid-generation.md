# R2-E3-PID process-generation fencing

A nullable owner_starttime TEXT column is added alongside owner_pid. New claims
read Linux /proc/<pid>/stat field 22, preserving the decimal starttime as text.
The parser uses the last closing parenthesis to tolerate spaces/parentheses in
comm (field 2), and validates the field at the OS boundary with Zod. Missing
processes are absent; unexpected read/parse errors surface through the existing
transaction error path rather than granting takeover.

When starttime is known, the PID must still exist and have the same starttime.
A mismatch permits takeover via the existing BEGIN IMMEDIATE/CAS/token path.
Legacy rows migrate with NULL and keep their existing PID-only liveness check.
Read-only registry opening does not migrate. New tokens fence prior ownership,
pane mutation and claim completion as before.

RED: pid-red.log, 0 pass / 2 fail: new column absent and legacy migration missing.
GREEN: pid-green.log, manager suite 27 pass / 0 fail. Additive regressions use real
SQLite and real unrelated live processes (held by open stdin, no sleep/polling).
One verifies stored field 22, matching generation => manager_busy/3, changed
stored generation => bare entry succeeds while the unrelated process is alive,
and old-token owns/move/finish all fail. Another recreates the prior schema,
verifies read-only behavior and NULL migration, retains pid-only busy for a live
legacy owner, and permits takeover after its exact child exit with a fresh
starttime. All child processes are reaped in finally.

Final combined verification:
- bun test: 592 pass, 0 fail, 3064 expectations, 65 files (single final run).
- bun run typecheck: exit 0.
- bun run lint: exit 0; 267 informational diagnostics retained.
- bun run build: exit 0.
- bun scripts/qa-official-herdr.ts --entry: PASS, including wrapper SIGTERM
  recovery, same durable session/pane movement and busy-notice admission.
- qa-manager-entry.json records daemon exits, tempFilesRemoved and scratchRemoved.
- Initial store LSP and final changed-test LSP clean. Fresh store diagnostics
  after formatting timed out; final full tsc --noEmit passed.

No native dependency edits, pushes, PRs, Linear writes or live-server changes.
The accepted R2-E2-LATE residual is documented separately, not claimed fixed.
