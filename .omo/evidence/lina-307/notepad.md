# Ultrawork Notepad - LINA-307 host memory

Started: 2026-09-28T08:54:00Z
Worktree: /home/jun/code/olw-wt/lina-307-host-memory
Baseline: 22bf7e3; branch fix/lina-307-host-memory.

## Plan (exhaustively detailed)

1. Read repository instructions, host/profile callers and existing tests.
2. Trace session runtime, capacity, shutdown and JS/Python kernel ownership.
3. Keep a reproducible no-model memory harness with real OLW extensions.
4. Measure ~10 sessions in both runtimes: baseline, allocated and listening,
   attached idle, closed, settled; attribute RSS and TCP LISTEN sockets by PID.
5. Decide isolation architecture from these numbers, not the requested default.
6. Add red regression tests for profile/migration, isolated idle admission and
   synchronous release recheck, and typed actionable capacity errors; save red.txt.
7. Implement profile compatibility and normal handoff, manager admission, capacity.
8. Update operations/run skill and operator changelog.
9. If reproduced, preserve a Senpi-only defect repro in upstream-draft.md.
10. Run memory QA with new profile; real two-session describe/send and idle admission.
11. Tear down every disposable host, process, socket, directory; record qa.md receipt.
12. Run full bun test normally, then HERDR_ENV unset with nonexistent Herdr socket.
13. Run diagnostics, typecheck, lint, build, release:check and isolated install smoke.
14. Self-review diff and every invariant. Commit verified increments with Evidence
    and Linear trailers; do not push. Return requested DoneClaim JSON.

## Success criteria + QA scenarios

Tier: HEAVY, because session lifecycle and concurrent admission cross isolate boundaries.
Ideal end state: closing a role session releases its allocations and listeners;
one runaway role session cannot destroy unrelated sessions; delivery remains exact-once.

- `bun scripts/qa-host-memory.ts`: run both explicit runtimes on owned /tmp sockets,
  with ten sessions executing real eval allocations and loopback servers. PASS means
  raw PID/RSS/listener samples exist for baseline/active/idle/closed and the selected
  production architecture demonstrably reclaims session resources. Save measurements.md.
- Profile/doctor/handoff regression tests: worker-compatible (or measured alternate)
  profile accepted, old in-process rejected for normal handoff; readonly status never
  uses list_sessions. Save red.txt and verification.txt.
- Two-session disposable socket RPC `omo.initiative.describe` / `omo.initiative.send`:
  idle notice admitted, busy notice refused/deferred, final synchronous check blocks
  a newly busy target. Accepted/uncertain delivery is never replayed. Save qa.md.
- Open beyond capacity: typed actionable terminal error, not silent wait. Save qa.md.
- `bun test`; `env -u HERDR_ENV HERDR_SOCKET_PATH=/tmp/olw-lina307-no-socket bun test`:
  both exit 0, exact counts recorded. All required tooling and install smoke exit 0;
  changed-file LSP diagnostics contain zero errors. Save verification.txt.
- Stop immediately when verified atomic commits exist, evidence and cleanup receipts
  are complete, and DoneClaim JSON is delivered.

## Now

Investigation and measurement harness design. Two independent read-only explore
children inspect dependency lifecycle and delivery/caller contracts; lead owns harness,
architecture decision, implementation, real QA and commits. No planning child yet:
architecture depends on measurements that do not yet exist.

## Todo

All 20 live todo items remain open; list mirrors the steps above.

## Findings

- Worktree already contains a package.json edit moving patchedDependencies from pnpm
  to the root plus untracked bun.lock. These pre-existing changes are not ours and
  will not be reverted or committed. Dependencies here are a flat Bun installation.
- src/host-profile.ts:669 pins in-process, :673 persistent; compatibility at :581.
- src/extension/manager-idle.ts stores live contexts on globalThis. index.ts wires
  isManagerIdle into runtime; runtime.ts:619 awaits idle then synchronously checks,
  and :890 checks again in thread_send preflight. Must retain both guarantees.
- Installed Senpi docs/rpc.md:103 says worker isolates; :665 explicitly says neither
  runtime contains process-fatal OOM; :691 capacity 20; :733 memory observer reports
  and refuses only new worker-kind opens at high RSS. No containment inferred.
- Incident report confirms kernel OOM killed PID 273904 (anon-rss 23661348 kB) after
  four hours. Listener audit is additional user-provided evidence; measurement must
  reproduce loopback sockets plus retained allocations through actual tool/eval.
- scripts/qa-linear-extension.ts and qa-monitor-extension.ts already use extension
  RPC handlers calling pi.executeTool. This is the no-paid-model harness pattern.

## Learnings

