# Lead integration evidence

## Captured results

- `bun test`: 48 passed, 0 failed, 190 assertions (monitor `bash_72`).
- `bun run typecheck`: exit 0, strict settings retained.
- `bun run lint`: exit 0; 0 errors/warnings, 27 informational
  `useLiteralKeys` suggestions conflict with required TypeScript index access.
- `bun run build`: exit 0; CLI, worker and Node-compatible extension built.
- `bun run cli -- --help --json`: exit 0, valid command inventory.
- LSP `src/`: 20 files scanned, 0 errors. Individual post-patch LSP requests
  sometimes timed out; the final directory scan and compiler both succeeded.

## Actual native hierarchy and messaging

`bun run qa:events` completed exit 0 (`bash_66`) using installed Herdr 0.9.1.

- Supervisor: `openai-codex/gpt-6-astra`, `high`, workspace w2.
- Parent: `kimi-coding/k3`, `max`, worktree workspace w3.
- Child: `claude-sdk-oauth/claude-opus-5`, `xhigh`, worktree workspace w4.
- Exact native identity, separate checkouts, child ancestry, stable focus, and
  duplicate-owner rejection passed.
- `qa-child-report` woke the idle parent and produced `CHILD_REPORT_RECEIVED`.
- `qa-parent-report` woke the idle supervisor and produced `PARENT_REPORT_RECEIVED`.
- Reissuing each report from a fresh CLI process did not add another delivery.
- The QA world removed its worktrees, workspaces, named Herdr server, native
  host and fixture. No user server/workspace was stopped.
- Later SQLite-only context recovery, reconcile and help changes passed the
  full suite above; final independent runtime verification uses the latest build.

## Corrections proven RED to GREEN

- Empty native sessions changed UUID when reopened; public SessionManager
  metadata is now seeded before launching the exact native session file.
- The shared host selected its default model despite CLI arguments; role
  configuration now uses public per-session RPC before activation, and the
  extension reads current context getters instead of frozen model values.
- Git rejects an existing `foo` branch plus `foo/bar`; parent and child refs
  now use sibling project/issue namespaces with the parent commit as child base.
- Herdr ignores unrecognized session-report source contracts. A TUI lifecycle
  receipt plus native filesystem subscription replaces that unsupported
  readiness path. No polling or custom inter-session delivery system was added.
- Ready receipts published before or after subscription pass; wrong checkout
  identity is rejected. A Bun assertion originally blocked before the trigger;
  the test now subscribes to the promise outcome before publishing.
- Scope/designation lookup now uses canonical SQLite records; restarting after
  removal of the redundant JSON sidecar still permits authorized creation.
- Reconcile recovers an existing uncertain launch from its bound readiness
  receipt without creating another workspace.
- CLI help failed with exit 2, then passed without creating runtime state.

## Remaining external scope

Live Linear OAuth and writes were not performed. The real MCP protocol was
verified against a local fixture; see `linear-runtime.md`.
Herdr 0.9.1 OMO detection port and installation are a separately authorized
follow-up after this repository is finished.
