# PR 19 sibling audit

Baseline bb93fbc; read src call sites with `sendManagerNotice` and `requestExtension`.

| Boundary | Claim owner | Result / failure handling |
| --- | --- | --- |
| runtime deliver -> sendManagerNotice | Sender runtime | Explicit admission_failed and before_request error finish rejected; delivery_result failure or request_uncertain marks uncertain. No generic error is inferred to be pre-native. |
| admit-manager-notice -> deliver | Recipient runtime | Pre-native worker Result/throw is phase-tagged admission_failed. Once deliver is entered, errors are delivery_result. Native finish storage failure cannot authorize retry. |
| transport NativeSession.send -> omo.initiative.send | Remote extension | Claim is created inside extension, not by transport. Runtime claim/replay/finish owns state. Changed manager branch now settles both returned and thrown failure paths. |
| deliverUserAnswer -> deliver-user-answer | Orchestrator plus recipient | #finishUserAnswer explicitly marks returned errors and transport exceptions uncertain; it cannot leave a successful caller-side claim in sending. Existing non-retryable user-answer policy is preserved. |
| describe | None | Identity read, no delivery claim to strand. |
| herdr-republish | None | Reporter state RPC, no delivery claim or message resend. |

Regressions include returned admission failure followed by same-ID retry, typed
pre-request exception, lost admission reply, stale/concurrent replies, pre-native
worker throw, and native execution followed by finish-worker failure. The last
case initially exposed why a generic Result-error blacklist was insufficient;
the final phase union provides receiver-owned proof instead.

Launch siblings: new-role, manager reattachment and successor launch all acquire
the actual native slot before TUI dispatch. Unstarted successor retirement is
owner-token-fenced and only accepts pending initialization. Already accepted work
is never retired by capacity refusal. Foreground early exit releases its temporary
admission attachment before native termination to avoid a false extra-owner failure.

Admission wire format changed, so WORKER_ADMISSION_2 is required. Prior worker
generation is rejected through the existing guarded handoff, not silently mixed.

No read-only status/doctor path changed. No upstream package/patch changes.