- Skill selection: readchk for bundled constraints; bun-1-4 and programming/TypeScript
  for implementation; debugging for differential lifecycle reproduction; mandela for
  independent /proc and socket evidence; git-master for authorized atomic commits;
  sip for final artifact check. Context7 applies only if external API docs are needed.
- No Herdr control is needed for the memory harness. Never use the live root/socket,
  global configuration, or upstream source/patch edits. Fake model must be local.
- Existing rpc QA uses retained sessions; distinguish detach/idle from explicit close.
- Never make measurements pass by invoking a QA-specific cleanup hook before sampling.
  Cleanup happens after evidence; socket and RSS observations come from the OS.

## Artifact journal

- This evidence directory and scripts/qa-host-memory*.ts are intended deliverables.
- /tmp/ulw-20260928-175644.bdiEVy.md was created empty by bootstrap; remove at cleanup.
- Future disposable hosts must use generated /tmp/olw-memory-* roots; harness finally
  must terminate its process group, verify no PID/listener remains, and remove roots.

## Measurement increment - 2026-09-28T09:03:08Z

- Created scripts/qa-host-memory.ts and qa-host-memory-extension.ts; both LSP clean.
- Existing build completed 0. Real no-model harness completed 0 on both runtimes.
- Raw samples summarized without rounding in measurements.md. In-process
  199496 -> 1060136 -> 346532 KiB; worker 254724 -> 2761072 -> 389896 KiB.
  Listeners for both 0 -> 20 -> 20 idle -> 0 closed. No native-close leak reproduced.
- Worker peak is ~2.60x in-process; both retain everything during attached idle.
- Lifecycle explorer confirms no resourceLimits on session or JS kernel workers;
  native session shutdown calls codemode dropRuntime -> kernel.close/worker.terminate;
  Python closes with group kill and bounded escalation. No upstream disposal defect
  yet proven. Lack of process OOM containment is documented rather than hidden.
- Cleanup receipt: PIDs 546440 and 549993 exited, /tmp/olw-memory-NfXH6V and
  /tmp/olw-memory-d2UhJS removed by harness finally; all listeners zero before exit.
- Now: choose architecture from measurements and native delivery constraints.

## Design refinement - 2026-09-28T09:16:08Z

- Added extension-tool allocation variant to the harness; actual pi.executeTool
  invokes registered qa_memory_server, no synthetic disposal hooks.
- Close leak now reproduced: in-process 1077588 -> 1071456 KiB, 10 listeners remain;
  worker 2695116 -> 381592 KiB, 0 listeners. Full samples in measurements.md.
- Decide worker for session-extension lifetime reclamation, normal handoff migration,
  target-owned manager admission and explicit 20-session capacity. No claim of hard
  process OOM containment; upstream has no resourceLimits. No premature idle eviction.
- Existing native thread_send has no cross-host target; store has three host_mismatch
  authorization checks. Process sharding would require a separate delivery design.
- Existing native target resolver accepts self/own durable id. Target-owned admission
  can execute self-delivery with native dedup after registry claim authorization.
- All four measured hosts exited. Additional roots thUPNA and AyCozF removed.

## Implementation - 2026-09-28

- User approved worker + target-owned manager admission + explicit capacity, no
  sharding or early eviction. User authorized restoring preparation package.json
  and deleting bun.lock; both completed, exit 0. Use pnpm only on reinstall.
- Profile/capacity child wrote worker generation/compatibility, admission marker,
  typed HostCapacityError/assertHostCapacity and tests. Audited changes here.
- Lead added target-owned admit-manager-notice RPC, local context closure, exact
  recipient attachment and native self-send. Registry claim/authorization/native
  key remain authoritative. Concurrent RPCs are fenced before awaits; only in-flight
  keys are held in memory. Accepted/uncertain records never resubmit.
- Manager isolated idle RED: 2 pass, 1 fail. After implementation and adapted
  receiving-context fixtures, focused suite 22 pass/0 fail; operational combined
  prior pass 49/0. Capacity role-launch RED 0/1, GREEN 1/0. Typecheck/build exit 0.
- A formatting subprocess initially returned empty stdout due to stdin usage;
  full before strings were retained and immediately restored via apply_patch.
  Subsequent Blob stdin and exact trailing-newline patching worked; tsc/build
  revalidated restored sources. No intentional code lost.
- QA-script child violated its assigned path and created only
  /home/jun/code/omo-linear-workflow/scripts/qa-manager-idle.ts. Lead detected file
  absent in worktree, read and moved that exact new file using apply_patch. No host
  commands were run there; no live socket touched. Replaced its daemon launch with
  direct disposable process launch, scrubbed inherited credentials and fixed cap
  expectations before first execution. This scope incident is disclosed in handoff.
