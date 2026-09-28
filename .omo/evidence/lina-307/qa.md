# LINA-307 real-surface QA

## Manager admission and native capacity

Command: `bun scripts/qa-manager-idle.ts --capacity`.
Host: disposable socket, actual Senpi worker runtime, real OMO and OLW extensions,
real SQLite registry and native thread_send. Only model inference is fake/local.

Attempt 1 stopped before any delivery scenario: the new QA driver called native
RpcClient.waitForIdle on already-idle sessions. That method subscribes only to a
future agent_settled event. It timed out. Fixed the driver to subscribe first and
read current state, resolving immediately if idle. No production workaround.
Scratch `/tmp/olw-manager-idle-9XRqY9`, PID 1772265, two sessions, fully cleaned.

Attempt 2, 2026-09-28T09:41Z: PASS, exit 0.
Scratch `/tmp/olw-manager-idle-ISrRmW`; host PID 1836496.

- Both `omo.initiative.describe` replies had exact expected durableSessionId,
  sessionPath, cwd, provider/model/thinking and extensionProtocol 2.
- Idle `omo.initiative.send`: accepted, native message_seq 1, one immutable
  envelope occurrence in manager transcript. Same-ID replay returned identical
  stored receipt, transcript occurrence stayed one.
- Busy manager was held by a real provider streaming barrier. The report remained
  sending, manager was streaming, and its transcript contained zero occurrences.
  Releasing the barrier allowed event-driven admission: accepted, message_seq 2,
  one transcript occurrence. Replay again stayed one.
- Twenty actual worker sessions opened. The 21st native open threw
  `RpcCommandError: open_failed: too_many_sessions`. OLW's mutating capacity guard
  returned `HostCapacityError`, code `host_session_capacity`, count 20, limit 20,
  action `close_an_existing_role`. Attaching existing manager at capacity returned
  `{sessionId:"rpc-1", attached:true}`.
- Final synchronous preflight race and concurrent/wrong-native-key admission are
  additionally exercised by tests/manager-isolation.test.ts and the pinned native
  thread factory in tests/runtime/native-delivery.test.ts (not a fake receipt-only
  assertion). Focused 22-test suite passed before this run.

## Cleanup receipt

Post-change memory scenario passed: worker 2719700 -> 382752 KiB; 20 -> 0
listeners before host exit. PID 1863454 and `/tmp/olw-memory-4yEsfn` cleaned.

Attempt 2 finally observed all 20 close responses, terminated owned host process,
waited for exit, removed its socket and temporary root. Printed receipt:
`{"sessionsClosed":20,"hostStopped":true,"socketRemoved":true,"rootRemoved":true}`.
The initial four memory hosts and roots are listed in measurements.md; independent
`ps -p` checks and directory absence checks confirmed all were gone.

## Scope correction

A delegated script author created scripts/qa-manager-idle.ts in the live checkout
instead of the assigned worktree. Lead found this before running it and moved that
single new file into the assigned worktree with apply_patch. No live host command,
socket request or restart was performed. The live file no longer exists. This was
a temporary filesystem scope violation, not a live runtime change.

## PR 19 round 2: actual native admission race

Command: `bun scripts/qa-manager-idle.ts --capacity-race`.
2026-09-28T10:34Z, attempt 1 PASS, exit 0. Disposable host PID 3452500,
root `/tmp/olw-manager-idle-jVPsez`. Real Senpi worker host and native RpcClient;
workspace operations are an in-memory fixture that fails if run is reached.

The actual Orchestrator.createSupervisor path passes assertHostCapacity at 19.
The fixture then opens a competing real session, filling slot20. The orchestrator's
new acquireLaunchSession performs the real native open before TUI dispatch. Native
refusal is mapped to this terminal result:

```json
{"ok":false,"error":{"code":"host_session_capacity","message":"Native host session capacity is 20/20; close an existing role before launching another","details":{"count":20,"limit":20,"action":"close_an_existing_role"}}}
```

Observed `tuiLaunches:0`, owned workspace removed, binding closed with initialization
still pending and text null. No local fallback exists because no TUI was launched.
The same run also passed two-worker describe/idle/busy/dedup and existing-path
attach-at-cap. No model request left the local fake provider.

