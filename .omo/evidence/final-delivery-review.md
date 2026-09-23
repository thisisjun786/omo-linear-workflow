# Final delivery repair review - 2026-09-23

Verdict: PASS within the requested boundary. Both original P1 findings are resolved;
no remaining reproducible ownership or exactly-once-attempt defect was found.
Scope: current `src/core`, `src/extension`, `src/transport`, requested tests, and the
orchestrator regression seam. No source, OAuth, live Linear, global server, or vendor code touched.

## RESOLVED P1 - Direct native sends bypassed durable claim/payload invariants

Refs: `src/extension/runtime.ts:176-188,195-206,231-280`;
`src/core/store.ts:166-170,483-551,553-576,606-619`;
`tests/events.test.ts:291-307,364-404`; `tests/store.test.ts:394-456`.
The RPC now claims before native execution. Replay returns the persisted terminal record;
`sending`/`uncertain` returns `delivery_in_progress` and cannot execute again. The only
native execution receives a one-use `AsyncLocalStorage` permit containing the exact sender
and canonical native input. The tool hook blocks missing/reused permits, mismatched input,
forged envelope identity, wrong target, and every ordinary bound direct `thread_send`.
The SQLite claim uses `BEGIN IMMEDIATE`; the message ID binds the complete canonical
envelope, so changed text or other fields produce `message_conflict`.
Independent two-process claim probe returned exactly `new` + `in_progress` against one DB.
Verdict: resolved. One claimant can cross the native boundary; persisted uncertain work is
not retried, including after reopening the registry.

## RESOLVED P1 - Role creation reported acceptance after rejection/uncertainty

Refs: `src/orchestrator.ts:810-832,834-893`; `src/core/store.ts:433-481`;
`tests/integration/orchestrator.test.ts:443-460`.
Initialization has an immutable durable claim. `#initialize` promotes only
`DeliveryRecord.state === "accepted"`; rejected maps to `brief_rejected`, and sending,
uncertain, missing, or thrown outcomes map to `brief_uncertain` with no blind resend.
Creation reaches `execution: "brief_accepted"` only after that accepted result.
The regression injects both valid rejected and uncertain delivery records and requires
creation failure.
Verdict: resolved.

## Invariant trace

- Sender is runtime-derived from `sessionManager`, never trusted from payload:
  `src/extension/index.ts:43-56`; `src/extension/runtime.ts:151-178,231-269`;
  `src/core/store.ts:483-491`.
- Immediate-owner instruction/report routes are checked from stored bindings; peer parent
  coordination is initiative-local: `src/core/store.ts:528-551`.
- Pause blocks either endpoint and cancellation cannot resume:
  `src/core/store.ts:396-403,505-506`. Claims re-authorize before lookup, so paused,
  cancelled, closing, or non-ready endpoints cannot initiate or replay through the RPC.
- Acceptance is native queue/start/steer acknowledgement, not task completion:
  `src/core/contracts.ts:98-106`; completion remains an explicit report outcome
  (`src/core/contracts.ts:86-95`). No task-quality claim follows from acceptance.
- Native receipt target is checked before acceptance; malformed, wrong-target, and native
  idempotency-uncertain outcomes persist as uncertain: `src/extension/runtime.ts:209-228`;
  `src/core/store.ts:578-603`; `tests/events.test.ts:327-362`.

## Verification and exact limitations

- Ran once: `bun test tests/store.test.ts tests/events.test.ts tests/transport
  tests/integration/orchestrator.test.ts` - 23 pass, 0 fail, 168 expectations.
- The event harness executes the real tool guard and real worker/SQLite boundary, but its
  native receipt is fixture data. Transport tests return fixed extension replies and do not
  prove native SDK behavior. Existing real-surface QA in `final-repairs.md` was not repeated.
- Sentinel/fixture echoes establish transport, routing, wake, and dedup behavior only; they
  do not establish autonomous task quality or completion.
- No Mandela communication mechanism was available in this child session, so independent
  Mandela sign-off remains unverified. SDK callback isolation/dedup internals remain outside
  scope; no hostile same-user filesystem isolation requirement was assumed.
