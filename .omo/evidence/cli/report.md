# CLI integration evidence

## Delivered

- CLI commands: doctor, scope import, supervisor/parent/child create, send, report, status, pause, resume, reconcile.
- Explicit `--root`, `--herdr-socket`, `--json`, and fixture gates.
- Mode-0600 contained native host profile and externalized Bun/Node builds.
- Subscribe-before-create role startup, persisted Herdr IDs, event-driven session observation, native tuple verification, activation, then brief delivery.
- Original-root worktree creation with explicit parent branch base and post-create HEAD verification.

## TDD

- `red.txt`: declared boundary stubs failed behavior assertions (exit 1).
- `green-initial.txt`: profile/event decoder assertions passed (exit 0).
- `green.txt`: integration, typecheck, build, built status, and side-effect-free doctor passed.
- `full-test.txt`: 40 tests passed, 0 failed.
- `lint.txt`: owned and repository Biome checks exited 0 (informational literal-key diagnostics remain due strict index access).
- `cleanup.txt`: fixture roots removed; no native host, Herdr workspace, model, or Linear object was started.

## Upstream mismatch

The frozen `Registry` API has no designation lookup and no delivery listing, while `NativeSession` has no transcript read. The orchestrator therefore persists the immutable designation alongside each binding in `.omo/state/orchestrator.json`. `reconcile` performs one Herdr snapshot and repairs provisioning identities, but cannot discover/reconcile uncertain delivery records through the frozen public producer APIs. Lead integration must either add read-only `designation(bindingId)`, `deliveries(initiativeId/state)`, and transcript observation APIs or retain this bounded limitation.

## Remaining real QA

Run the lead-owned composed QA against an owned Git fixture/current Herdr server: create all three exact-model roles, inspect worktree ancestry and host-loaded skills, verify native idle wakes and replay/conflict semantics, run negative routes/model/socket/paused cases, then remove only ledger-owned child/parent worktrees, workspaces, and host.

## Post-producer Herdr disconnect fix

The readiness subscription now recognizes the adapter's `{event:"connection.error",data:{code,message}}` event before pane/snapshot handling. It rejects the armed startup promise immediately with the upstream code and message, marks the reserved launch uncertain, and does not attach or prompt. Evidence: `disconnect-red.txt`, `disconnect-green.txt`, and `disconnect-verification.txt` (41 tests passed).
