# Supervisor, parent and child

Shared role contract for `olw-define`, `olw-plan`, `olw-run` and `olw-check`. Adapted from
the CRW `integrations.md`, `initiative-supervision.md` and `operations.md` policy at the
pinned revision named in [NOTICE.md](../NOTICE.md). This file describes policy the
skills follow. The orchestrator enforces routes and ownership in code; nothing written
here is itself an enforcement, and Linear permissions aren't enforced by these skills.

## One task, one Linear level, one role

| Role | Bound to | Model / reasoning | Workspace | Instructs | Reports to |
|---|---|---|---|---|---|
| Supervisor | one initiative ID | `cliproxyapi/gpt-6-astra` / `high` | Herdr workspace at the control root, no implementation branch | its project parents only | the user |
| Parent | one project ID | `cliproxyapi/claude-opus-5-5` / `xhigh` | Herdr worktree on the project integration branch | its own issue children only | its supervisor |
| Child | one issue ID | `cliproxyapi/claude-opus-5-5` / `xhigh` | Herdr worktree forked from its parent's branch | nobody | its parent |

A task holds exactly one live scope in exactly one role. A parent doesn't also supervise, and a
supervisor holds no checkout and merges nothing. Peer parents may coordinate directly, but neither
assigns the other's work; a supervisor settles only what the pair can't settle alone.

Identity is the stable ID: the Linear initiative, project or issue ID plus the durable OMO
session ID recorded in the registry. A title, folder, branch, pane, chat link or display name
makes no role and moves no ownership. Don't route by the focused pane or a working directory.

## Definition is not execution approval

Defining or planning an initiative creates no supervisor and moves no project. Importing a
scope snapshot is also not designation. A supervisor exists only after an explicit designation
naming the initiative, recorded with the snapshot digest it was approved against and its
`execute`, `create` and `contact` permissions. An initiative link carried as context changes
nothing. Scope changes need a fresh designation; imported membership never expands itself.

The approved project set is fixed at designation. A project linked to the initiative later is
outside the set until a new designation admits it.

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

Each level instructs the level directly below it and reports to the level directly above it.
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

## No goals, no polling

A parent or supervisor ends its turn when only waiting remains. The next turn starts when the
native delivery path wakes it with a child's report; it doesn't hold a goal, loop on status reads
or re-prompt itself. Status reads never wake anyone. A lost or uncertain send is reconciled by
reading the registry once, never resent under a new ID.

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
| Create a project parent | `parent create --supervisor BINDING --project ID --repo ABS_ROOT --base REF` |
| Create an issue child | `child create --parent BINDING --issue ID` |
| Instruct the level below | `send --from BINDING --to BINDING --id MESSAGE_ID --kind instruction --text-file brief.txt` |
| Report to the level above | `report --from BINDING --id MESSAGE_ID --outcome completed\|blocked\|failed --evidence ABS_PATH --text-file result.txt` |
| Read without waking | `status --initiative ID` |
| Pause / resume contact | `pause --binding BINDING`, `resume --binding BINDING` |
| One explicit observation | `reconcile --initiative ID` |

Output is a `Result` JSON object. Exit codes: 0 success, 2 invalid scope, 3 runtime
unavailable, 4 uncertain outcome. A message ID is chosen once and reused on retry; a changed
payload under the same ID is a conflict, not a correction.
