# Gate E1/E3 foreground lifecycle corrections

Base rejected by gate: 3b1081c. Branch: feat/olw-entry.

E1 RED: e1-red.log, real Bun child exits 37 before publishing readiness; the
bounded 3-second observation failed on the old timeout-only path. GREEN:
e1-green.log and targeted-green.log. CLI now races readiness against process
exit, reads an atomic receipt once to disambiguate a queued filesystem event,
returns manager_tui_exited with the actual child status, and closes a proven
failed new reservation after terminating any exact host session. Next entry
creates normally. A separate after-readiness regression preserves exit 37.

E3 RED: e3-red.log, live-owner entry returned 0 instead of manager_busy. The
original signal reproduction terminated the test runner with SIGINT because
there was no installed handler; additive signal tests now keep a no-op observer
so RED cannot kill the runner. GREEN: native-signal-green.log and final suite.
SIGINT/SIGTERM/SIGHUP are forwarded to actual test child processes while native
verification is held. The wrapper races interruption with that held operation,
awaits child exit and releases its token before returning. A dead child PID in
the real SQLite claim is reclaimable immediately; a live PID yields manager_busy
exit 3 for bare entry. Existing lease/CAS tests remain and pass.

Claims now persist owner_pid with an additive SQLite migration. Reclamation uses
an authoritative dead-process check, not absence of an agent during legitimate
startup. This chooses the user's dead-PID alternative: stealing from a live
owner before its TUI appears would allow a second concurrent launch. Existing
plain-manage in-progress semantics remain unchanged.

Real official-Herdr entry QA was extended: after the replacement TUI becomes
visible, establish wrapper ownership via /proc cmdline, SIGTERM that wrapper,
await its shell exit marker and agent release, and invoke bare olw in the other
pane. The same binding/session reattaches without waiting for the lease.
qa-manager-entry.json records wrapperExit 143 and recovery to w1:p1, plus cleanup.
Existing qa-manager-reattach.json also records PASS and complete cleanup.

E4 help changes were explicitly approved and left intact. No user server, user
OMO configuration, Linear objects, pushes or PRs were touched.
