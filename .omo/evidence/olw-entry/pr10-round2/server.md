# PR #10 Round 2: server identity (discussion_r4115327053)

Base: 9e36593. Here-mode now compares the existing manager's saved herdrSocket
with the effective, already-verified caller socket before recovery, focus or
reattachment. A mismatch returns herdr_server_mismatch (CLI exit 2), names both
sockets, and directs the user to the manager's server or to close it first.
No server migration or binding mutation is attempted.

RED: server-red.log contains two failures: a live manager on A focused from B
(exit 0), and an exited TUI proceeded to the cross-server launch seam (exit 3).
GREEN: server-green.log covers both cases with two independent Herdr fixture
worlds and a shared real SQLite registry. Colliding pane/workspace IDs are
intentional. A SQLite UPDATE trigger confirms zero binding writes after each
rejected here entry. The binding and reattach state remain unchanged; no focus
or launch occurs on B. Subsequent valid A entry focuses/reattaches on A, and
explicit close through the B-configured orchestrator closes only A's recorded
workspace while B's colliding workspace and pane survive.

Final candidate validation: full-test.log 617 pass / 0 fail in one run, 3200
expectations across 65 files. Typecheck, lint and build exit 0. Official entry
real-host QA PASS; qa-manager-entry.json contains complete owned-daemon and
scratch cleanup receipts. Test LSP clean; initial orchestrator LSP clean, fresh
post-format refresh timed out, final full tsc passed. No push or comment posting.