- Current real QA: bun scripts/qa-manager-idle.ts --capacity, attempt 1,
  monitor mon_JCEY63TFR18HGM0R. No repeat until evidence inspected.
- LSP fresh diagnostics often time out after edits; tsc is green, but LSP zero-error
  requirement still open. Must repair diagnostic channel or state exact limitation.

## Verification complete - 2026-09-28

- Actual worker-host describe/send idle/busy/dedup/cap20 passed, attempt 2 after
  fixing QA-only already-idle wait. Twenty sessions and host cleaned; qa.md.
- Post-change extension allocation: RSS 2719700 -> 382752 KiB, listeners 20 -> 0.
- Final normal suite 720/0 (88.57s), Herdr-unset/nonexistent socket 720/0 (100.78s).
- tsc, Biome, build, release:check all exit 0. Biome has existing information-only
  useLiteralKeys diagnostics, no error/warning. Install smoke 5/0 plus built CLI help.
- LSP resolved by directory scans: src49/scripts40/extension10/tests50 capped all
  zero errors; integration3/runtime4/transport1 checked separately, zero errors.
- Self-review inspected production diff, new modules, permission/native-key checks,
  preflight synchronous idle check, concurrent fence and cleanup. No plan-gated
  review applies. Cold-read evidence check narrowed overbroad reclamation wording.
- No leftover QA roots/PIDs/listeners. Bootstrap empty /tmp note removed. Preparation
  package.json reset and bun.lock deletion verified. Live-root accidentally added
  script absent; no live runtime commands ever issued.
- Now: commit the single coupled runtime/profile/delivery fix with evidence trailers.
- Todo: commit, verify SHA/status/trailers, report DoneClaim JSON and stop.

## PR 19 round 2 - 2026-09-28

Baseline bb93fbc, clean worktree. Gate report read in full from
/home/jun/.omo/evidence/lina-307-gate-review.md. CI validate already PASS, verified
with gh pr checks; no external comment or push authorized.

Plan: red-first capacity-race launch test; replace observational-only capacity
admission with an actual native open held across TUI attachment. The TUI attaches
an already-owned path, so it cannot lose the last slot and fall back locally.
Cover new roles, successor dispatch, and manager reattachment. A native refusal
before TUI launch is typed terminal capacity, with no local process to kill; close
the unstarted reservation while preserving existing initialized manager identity.

Parallel lane r2-manager-delivery owns only extension runtime/client and related
tests, fixes proven pre-native versus uncertain failures, and audits requestExtension
siblings. Lead owns orchestrator/transport slot acquisition, deterministic and real
disposable-host race QA, docs/reply drafts, final two-mode verification and one commit.

Criteria: guard passes at 19, competing open fills20, actual native launch open
refuses before pane launch; terminal host_session_capacity count/limit/action,
unstarted binding closed. Successful held open lets TUI attach even at cap. No native
or local TUI leak. Manager admission refusal finishes rejected and same-ID retry
delivers once; sent request with lost reply stays uncertain and never retries.

Invariants remain: no live root/socket, global config, upstream or patch mutation;
no read-only list_sessions; no accepted/uncertain resend; all /tmp resources cleaned.
Real race scenario max two failing attempts. One new commit only, no push.

### Round 2 capacity implementation and evidence

- acquireLaunchSession opens the exact seeded native path and holds its attachment
  across TUI verification. Guard19/competing20 now fails before TUI run; no local
  fallback can be created. New-role binding closed, owned workspace removed.
- Siblings: manager reattachment typed capacity preserves accepted identity;
  successor admission before dispatch closes only pending unstarted attempt,
  settles history and retires edge under owner token. Initialized successors keep
  identity. Early foreground exit releases held attachment before native cleanup.
- Red-first tests captured in round2-capacity-red.txt. Focused first pass116/0;
  initialized-successor and early-exit deltas each red then green.
- Real QA `bun scripts/qa-manager-idle.ts --capacity-race`, attempt1 PASS, PID3452500,
  /tmp/olw-manager-idle-jVPsez. Actual guard19 -> competitor20 -> real native refusal
  -> host_session_capacity count20/limit20/action, TUI launches0, closed binding.
  Twenty sessions/host/socket/root cleaned and independently checked. qa.md updated.
- Manager lane review found generic returned worker_failed could follow native
  acceptance. Required phase-tagged RPC proof instead of error-code blacklist;
  WORKER_ADMISSION_2 marker makes mixed old/new runtime incompatible via handoff.

### Round 2 integration verification

- Manager lane finished: target-owned admission_failed/delivery_result union;
  before_request transport error typed separately from request_uncertain. Native
  finish-worker failures remain uncertain; known response survives cleanup failure.
