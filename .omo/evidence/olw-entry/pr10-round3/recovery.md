# PR #10 Round 3: interrupted startup recovery

Comment: discussion_r4115417624. Base: 7a3a7b5.

Dead-owner recovery now races its Herdr snapshot, native attach/detach, and
workspace-close operation with here.interruption. It checks recorded interruption
before claiming, after observations, before workspace close, and before the
transactional binding close. Token-fenced release remains in finally; the Herdr
client closes even if registry cleanup throws. A late native attachment detaches
without blocking the interrupted foreground entry; detach failures are reported.
An already-issued workspace-close RPC cannot be undone, but interruption prevents
subsequent binding closure or replacement launch.

RED: recovery-red.log records four bounded-deadline failures before the source
change. GREEN: recovery-green.log records all four interruption cases plus both
existing reserved/provisioning recovery cases passing. Additive real-SQLite tests
send OS SIGTERM while snapshot, attach, detach, or workspace-close is held. They
require CLI manager_interrupted/143 and released claim before releasing the held
operation, no additional launch, unchanged binding, preserved caller workspace,
and eventual detach for late native attachments. No sleeps or polling are used.

Combined final validation: one full bun test run, 623 pass / 0 fail, 3254
expectations across 65 files. Typecheck, lint, release check and build exit 0.
Lint retains 328 informational diagnostics. Official entry real-host QA PASS:
real Herdr/TUI/host/native delivery, isolated HOME and server, deterministic
inference only. qa-manager-entry.json retains signal, notice and cleanup receipts;
QA reported worktrees/workspaces/server/host/fixture removed and both daemon
exit receipts are true. Scratch and world paths were checked absent afterward.

Final LSP checks were clean for orchestrator, contracts, schema and both changed
tests. Initial store/runtime checks were clean; fresh post-format checks timed
out. Final full tsc --noEmit passed. An interim test literal-widening type error
was corrected by annotating the fixture Binding; its original output is retained.

Raw logs and QA receipt are copied to
/home/jun/code/omo-linear-workflow/.omo/evidence/olw-entry/pr10-round3/.
No push, GitHub replies, Linear writes, user-server access or user OMO config
edits. The accepted native late-acceptance notice limitation is unchanged.
