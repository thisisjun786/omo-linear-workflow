# PR #10 comments 1, 2 and 5: foreground lifecycle and context

RED: lifecycle-red.log has seven failures covering stale-age live-owner takeover,
displaced TUI termination, SIGINT/SIGTERM/SIGHUP during ensureHost, and dead
reserved/provisioning owners. context-red.log reproduces both a different server
with matching pane ID and a pane without the calling process. GREEN: manager
suite and targeted-green.log; all prior lease, process-generation and signal
regressions remain in place.

Bare-entry liveness now dominates lease age while its recorded process exists
with the same starttime. Released claims remain immediately reclaimable and
legacy unknown-owner leases retain their fallback. Before terminating its TUI,
the wrapper checks token, pane/workspace, and settled/pending state. A displaced
entry cannot kill the adopted manager.

Signal handlers are registered before manager reservation. A startup claim with
PID/starttime/token is inserted in the same transaction as manager reserve,
including separate-workspace manager creation. Host startup races interruption;
subsequent pre-launch steps check the interruption and ownership before launch.
Unstarted reservations settle through a token-fenced close. Bare entry can
claim dead reserved/provisioning startup, but refuses cleanup if a TUI or exact
native session remains live or absence cannot be established. Owned abandoned
workspaces are checked before removal; the current user's workspace is excluded.

Here-mode requires normalized effective socket equality with HERDR_SOCKET_PATH,
a matching snapshot pane, and official pane.process_info confirming the actual
caller PID among that pane's foreground processes. No focused-pane inference.
Tests cover matching pane IDs on different servers and a wrong caller process;
a socket-contract test validates pane.process_info parsing and requested ID.

Final combined candidate: full-test.log 604 pass / 0 fail, typecheck/lint/build
exit 0, changed-file diagnostics clean. Entry real-host QA PASS with real process
identity, SIGTERM recovery, same-session reattachment and busy notices. Receipt
qa-manager-entry.json includes daemon exits and temporary-world cleanup.
The accepted late native acceptance race is unchanged and remains documented.
