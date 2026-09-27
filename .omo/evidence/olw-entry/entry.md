# Bare OLW entry evidence

Task: st_01a0e220. Base: origin/dev d589707. Worktree: feat/olw-entry.

Implementation: bare `olw` shares `manage({ here: true })` with `olw manage --here`.
It resolves the caller's explicit Herdr pane via snapshot and spawns the managed OMO
TUI with inherited stdin/stdout/stderr, retaining the foreground CLI until TUI exit.
The existing shared-host durable session, readiness verification, SQLite singleton,
reattachment lease and owner token remain in use. No shell input is injected into
the pane already executing OLW. Current workspace identity is recorded with
`workspaceOwned: false`, so close cannot remove an unrelated user workspace.
Reattachment retains the session's original cwd. Plain manage retains its existing
separate-workspace / new-tab behavior.

RED: entry-red.log: 17 pass, 2 fail; bare CLI returned invalid arguments instead of
herdr_required and failed to create the manager in the caller pane.
GREEN: entry-green.log: 19 pass, 0 fail, including legacy manager leases/fencing.

Real surface: qa-manager-entry.json result PASS, official Herdr 0.9.1 asset SHA-256
2a02fed16beb651ef006e1d43f048f652ca4dc58ad053cd2d44450563d5c54b7.
It types an isolated `olw` launcher in w1:p1, verifies the binding records that same
pane, runs another `olw` in w2:p1 and verifies focus/exit 0 without new panes or
workspaces, quits the first TUI, then attaches the original session in w2:p1.
qa-manager-reattach.json result PASS covers unchanged plain-manage behavior.
Both contain daemon exit and temporary-file cleanup receipts; no live server,
user configuration, or Linear objects were used.

Final combined candidate verification: full-test.log 581 pass / 0 fail; typecheck,
lint (EXIT=0; informational diagnostics retained), build and release:check exit 0.
LSP diagnostics: src, scripts, changed test directories/files clean.
Raw logs and QA JSON are copied to the requested control-root evidence directory;
this summary is committed, runtime registries and caches are not.