Cleanup receipt: 20 native sessions closed, host stopped, socket/root removed.
Independent `ps -p 3452500` and directory absence checks passed. No live host access.

### Final integrated run

`bun run typecheck && bun run build && bun scripts/qa-manager-idle.ts --capacity-race`
at 2026-09-28T10:49Z: PASS, exit0. PID3667385, `/tmp/olw-manager-idle-H1V6Z3`.
This rerun followed the phase-tagged manager admission change, not a failing race
retry (both race runs passed).

Additional real-surface observations:
- Closed the exact manager session before a report. Its sending claim became
  rejected, not stuck. Reopened the same durable manager and resent the same logical
  ID/payload: accepted with two attempt records and exactly one transcript occurrence.
  Accepted replay returned the identical record without another occurrence.
- Guard19/competing20 still returned typed host_session_capacity with TUI launches0
  and a closed unstarted binding.
- Freed one slot, acquired a real launch-session hold, attached the same path at
  full capacity, then released the admission hold. The attached native session was
  still alive, proving release does not dispose the TUI-owned session.
- describe/idle/busy/dedup and raw overflow checks still passed.
- Cleanup: twenty remaining sessions closed, host exit observed, socket/root removed.

## PR19 round3 smoke

2026-09-28T11:21-11:22Z: `bun scripts/qa-manager-idle.ts --capacity-race`
PASS, exit0. Host PID272958, `/tmp/olw-manager-idle-eauTMx`.
Updated runtime passed exact describe, idle/busy delivery, same-ID rejection retry
(two attempts/one transcript), capacity19-to20 race with zero TUI launches and
closed binding, and held-slot attach survival after admission release.
Cleanup receipt: twenty sessions closed, host stopped, socket and root removed.
The injected pre-native persistence failure and tab ownership are covered by
round3 integration tests; this run is not represented as real Herdr tab UI QA.

## PR19 round4 local-fallback QA

`bun scripts/qa-manager-idle.ts --local-fallback --capacity-race`, attempt1 PASS,
exit0,2026-09-28T11:47Z. Host PID941055, `/tmp/olw-manager-idle-uSrxVQ`.
Actual worker host holds seeded role path, list_sessions attachments1. Real installed
createInteractiveHostRuntime attempts the deliberately missing TUI socket and emits
interactive_host_fallback: "Warning: shared interactive host unavailable; continuing locally".
The adapter returns its local runtime sentinel. Workspace/TUI exit control is a
fixture, not a live Herdr pane. Orchestrator rejects hold-only attachment at its
deadline with runtime_unavailable/details.reason=tui_local_fallback, requests local
exit, removes its workspace and closes binding with initialization pending/null.
No describe/configure/prompt callback may run. Native row absent after hold release.
The run also passed idle/busy/replay/same-ID retry,19-to20 capacity race, and the
positive two-attachment path with a surviving attachment after hold release.
Cleanup receipt:20 sessions closed, host stopped, root/socket removed.

Final round4 build rerun at11:55Z: same command PASS, PID1004033,
`/tmp/olw-manager-idle-AuRQHR`. Confirms final check ordering before readiness:
holdAttachments1, real adapter local fallback warning, typed refusal, stopped local
fixture and removed owned workspace, pending binding closed. Positive attach>=2
then post-release>=1 still passed. Cleanup20 sessions/host/socket/root succeeded.
Both allowed QA attempts passed; no third run.

## PR19 round5 observer plus local-fallback TUI

`bun scripts/qa-manager-idle.ts --local-fallback`,2026-09-28T12:26Z,attempt1 PASS.
HostPID1327721, `/tmp/olw-manager-idle-jvnjpt`; observer/hold ownerPID1327687,
separate TUI processPID1328939. Actual host row attachments2 (hold+observer).
The separate TUI uses the real installed native adapter and emits its fallback
warning from a missing socket. It publishes a nonce/PID/starttime-bound readiness.
Kernel socket proof sees no exact peer owned by that TUI, despite observer count2.
The orchestrator returns tui_local_fallback, stops the owned TUI process, closes
the pending binding and fixture workspace; observer/hold are then closed and the
native row disappears. Existing idle/busy/replay and same-ID retry also passed.
Cleanup2 base sessions+observer+TUI+host/root/socket succeeded, exit0. Pane membership
and workspace operations are fixture controlled, not a live Herdr UI.
