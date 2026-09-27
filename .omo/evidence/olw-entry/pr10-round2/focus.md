# PR #10 Round 2: interrupted focus (discussion_r4115327096)

Base: 9e36593. Existing-manager host checks, snapshots, verification and focus
awaits now race the here-mode interruption. The stored failure is checked before
focus, after verification and before success returns, including the outer manage
boundary. Focus-only entries retain no-child signal behavior: no TUI is launched
or killed. Existing claimed verification paths still release their owned claim
on interruption; ordinary plain-manage behavior is unchanged.

RED: focus-red.log has four failures: host/snapshot/verification waits failed to
return before their bounded deadline, and interruption during focus completion
returned exit 0. GREEN: focus-green.log and targeted-green.log. Three additive
regressions send OS SIGTERM to the running test process while the selected
existing-manager await is held. CLI returns manager_interrupted/143 before the
await is released, with no focus, zero new launches and unchanged binding. Each
then releases its exact signal and verifies ordinary focus still succeeds.
A fourth case emits SIGTERM while the focus RPC completes and proves success
cannot leak through. All waits are event-driven with bounded deadlines.

Final validation: 617 tests pass / 0 fail in one full run; typecheck/lint/build
exit 0, official entry real-host QA PASS with cleanup. Test LSP clean. Fresh
orchestrator LSP refresh after formatting timed out; final full tsc passed.
Accepted late native-notice limitation is unchanged. No push, native dependency
patch, live-server access or GitHub posting was performed.
