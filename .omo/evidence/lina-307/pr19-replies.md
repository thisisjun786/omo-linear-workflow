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