- Audited every sendManagerNotice/requestExtension site, documented in
  round2-sibling-audit.md. Reply drafts for both requested discussion IDs are ready,
  not posted. No accepted or uncertain retry widened.
- Integrated real QA PASS at 10:49Z: missing manager -> rejected -> reopen ->
  same-ID accepted, two attempt records and one transcript occurrence. Race19/20
  still yields typed terminal with no TUI; held slot attaches at cap and survives
  release. PID3667385/rootH1V6Z3 removed and independently verified.
- Normal full suite738/0 (174.74s). Herdr-unset full suite pending monitor
  mon_RA38EEKWP4X4JR2Q. Final static/build/release/install-smoke all exit0, smoke5/0;
  directory LSP zero errors. No code changes after these tests began (QA formatting only).
- Self-review read all production diff, native slot ownership/release, owner-fenced
  successor retirement, initialized identity preservation, phase proof and uncertain
  semantics. Stop after second full suite result, one new commit and SHA/status check.

- Final Herdr-unset suite738/0 (107.86s), exit0. All requested verification complete.
  Commit one increment now; no push. No remaining QA processes/directories.

## PR19 round3 - base48f2c8d

Lead doing both fixes directly. Goal/todos reset; no child. CI baseline green.
RED four pre-native paths returned uncertain instead of rejected. Fixed by tracking
attempt-local nativeBoundary through deliver and onToolCall: setup/idle errors
remain pre-native; executeTool opaque failures conservative; guard proves pre-native
until returning permission. Recipient persistence errors preserve that proof back
to sender. Focused manager28/0; post-native failure remains uncertain.

RED new successor and reattachment tabs leaked on cap. Added required closeTab
adapter, tracked only locally returned tab IDs, closed before capacity return and
successor retirement. Existing panes never closed; parent/child/new-manager owned
workspace path unchanged. Tabs8/0. Updated interface fixtures only as necessary.
Draft replies3/4 ready. Still need final both-mode suite, static/build/release/smoke,
diagnostics and one NEW commit/no push. All modifications in assigned worktree.

Round3 final state: normal746/0,101.61s; Herdr-unset pending monitor
mon_1MMERPZW8WJHAPXP. Typecheck/lint/build/release/smoke all exit0; install5/0.
LSP directory scans0 errors. Real updated worker host QA PASS (PID272958/eauTMx),
cleanup independently verified. Full production diff reviewed; no forbidden files.
Native runner emitToolCall rethrows guard errors, validating pre-native throw proof.
Remaining: record second suite, one new commit, SHA/status check, DoneClaim JSON.

Herdr-unset final suite746/0,170.39s,exit0. All round3 checks complete;
recorded in round3-verification.txt. Create one commit and verify SHA/clean status.

## PR19 round4 base46f17a2

Root fix: LaunchSession.confirmTuiAttachment uses hold client list_sessions with
include_workers, exact handle/durableID/path/cwd/status and attachments>=2. Subscribes
native events then checks now/event/deadline; no sleep/poll. Releases own hold then
requires attachments>=1 with bounded post-release check. Called immediately after
TUI launch before readiness/identity activation at all3 sites. release idempotent.
Fallback error count classifies capacity vs runtime_unavailable reason. Stops TUI
with existing event-driven /quit or owned foreground kill; only then closes owned
workspace/tab and pending binding. Successor dispatched retirement requires explicit
localTuiStopped proof and same token, preserves initialized work.
RED0pass/3fail reproduced baseline false-ready bug; recorded round4-red.txt. Focused13/0 and full
related5files164/0. Added readiness-absent test too. QA attempt1 PASS actual worker
host + actual native adapter fallback warning (missing TUI socket); native hold1,
terminal failure, stopped fixture TUI, closed binding, native row gone. PID941055
uSrxVQ cleaned. No live root/socket. Reply draft5 done. Need final full suites both
modes, static/build/release/smoke/LSP, evidence and one new commit/no push. User asks
not to end turn before DoneClaim; continue tools through pending monitor events.

Round4 final code now checked before readiness (covers no readiness). Added foreground
owned-child-only kill test and direct child fallback. Focused164/0 plusforeground1/0.
Normal full760/0,174.91s. No-Herdr pending mon_HT415ZY63GGJEYFY. Static/type/lint/build/
release/install all exit0, install5/0; LSP0. QA second/final runPASS PID1004033 AuRQHR
after check reordering and bounded post-release check; bothQA roots/PIDs independently
gone. round4-verification.txt current. Remaining second fullsuite, final diff review,
one new commit with evidence trailers, clean/SHA check, DoneClaim. No more QA runs.

Round4 second fullsuite completed760/0,174.38s,exit0. All checks complete. Commit
staged single increment now, verify exactly1 new commit/clean worktree, DoneClaim.
