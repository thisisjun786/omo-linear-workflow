# Supervisor, parent and child

Shared role contract for `olw-define`, `olw-plan`, `olw-run` and `olw-check`. Adapted from
the CRW `integrations.md`, `initiative-supervision.md` and `operations.md` policy at the
pinned revision named in [NOTICE.md](../NOTICE.md). This file describes policy the
skills follow. The orchestrator enforces routes and ownership in code; nothing written
here is itself an enforcement, and Linear permissions aren't enforced by these skills.

## One task, one Linear level, one role

| Role | Bound to | Model / reasoning | Workspace | Instructs | Reports to |
|---|---|---|---|---|---|
| Supervisor (optional management session) | one initiative ID | `opencodex/gpt-6-astra` / `high` | Herdr workspace at the control root, no implementation branch | its project parents only | the user |
| Parent | one project ID | `opencodex/anthropic/claude-opus-5-5` / `xhigh` | Herdr worktree on the project integration branch | its own issue children only | linked supervisor or local user inbox |
| Child | one issue ID | `opencodex/anthropic/claude-opus-5-5` / `xhigh` | Herdr worktree forked from its parent's branch | internal mass-ulw workers, no OLW roles | its parent |

A project parent is the execution unit; it needs neither an initiative nor a supervisor.
No hidden supervisor is created. Parents and children remain linked Git worktrees, not
clones; management links do not change their branches or ancestry.

A task holds exactly one live scope in exactly one role. A parent doesn't also supervise, and a
supervisor holds no checkout and merges nothing. Peer parents sharing an approved designation
and non-null initiative may coordinate directly, but neither assigns the other's work. Escalate
unresolved decisions to the linked supervisor or the user.

Identity is the stable ID: the Linear initiative, project or issue ID plus the durable OMO
session ID recorded in the registry. A title, folder, branch, pane, chat link or display name
makes no role and moves no ownership. Don't route by the focused pane or a working directory.

