# Gate E2 event-driven manager admission correction

RED: e2-red.log shows follow_up still selected and a busy-after-admission target
not reentering idle admission. e2-preflight-red.log exposes an executeTool throw
after a proven preflight rejection being misclassified as uncertain. Both fixed.
GREEN: e2-green.log and targeted-green.log; all existing receipt/replay tests kept.

Manager reports/questions use the existing subscribed RPC idle observer, then
read the exact target context's synchronous isIdle() in the in-process shared
host. Contexts are indexed by durable identity with cwd/path verification and
removed on session shutdown. After asynchronous worker authorization, the
thread_send guard checks again immediately before allowing native execution.
If busy, it returns to event admission with the remaining budget. The 25-second
total admission budget fits within the native RPC's 30-second response deadline.
The native mode is auto, never follow_up; no native mailbox poll is entered by
the reviewed busy-race path. Parent/child/answer delivery selection is unchanged.

The additive native integration regression extracts the installed patched OMO
thread tools using the existing fixture boundaries. It makes the target busy
during preflight, waits for the exact admission signal, releases it idle, then
executes the real native auto implementation. It asserts one accepted prompt,
one native call after replay and no 50 ms timer. This tests the actual installed
bundle, not a replacement mailbox. The existing lost-ACK tests still pass.

Idle admission failures at either observation or preflight are recorded as
proven turn_conflict_before_delivery, including when executeTool throws after
the guard blocks. Other throws remain uncertain. Same native key is retained
through event readmission; accepted/uncertain delivery is never resent.

Both official-Herdr scenarios pass with real TUI, host, SQLite and thread_send;
only model inference is deterministic. qa-manager-entry.json records the busy
report absent during the held turn and delivered after idle as a one-line
notice plus unchanged envelope. Cleanup receipts are included.

Scope limitation: this follows the requested synchronous OLW preflight check;
it does not introduce a new atomic native mailbox reservation protocol. The
installed native bundle itself was not patched in this correction.
