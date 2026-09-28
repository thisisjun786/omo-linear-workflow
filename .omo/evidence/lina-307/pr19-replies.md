# PR 19 reply drafts

Drafts only; not posted.

### 1. Settle manager admission failures by delivery phase - discussion_r4120929903

The sender must not return a failed admission while leaving the claimed record in
`sending`. The fix distinguishes failures before the admission RPC was sent from
failures after the receiving isolate may have invoked native delivery. Proven
pre-native refusals are finished as same-ID retryable rejections; lost replies and
ambiguous in-progress/stale attempts remain non-retryable. Receiver and native-key
checks preserve deduplication across the successor attempt. Regression evidence and
the sibling-path audit are recorded under `.omo/evidence/lina-307/round2-*`.

The reply is now a receiver-owned phase union rather than an error-code guess:
`admission_failed` proves no native call, while `delivery_result` preserves possible
delivery. A regression injects a finish-worker failure after native acceptance;
it stays uncertain and cannot retry. `WORKER_ADMISSION_2` requires guarded handoff
from the previous wire generation. Real two-worker QA closes the manager, observes
a rejected report, reopens it, and retries the same ID: two attempts, exactly one
transcript delivery. Cleanup failure after a known reply no longer overwrites that
authoritative result and is reported explicitly.

### 2. Own the native slot before launching the TUI - discussion_r4120930009

Fixed at the launch boundary rather than relying on another occupancy observation.
OLW now performs the actual `open_session` before `herdr.run`/foreground TUI launch
and holds that attachment through launch verification. The TUI attaches the same
seeded path, which does not allocate another worker even at capacity. Native
`open_failed: too_many_sessions` is mapped to `HostCapacityError` before a local
fallback process can exist.

The deterministic regression passes the count guard and then refuses the actual
native admission. The disposable-host QA repeats that exact race: guard passes at
19, a competing real open fills slot20, and Orchestrator.createSupervisor returns
`host_session_capacity` with count20/limit20/action, zero TUI launches, and a closed
unstarted binding. The owned workspace is removed. Existing initialized manager
and successor identities are preserved on reattachment refusal; an undispatched
pending successor is token-fenced, closed, and its lineage edge retired. The held
attachment is also released before early-exit native cleanup.

Evidence: `.omo/evidence/lina-307/round2-capacity-red.txt`, `qa.md`.

### 3. Preserve proof through recipient persistence failure - discussion_r4120929903

The recipient no longer treats entry into deliver() as native execution. It carries
an attempt-local native boundary through setup, idle admission and tool-call guard
authorization. Opaque executeTool failures are conservative until the guard provides
proof; the guard marks possible delivery only when releasing native thread_send.
If receipt persistence fails while that boundary still proves no native execution,
the reply is admission_failed and the sender finishes a retryable rejection.

Four RED-first regressions cover idle rejection plus finish failure, guard rejection
plus finish failure, guard worker throw, and tool setup throw. Each now persists
rejected with native count0, then the same-ID retry is accepted with exactly one
native invocation and accepted replay adds none. Existing post-native finish-failure
and lost-reply tests remain uncertain and do not resend. No wire format change.

### 4. Close only the tab created by refused admission - discussion_r4121425307

Successor launch now remembers the exact tab ID returned by this attempt's
createTab. A native-capacity refusal awaits tab.close for that ID before the caller
retires the unstarted binding. An existing pane never supplies that ownership proof
and is not closed. The same leak existed in manager reattachment and is fixed there
as well; accepted manager identity remains intact. Parent/child/new-manager creation
uses the existing owned-workspace cleanup, while foreground user-owned workspaces
remain untouched.

RED-first tests assert both new-tab cleanup and existing-tab preservation, including
cleanup before successor retirement. The Herdr adapter exercises exact tab.close
RPC parameters over a fixture Unix socket; no live workspace is used.

### 5. Prove TUI attachment rather than the admission hold - discussion_r4121675141

All three launch paths now confirm the exact native row (routing handle, durable
ID, session path and cwd) has at least two attachments before any identity probe
or activation. The confirmation uses the hold connection itself, so its check does
not add an attachment. It subscribes before checking, rechecks on native events,
and makes a final bounded deadline check without sleeps or polling. After releasing
the hold, it requires the exact row to retain at least one attachment.

The check precedes waiting for OLW readiness: a local TUI that never publishes
readiness is also handled. Failure returns host_session_capacity at full occupancy,
otherwise runtime_unavailable with reason tui_local_fallback. It stops the local
TUI, closes only attempt-owned tabs/workspaces and retires the uninitialized binding
after exit proof. Existing initialized manager identity and user workspaces remain.
Successor cleanup is owner-token-fenced and may retire a dispatched attempt only
after local TUI stop plus pending initialization. No initial instruction was sent.

RED-first regression reproduced ready from the hold alone. Expanded tests cover
new manager, reattachment, parent, direct child and successor, missing readiness,
wrong native identity, event-driven attachment and post-release loss. Disposable
QA invokes the real native TUI adapter against an unavailable TUI socket while
OLW holds the actual worker session: the fallback warning is observed, attachment
count stays1, no verification/initialization occurs, local surface is stopped and
the binding/native hold are removed. status/doctor were not changed.

### 6. Separate observation failure from proven fallback - discussion_r4121925411

A failed list is now TuiAttachmentUnverifiedError, never local-fallback evidence.
Before the deadline, failures wait for a native event or the deadline observation.
Failure at the deadline, hard timeout, or after hold release yields
runtime_unavailable/reason attachment_unverified. All three launch paths preserve
the TUI and its tabs/binding, record launchState uncertain, and leave reconciliation
to the operator. Foreground manager error handling explicitly preserves this case.
Proven successful negative observations retain the existing fallback cleanup path.

Events and the deadline arriving during an in-flight list set a pending recheck.
The stale result cannot reject; one fresh observation starts after the deadline
before any negative decision. Deterministic deferred-promise tests cover this.

Attachment count is now only supporting evidence. Each real launch passes a nonce
only to its TUI. The local readiness receipt includes that nonce, PID and Linux
process starttime. Confirmation checks pane PID ownership and a current Unix socket
peer from that PID to the exact host socket, both before and after hold release.
An observer in another process cannot satisfy it. Missing or unreadable evidence
is unverified, not fallback. This uses actual transport ownership; sharedHostEnabled
is merely configuration and was explicitly rejected as a runtime-state signal.

The TUI extension must not independently open a persistent connection to that host
socket during startup; otherwise process attribution would not identify its native
adapter. Current OLW TUI startup does not do so. Linux /proc and iproute2 ss are
required for this proof; unavailable diagnostics fail closed as unverified.
