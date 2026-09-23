# Final repair verification

## Final gate after all lifecycle repairs

Monitor `mon_MSXNGB8HAZ15BQF5` / `bash_1` completed with exit code 0:

```sh
bun test
bun run typecheck
bun run lint
bun run build
bun run cli status --json
bun run cli -- --help --json
```

- 50 tests passed, 0 failed.
- Strict typecheck and build passed.
- Biome checked 41 files, exit 0. Informational `useLiteralKeys` suggestions
  remain because TypeScript requires bracket access for index-signature fields.
- Source-directory LSP: 20 files, 0 errors.
- Status returned `{"ok":true,"value":[]}`.
- Help returned the command inventory including `close` and `reconcile`.
- Final formatting was checked by comparing TypeScript syntax trees, excluding
  source-file text and redundant parentheses; no behavior changed.

## Repairs of the first verification DAG findings

The earlier `final-delivery-review.md` and `final-lifecycle-review.md` were
correctly BLOCKED at their original revision. The following fixes followed
failing regressions, recorded in the work journal:

1. Bound direct native sends are blocked. A one-use AsyncLocalStorage permit
   allows only the already-claimed RPC dispatch through the actual tool hook.
2. Creation requires `DeliveryRecord.state === "accepted"`, not merely `ok`.
3. `close` verifies exact workspace/native identity, preserves checkout data,
   and releases ownership only after observed closure. Children close first.
4. Runtime activation enters `initializing`. The immutable initial instruction
   has a durable claim; acceptance alone promotes the binding to `ready`.
   Lost ACK recovery consults the exact user message or delivery ledger and
   never blindly resends an uncertain instruction.
5. Reconcile checks ready owners too. Missing native/workspace identities become
   uncertain without launching replacements; healthy roles remain ready.

## Latest real-surface run before whitespace-only formatting

The monitor titled
`이미 사라진 세션을 재생성하지 않는 유실 QA 재검증`
completed exit 0. Its isolated world was `qa-world-8bAiOR`.

```text
ROLE_PASS supervisor openai-codex/gpt-6-astra/high w2
ROLE_PASS parent kimi-coding/k3/max w3
ROLE_PASS child claude-sdk-oauth/claude-opus-5/xhigh w4
EVENT_PASS qa-child-report CHILD_REPORT_RECEIVED
EVENT_PASS qa-parent-report PARENT_REPORT_RECEIVED
EVENTS_QA_PASS: idle owners woke through native events; duplicate reports did not resend
RECONCILE_QA_PASS: lost runtime became uncertain; healthy roles retained; no relaunch
CLOSE_QA_PASS: exact native sessions and workspaces closed; worktree data preserved
CLEANUP: QA worktrees, workspaces, Herdr server, OMO host and fixture removed
LINEAR_QA_PASS: three real MCP read calls and four loaded ported skills
LIVE_LINEAR: not contacted; this was an explicit local MCP fixture
CLEANUP: QA RPC process 461009 exited
CLEANUP: local MCP server stopped and isolated agent directory removed
```

These sentinels establish routing, idle wake, and receipt behavior, not the
quality of autonomous task execution. Live Linear OAuth and live writes remain
outside QA. The real OMO MCP wire fixture and exact role providers were used.

## Runtime version mismatch found during independent verification

The independent verification DAG resolved both delivery and all three lifecycle
findings, but its final `qa:herdr` failed before supervisor readiness. The TUI
reported `Model "openai-codex/gpt-6-astra" not found`.

Direct inspection showed global OMO had changed to beta.84 / Senpi 2026.9.22-4
while this repository still pins beta.82 / Senpi 2026.9.22. Running both actual
CLI model listings showed `chatgpt-subscription/gpt-6-astra` in the former and
`openai-codex/gpt-6-astra` in the latter. The interactive Herdr shell resolved
the global executable, mixing runtime versions.

A startup regression requiring the control root's `node_modules/.bin/omo`
failed in all three cases (monitor `mon_5YCP608SSSN2CZ17`, exit 1).
Host launch, TUI launch, doctor, and QA host teardown now use that pinned local
executable. Requested role providers and models are unchanged.
The global update had also migrated credentials away from the old provider keys.
After the user's response, the actual models/thinking were retained while provider
names and the local pinned OMO were updated to beta.84 / Senpi 2026.9.22-4.
The full suite passed 50/50, and all three real QA commands passed.
See [final-runtime.md](final-runtime.md) for the definitive current results.
