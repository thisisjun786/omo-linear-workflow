# PR #10 Round 3: avoid post-claim manager notice sender lookup

Comment: discussion_r4115417675. Base: 7a3a7b5.

ClaimResult and its Zod wire schema now carry optional noticeSender metadata,
populated only for authorized manager report/question routes. The sender snapshot
is read inside claim's existing transaction before any delivery/attempt write.
Runtime formats the notice from that snapshot and carries it in the scoped
native dispatch permit, eliminating both redundant lookup-session calls for this
path. The native tool guard still validates session identity, exact input,
immutable envelope and target, and calls authorize immediately before the final
synchronous manager idle recheck. Direct/non-notice tools retain normal lookup.
No SQLite migration or delivery-key/attempt state-machine changes were needed.

RED: notice-red.log records report and question worker_failed errors from an
injected failing lookup-session worker before the fix. GREEN: notice-green.log
records 22 passing manager-notice/native-delivery tests. Two additive tests keep
that worker failure armed while using real worker processes and real SQLite for
claim, authorize and finish. Both first send and same-ID replay succeed with one
native invocation, original native key, unchanged envelope and one accepted
attempt; zero secondary lookups occur. Final full run also asserts one real
pre-native authorize call (not bypassed by the sender snapshot). Existing retry,
uncertainty, identity, routing and idle regressions remain intact.

Final combined tree: bun test once, 623 pass / 0 fail, 3254 expectations across
65 files. Typecheck, lint (328 informational diagnostics retained), release check
and build exit 0. Official isolated entry QA PASS verifies the real busy-manager
notice plus parent/manager question/answer delivery. qa-manager-entry.json retains
native receipts, entry signal recovery, and daemon/temp cleanup receipts. World
and scratch paths were absent afterward. Initial store/runtime LSP clean; fresh
post-format checks timed out; final full tsc --noEmit passed. Other changed-file
LSP checks clean. Raw evidence is copied to
/home/jun/code/omo-linear-workflow/.omo/evidence/olw-entry/pr10-round3/.

Comment discussion_r4115417719 is informational: the accepted gap between final
idle check and native acceptance remains documented and unchanged. No dependency
patch or atomic native idle-only primitive was added. No push, GitHub reply,
Linear write, live user server access or user OMO configuration edits.
