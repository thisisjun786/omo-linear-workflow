# Host memory measurements

Command: `bun scripts/qa-host-memory.ts 10 64`
Date: 2026-09-28T09:02:13Z through 09:03:07Z.
Runtime: Bun 1.4.0, Senpi 2026.9.27, omo-ai 5.0.1, Linux x64.
Baseline source: 22bf7e3; no production edits. Build exited 0.

Each of ten sessions runs `pi.executeTool("eval", {language:"js", ...})`
through a QA extension RPC, allocating/touching 64 MiB and starting one
`Bun.serve` listener on 127.0.0.1. Real OMO, OMO member and OLW extensions
are loaded. The fake provider replaces inference only; this run makes no model
request. No fixture cleanup hook, forced GC, or allocator hint runs before sampling.
Five seconds is the explicit observation interval, not an async assertion sleep.

RSS and anonymous RSS are kernel `/proc/PID/status` values in KiB. LISTEN
sockets are TCP/TCP6 state 0A joined to that PID's actual fd socket inodes,
not the network namespace's entire socket table. Ten user servers plus ten
codemode bridge servers explain the twenty listeners. Merely attached and idle
sessions keep their memory and listeners; explicit close removes all twenty.

| Runtime | PID | Phase | RSS KiB | Anon KiB | LISTEN fds |
| --- | ---: | --- | ---: | ---: | ---: |
| in-process | 546440 | baseline | 199496 | 155352 | 0 |
| in-process | 546440 | allocated | 1060136 | 1006860 | 20 |
| in-process | 546440 | attached idle 5 s | 1051348 | 998072 | 20 |
| in-process | 546440 | close acknowledged | 347824 | 294548 | 0 |
| in-process | 546440 | closed settled 5 s | 346532 | 293256 | 0 |
| worker | 549993 | baseline | 254724 | 149020 | 0 |
| worker | 549993 | allocated | 2761072 | 2638144 | 20 |
| worker | 549993 | attached idle 5 s | 2759320 | 2636392 | 20 |
| worker | 549993 | close acknowledged | 550456 | 427464 | 0 |
| worker | 549993 | closed settled 5 s | 389896 | 266904 | 0 |

## Interpretation before choosing the fix

The claimed close-time socket leak is NOT reproduced on this installed version.
Both runtimes release the allocation and every listener after explicit close.
Worker returns 2371176 KiB from allocated to settled; in-process returns
713604 KiB. Both retain some runtime baseline growth. Worker uses about 2.60x
the peak RSS for this workload and does not improve attached-idle retention.

The incident therefore cannot be honestly fixed by claiming worker mode alone
solves long-lived retained role sessions. Both retain live eval state while idle,
and both use one PID for all ten sessions. `session-worker-client.js:11-15`
creates Worker with no resourceLimits; codemode `worker-host.ts:29-34` likewise.
The documented absence of process-fatal OOM containment is consistent with code.

At this point the design was undecided. The extension-layer differential below
resolved that question without assuming worker OOM containment.

## Session-extension tool differential

Command: `QA_MEMORY_LAYER=extension bun scripts/qa-host-memory.ts 10 64`.
Date: 2026-09-28T09:15:15Z through 09:16:07Z. The same allocation/server now
runs in an actual registered extension tool via `pi.executeTool`, outside the
nested eval kernel. No session_shutdown cleanup hook is installed. The server
closure retains the touched allocation. This distinguishes session isolation
from codemode's own already-working kernel cleanup.

| Runtime | PID | Phase | RSS KiB | Anon KiB | LISTEN fds |
| --- | ---: | --- | ---: | ---: | ---: |
| in-process | 779525 | baseline | 253536 | 147276 | 0 |
| in-process | 779525 | allocated | 1077588 | 955308 | 20 |
| in-process | 779525 | attached idle 5 s | 1073652 | 951372 | 20 |
| in-process | 779525 | close acknowledged | 1071728 | 949448 | 10 |
| in-process | 779525 | closed settled 5 s | 1071456 | 949176 | 10 |
| worker | 994219 | baseline | 251680 | 145976 | 0 |
| worker | 994219 | allocated | 2695116 | 2572040 | 20 |
| worker | 994219 | attached idle 5 s | 2682252 | 2559176 | 20 |
| worker | 994219 | close acknowledged | 607800 | 484660 | 0 |
| worker | 994219 | closed settled 5 s | 381592 | 258452 | 0 |

Here the close-time leak IS reproduced: all ten extension-created listeners and
their 640 MiB survive in-process session disposal. Worker isolate termination
releases every listener and returns 2313524 KiB (2259.3 MiB) of aggregate RSS.
In-process returns only 6132 KiB. This is why measuring only nested eval cleanup
would have incorrectly rejected worker isolation as having no lifetime benefit.

Both hosts exited and scratch roots `/tmp/olw-memory-thUPNA` and
`/tmp/olw-memory-AyCozF` were removed. A missing `details` field in the fixture's
tool result was a TypeScript diagnostic, corrected after the run; it did not
change allocation, socket ownership or disposal.

### Design decision

Select worker runtime to give ALL session extension state a reclaimable lifetime,
not only resources that voluntarily register cleanup. Keep native shared-host
transport and normal generation handoff. Reject per-role hosts: native thread_send
has one host socket, and OLW's route authorization requires same-host identity;
sharding would replace the delivery contract rather than fix this lifecycle bug.

Move manager idle admission into its own isolate, with a synchronous live-context
recheck in the target's native-send preflight. Do not use asynchronously copied
busy flags as proof of idleness. Surface the native 20-worker limit explicitly.

Hard process-fatal OOM containment remains an upstream limitation: workers share
one PID and have no heap resourceLimits. This change cannot truthfully promise
that an actively allocating session will never kill others. Idle attached sessions
retain their state until native safe eviction/close; shortening eviction without
proving TUI reattachment is rejected. The measured fix is RSS reduction and complete
listener removal after explicit close in these runs, not a per-session RSS hard cap.
Native safe park uses the same disposal path but was not timed in this experiment.
The separate two-session delivery and 21st-session refusal run is recorded in
[qa.md](qa.md); profile mismatch/handoff regression checks are in verification.txt.

## Post-change worker verification

Command: `QA_MEMORY_LAYER=extension bun scripts/qa-host-memory.ts 10 64 worker`.
2026-09-28T09:46:25Z through 09:46:49Z, rebuilt target-admission extension.

| Phase | PID | RSS KiB | Anon KiB | LISTEN fds |
| --- | ---: | ---: | ---: | ---: |
| baseline | 1863454 | 253112 | 147280 | 0 |
| allocated | 1863454 | 2719700 | 2596520 | 20 |
| attached idle 5 s | 1863454 | 2694596 | 2571416 | 20 |
| close acknowledged | 1863454 | 615248 | 492004 | 0 |
| closed settled 5 s | 1863454 | 382752 | 259508 | 0 |

PASS, exit 0: 2336948 KiB returned; every session listener removed before host
termination. PID exited, `/tmp/olw-memory-4yEsfn` and its socket removed.

## Cleanup

Both finally blocks completed and their process exit events were observed:
PID 546440, `/tmp/olw-memory-NfXH6V`; PID 549993, `/tmp/olw-memory-d2UhJS`.
Both owned process groups were terminated and temporary roots removed.
Host stderr contained only its temporary socket listening line. No live control
root command, live socket access, global configuration edit, or provider call.
