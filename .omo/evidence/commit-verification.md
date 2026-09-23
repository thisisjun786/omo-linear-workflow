# Integration commit verification

2026-09-23. The user authorized commits for the completed managed Herdr,
CLIProxyAPI, upstream routing and manual-first model policy work. Unrelated
project/skill renames and session-reload RPC changes were kept in the shared
working tree, not reverted or included in these commits.

## Isolated index snapshots

Each increment was exported from the index to an owned temporary directory,
using the pinned dependency installation and a copied, checksum-verified Herdr
artifact. Tests therefore covered exactly the commit's files, not unrelated
uncommitted runtime fixes.

1. Managed Herdr: `6d667e8`.
   - 64 tests passed, 0 failed; typecheck, lint and build passed.
   - Managed executable reported `herdr 0.9.1`.
   - Full 3,538-line text patch reviewed independently; no credentials or binary
     artifact embedded. Manifest SHA256 matched. Reverse applicability against
     the owned prepared source passed without modifying the source or server.
   - Invalid-cache behavior remains fail-closed. Error text and the recovery
     runbook now explain inspecting/quarantining the affected directory before
     rebuilding, rather than suggesting an ineffective repeated build alone.
2. Proxy extension and role policy: `0455cdd`.
   - 84 tests passed, 0 failed; typecheck, lint and build passed.
   - Actual supervisor model read a hidden random file through the snapshot's
     built proxy extension: `PROXY_TOOL_OK`, exit 0.
3. Upstream routing, launcher and manual policy: final index snapshot.
   - 118 tests passed, 0 failed; typecheck, lint, build and frozen offline
     lockfile verification passed. The full shared working tree had 120 tests;
     the two omitted tests belong to the separate uncommitted reload fix.
   - Model-scope QA originally assumed the retired referenced-only policy and
     failed under the user's current all mode. It now validates the selected
     mode without changing it; actual OMO RPC returned `MODEL_SCOPE_LIVE_OK`.
   - First live category/agent QA timed out and exited 143. This was not counted
     as success or hidden. Failure-event recording was added without relaxing
     launch, provider, model or hidden-file completion assertions.
   - The diagnostic run passed unchanged assertions: quick used GPT-6 Luna
     Fast/low, explore used Kimi K2.7 Code HighSpeed/off, both read unseen random
     file contents and delivered actual runtime completion notifications.
     `mon_EHADE9QDMYFSN058` exited 0 with `ROUTING_LIVE_OK`.
   - Final QA diagnostics/typecheck/lint and the shared working build passed
     under `mon_Y43DZDFP4W4WMM0Z`. The first live timeout's precise cause was not
     captured by the old script; no runtime-cause claim is made.

## Scope and integrity

- Conventional Commit history; no push, amend, branch switch or history rewrite.
- No configured Git remote at verification time.
- No ~/.omo configuration, OAuth credential, management/client key, generated
  Herdr binary, runtime database or active-session transcript committed.
- Staged high-confidence secret scan found no candidate secrets. Fixture keys
  in tests are intentional dummy values.
- Git's generic whitespace checker reports the vendored patch's blank context
  lines (a single required diff-prefix space). The patch was not corrupted or
  rehashed to silence that report. Patch-aware applicability passed; ordinary
  staged source/documentation whitespace checks passed.
- Temporary staging-content files initially lacked project dependencies and
  showed contextless LSP errors. Complete exported snapshots had zero source
  diagnostics and passed strict type checking. Those temporary files are not
  source changes and are removed after verification.
- The GPT-6 six-model 500K overrides and live proxy disablement lists remain
  local backed-up runtime configuration, not repository code.