A child starts in mass-ulw mode but waits for an explicit issue packet. Its native workflow
nodes are implementation workers, not another hierarchy level or registry owner. They use
category routing rather than the child role's fixed model assignment. The child owns their
scope, phase runs, verification and final report; the parent still owns acceptance and
integration. The [child execution contract](../run/SKILL.md#child) defines the goal, keys,
worker limits, evidence and recovery. These are execution instructions, not a filesystem
sandbox or new permission enforcement in the native DAG engine.

## Definition is not execution approval

Defining or planning an initiative creates no supervisor and moves no project. Importing a
scope snapshot is also not designation. A supervisor exists only after an explicit designation
naming the initiative, recorded with the snapshot digest it was approved against and its
`execute`, `create` and `contact` permissions. An initiative link carried as context changes
nothing. Scope changes need a fresh designation; imported membership never expands itself.

A standalone parent requires its own explicit `--scope-digest`, `--designation` and `--execute`.
A snapshot without an initiative uses `initiative: null`; do not invent an initiative ref.
The existing `parent create --supervisor` mode still inherits that supervisor's approval.

The approved project and issue sets are fixed at designation. User-only `parent link` and
`parent unlink` change the management edge of the existing initialized parent, never its
binding ID, designation, snapshot, initiative provenance, issue set, pause state or worktree.
A link may cross designations if the supervisor's approved snapshot includes the project and
both approvals permit execution/contact. It neither imports the supervisor's issue set nor
replays work or prior reports. A newly linked Linear project remains outside approval until
explicitly designated.

## Who owns which record

| Owner | Owns | Doesn't own |
|---|---|---|
| Linear | goals, criteria, priority, accepted decisions, the final summary | what the code does or how review went |
| Registry (`.omo/state/registry.sqlite`) | runtime identity, bindings, message claims, delivery receipts | product decisions |
| Pull request / repository | implementation, review threads, checks | whether the work was wanted or accepted |

A parent writes its project's coordination record and integrates its issues. A child writes no
Linear record and never merges; it delivers and reports. A supervisor writes the initiative's
record and decides only the order in which projects land on a shared target. Release and
deployment stay with the user.

## Reports go up, instructions go down

Each role instructs only its linked level directly below it. Children report only to their
parent. A parent's new report goes to its ready linked manager, or to the local user inbox
when unlinked or its manager is absent/not ready/closed. `report --to-user` explicitly selects
the inbox even while a manager is linked or paused. It is a user-addressed record with
`toBindingId: null`, `state: posted`, and `receipt: null`, not a synthetic user Binding.
Read it with `reports --project ID`; answer by prompting the exact parent session. `blocked`
carries the exact question; `failed` carries the failure and evidence. Posting wakes nobody
and establishes neither native acceptance nor that the user read it.
A supervisor never addresses a child, even about one issue: it returns a project's finding to
that project's parent. A child reports to its parent, and the parent decides whether that
report satisfies the criteria. Report content is the child's claim, not the parent's verdict.

Five states stay distinct and are never collapsed into one word:

1. Assignment sent (the CLI accepted the message and claimed its ID).
2. Runtime ready (the target session exists with the exact model and extension).
3. Native acceptance (the receipt says `started`, `steered` or `queued`).
4. Reported completion (the child or parent ran `report` with an outcome).
5. Linear acceptance (the criteria were checked against the current head).

Idle, `agent_end` or a Herdr "done" state is telemetry. It's never accepted delivery.
Local `posted` is durable recording, separate from all native receipt states and acceptance.

## Event-driven waiting

A parent or supervisor ends its turn when only waiting remains. The next turn starts when the
native delivery path wakes it with a child's report; it doesn't hold a goal, loop on status reads
or re-prompt itself. Status reads never wake anyone. A lost or uncertain send is reconciled by
reading the registry once, never resent under a new ID.

An `operational_notice` is runtime telemetry, never the agent's `report` or a Linear
verdict. It carries a persisted assistant `stopReason=error`, the exact binding/session,
model and error evidence. On receipt, mark the work as operationally blocked pending
inspection, preserve its existing binding/worktree and pause state, and do not wait for
that failed turn to manufacture a completion report. Recovery/resumption is a separate
explicit decision; the observation does not claim native auto-recovery has finished.
Unlinked, unavailable or paused routes stay local at
`.omo/state/operational-notices/<notice-id>/<state>.json` under the control root, with a
host-log warning. The registry is authoritative; a `sending` snapshot is unresolved,
`posted` is local recording, and `accepted` means only native delivery. Reports and
operational notices are separate records. Read all operational outcomes with the read-only
`notices --project ID --json` command, even without a live manager or host. Do not forward these notices as agent results,
auto-resume a paused role, or retry uncertain delivery (`turn_conflict` included) under
fresh IDs. Ordinary idle, cancellation and reload are not error evidence.

Only an issue child may hold a goal, bounded to its explicit issue packet. It starts phase
runs through mass-ulw, ends its turn while waiting for native workflow notifications, verifies
results and reports through the normal route. A DAG finishing is neither a verified child
report nor parent/Linear acceptance. Startup alone never authorizes a goal or run.

## The CLI these roles use

The orchestrator ships as `dist/cli.js` under the control root, exported as
`OMO_INITIATIVE_ROOT`. Role worktrees don't contain it, so always invoke it by absolute path:

```sh
bun "$OMO_INITIATIVE_ROOT/dist/cli.js" <command> --json
```

Commands and flags below follow the frozen implementation contract; confirm against
`bun "$OMO_INITIATIVE_ROOT/dist/cli.js" --help` before relying on exact wording.

| Purpose | Command |
|---|---|
| Import a validated scope snapshot | `scope import --file <scope.json>` |
| Designate a supervisor (explicit) | `supervisor create --initiative ID --scope-digest SHA256 --designation ID --execute` |
| Create a standalone project parent | `parent create --scope-digest SHA256 --designation ID --execute --project ID --repo ABS_ROOT --base REF` |
| Create under an existing supervisor | `parent create --supervisor BINDING --project ID --repo ABS_ROOT --base REF` |
| Explicit management link (user operation) | `parent link --parent BINDING --supervisor BINDING`, `parent unlink --parent BINDING` |
| Create an issue child | `child create --parent BINDING --issue ID` |
| Instruct the level below | `send --from BINDING --to BINDING --id MESSAGE_ID --kind instruction --text-file brief.txt` |
| Report to the level above | `report --from BINDING --id MESSAGE_ID --outcome completed\|blocked\|failed --evidence ABS_PATH --text-file result.txt` |
| Post explicitly to the user (parent only) | `report --from BINDING --id MESSAGE_ID --outcome blocked\|failed\|completed --text-file result.txt --to-user` |
| Read without waking | `status --project ID`, `reports --project ID`, `notices --project ID` |
| Pause / resume contact | `pause --binding BINDING`, `resume --binding BINDING` |
| One explicit observation | `reconcile --project ID` (or `--initiative ID`) |

`--fixture` is mandatory when standalone approval uses a fixture snapshot. Do not combine
standalone approval flags with `--supervisor`. Project/initiative filters follow each role's
own approved scope, not a later manager link; use `--project` for a project-only parent.

A paused manager blocks new native reports to itself, not child work or explicit user posts.
A paused parent blocks new contact and user posts. Closing a manager preserves its links for
inspection and does not close/pause parents; closing a parent still requires closing its issue
children first. Unlink is available even if the manager is gone. If the runtime is lost while
stored state still says ready, native delivery may fail: inspect its receipt and use a distinct
explicit user-addressed notice for the failure/question, never silently reroute that attempt.

Output is a `Result` JSON object. Exit codes: 0 success, 2 invalid scope, 3 runtime
unavailable, 4 uncertain outcome. A message ID is chosen once and reused on retry; a changed
payload or an explicit recipient change under the same ID is a conflict, not a correction.
Accepted report replay returns the original stored recipient/receipt even after link/unlink/close;
sending/uncertain attempts stay unresolved. Only `turn_conflict_before_delivery` permits an
unchanged same-ID successor after current authorization is checked; earlier native keys and
receipts stay in `delivery.attempts`. Legacy `turn_conflict` is never treated as that proof. Reconnect and link never recreate parents or replay
work. `reports` is read-only and requires no live role or native host.
