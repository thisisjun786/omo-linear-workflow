# Final lifecycle repair review

## Verdict
**PASS - no blocking lifecycle defect remains in the reviewed scope.** The three
original findings are resolved in current source, targeted regressions, and captured
real-surface evidence. No suites were rerun, as instructed.

## Current lifecycle trace
1. Reservation is durable and ownership-unique until `closed`
   (`src/orchestrator.ts:632-646`; `src/core/store.ts:273-312`).
2. Provision records the created workspace/pane before native startup
   (`src/orchestrator.ts:677-684`; `src/core/store.ts:329-338`).
3. Start seeds the exact durable session/model, subscribes before launch, and accepts
   only a binding/cwd/pane-matched atomic receipt (`src/orchestrator.ts:693-757`;
   `src/readiness.ts:20-30,37-54,57-94`).
4. Exact native attachment applies role model/thinking, describes identity, and
   activates only a matching runtime (`src/transport/client.ts:56-83,106-127`;
   `src/orchestrator.ts:790-805`; `src/core/store.ts:354-375`).
5. Activation enters `initializing`; only durable instruction acceptance promotes
   `ready` (`src/core/store.ts:431-475`; `src/orchestrator.ts:809-895`).
6. Reconcile observes workspace/pane and exact native identity, resumes safe
   initialization, marks losses `uncertain`, and never relaunches
   (`src/orchestrator.ts:504-618`).

## Original findings: repair verdicts
### 1. Failed launches held ownership and leaked resources - RESOLVED
A definite pre-launch host failure atomically closes/releases the reservation
(`src/orchestrator.ts:647-655`). Ambiguous failures remain owned and `uncertain`, as
required to prevent duplicate launch (`src/orchestrator.ts:776-782`). The production
`close` path now identifies the owned workspace, requires explicit confirmation when
pre-provision absence cannot be proved, closes the workspace and exact native session,
removes readiness, and only then commits `closed` (`src/orchestrator.ts:448-500`;
exact-native checks at `src/orchestrator.ts:175-220`). Parent closure is blocked while
children remain live (`src/core/store.ts:406-428`). Regression evidence covers release,
replacement, child-first close, retained checkout data, and definite host failure
(`tests/integration/orchestrator.test.ts:461-491,552-627`).

### 2. `ready` preceded brief acceptance - RESOLVED
Verified activation now yields `initializing`, not `ready`; acceptance is the sole
promotion gate (`src/core/store.ts:354-375,458-475`). The immutable initialization
claim handles lost ACKs by checking the exact supervisor user message or child delivery
ledger and does not blindly resend (`src/orchestrator.ts:834-895`). Regressions exercise
before/after-acceptance interruption and show only observed acceptance recovers to
`ready` (`tests/integration/orchestrator.test.ts:492-516`).

### 3. Restart trusted stale `ready` ownership - RESOLVED
Reconcile now includes `ready`, checks Herdr ownership and exact native/model identity,
and moves missing/mismatched roles to `uncertain` without launching replacements
(`src/orchestrator.ts:529-562,599-610`). Regression coverage removes both supervisor
and parent native identities, verifies both become `uncertain`, and asserts no extra
run (`tests/integration/orchestrator.test.ts:518-546`).

## Evidence and residual risk
Captured final evidence reports 50/50 tests plus typecheck, lint, build, status/help,
and zero source LSP errors (`.omo/evidence/final-repairs.md:3-24`). The latest real
surface passed all role identities, event delivery, runtime-loss reconciliation, and
exact close while preserving worktrees (`.omo/evidence/final-repairs.md:44-63`).
Receipt ordering and wrong-checkout rejection remain directly covered
(`tests/readiness.test.ts:32-66`). Host cold-start persistence is configured
(`src/host-profile.ts:27-40`), but host/server restoration internals are outside this
repository; the in-scope response to observed loss is conservative `uncertain` plus
explicit close, not unsupported recreation. Live Linear/OAuth and vendor internals
remain out of scope and do not qualify this lifecycle verdict.
