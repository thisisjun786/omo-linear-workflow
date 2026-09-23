---
name: oi-run
description: "Execute approved Linear scope as one of three roles: a supervisor over one initiative's parents, a parent over one project's issue children, or a child over one issue. Uses the omo-initiative CLI for designation, creation, instructions and reports; no goals, no polling, native delivery wakes the next turn. Use oi-plan for planning and oi-check for drift."
---

# OI Run

Carry approved scope through delivery at exactly one level. Read
[Supervisor, parent and child](../references/roles.md) first: it fixes the three roles, their
models, who instructs whom, and the CLI. This skill never widens the role the current session
holds. Find that role with:

```sh
bun "$OMO_INITIATIVE_ROOT/dist/cli.js" status --initiative <ID> --json
```

and match the binding whose durable session ID is this session's. An unbound control session
may create the supervisor only when the user explicitly requested that designation. It must
not impersonate an existing supervisor, parent or child or execute their assigned work.

## Determine the requested operation

- **Designate a supervisor:** only an explicit request to execute a named initiative's approved
  projects. Requires an imported snapshot digest from [oi-plan](../plan/SKILL.md). A link, a
  status question, a plan request or a quoted example is not a designation.
- **Run a project or milestone:** carry its agreed scope, including successors that become
  ready, through delivery. A milestone or named batch narrows the same assignment.
- **Status only:** read the registry and Linear without waking anyone.
- **Verify completed work:** use [oi-check](../check/SKILL.md) and route corrections through
  the existing owner.

Explicit read-only, plan-only, no-create, no-merge, pause or no-contact limits win over the
default and travel down without widening. Each outward step (create, send) is gated on those
limits at that moment; a step a limit forbids is returned prepared and unsent, named as unsent.

## Supervisor

Bind three things: the initiative ID and the body revision the finish condition was read from,
the approved project set by stable ID, and the completion boundary. Membership comes from the
designation; a project linked later is outside the set until a new designation admits it.

```sh
bun "$OMO_INITIATIVE_ROOT/dist/cli.js" supervisor create --initiative <ID> --scope-digest <SHA256> --designation <ID> --execute --json
bun "$OMO_INITIATIVE_ROOT/dist/cli.js" parent create --supervisor <BINDING> --project <ID> --repo <ABS_ROOT> --base <REF> --json
bun "$OMO_INITIATIVE_ROOT/dist/cli.js" send --from <SUPERVISOR> --to <PARENT> --id <MESSAGE_ID> --kind instruction --text-file brief.txt --json
```

Reuse before creating: a project that already has a parent keeps it, and a live child keeps
its issue. The brief to a parent names the project ID, the snapshot digest, the delivery limits
and where its report goes. The supervisor coordinates cross-project dependencies, priority and
the order in which projects land on a shared target. It holds no checkout, merges nothing,
never addresses a child, and returns a project's finding to that project's parent.

## Parent

Own one project on its integration worktree. Read the project's issues and full criteria from
Linear, pick the ready batch by dependency order, and create one child per independent issue:

```sh
bun "$OMO_INITIATIVE_ROOT/dist/cli.js" child create --parent <BINDING> --issue <ID> --json
bun "$OMO_INITIATIVE_ROOT/dist/cli.js" send --from <PARENT> --to <CHILD> --id <MESSAGE_ID> --kind instruction --text-file packet.txt --json
```

The child's base branch comes from the registry, not the packet. The packet carries the issue
ID, the criteria verbatim, the integration branch, the delivery limits, what evidence to return
and how to report. Creation returns readiness separately from execution state; a created child
has done nothing yet.

When a child's report arrives, verify before integrating: compare the reported head and
evidence against the criteria at that head, re-read the base, and merge into the project
branch only when they hold. Return an in-scope correction to the same child with the violated
criterion, reviewed revision, evidence and required outcome. New scope or a real contradiction
in the criteria goes up, not to the child. Serialize integrations that share a target and
verify each landing. Release and deployment stay with the user.

When the project's agreed scope is delivered, integrated and reconciled:

```sh
bun "$OMO_INITIATIVE_ROOT/dist/cli.js" report --from <PARENT> --id <MESSAGE_ID> --outcome completed --evidence <ABS_PATH> --text-file result.txt --json
```

Use `blocked` or `failed` when that's the truth. A report is this parent's claim; the
supervisor judges it.

## Child

Own one issue on a worktree forked from the parent's branch. Implement against the criteria in
the packet, run the repository's checks, commit on the branch, and push or open a PR only where
the packet allows. Never merge, never touch the parent branch, never write Linear records, and
never contact anyone but the parent. Then report:

```sh
bun "$OMO_INITIATIVE_ROOT/dist/cli.js" report --from <CHILD> --id <MESSAGE_ID> --outcome completed --evidence <ABS_PATH> --text-file result.txt --json
```

`result.txt` names the head commit, the branch, each criterion with its evidence, what's
unverified, and anything left running or on disk. Blocked on a decision only a person can
make is `blocked` with the exact question; a check that failed and can't be fixed in scope is
`failed`. Ending the turn is not a report.

## Waiting and recovery

After sending instructions, end the turn when only waiting remains. The child's `report`
wakes this session through native delivery; don't poll `status`, hold a goal or re-prompt
yourself. On any wake, re-read your own outstanding assignments from `status` before acting on
the payload that woke you, so events that arrived mid-turn aren't lost.

Choose each message ID once. Retrying an uncertain send reuses the same ID and text; exit 4
means uncertain, and the answer is one `reconcile`, never a resend under a new ID. Pause a
child with `pause` to stop contact; `resume` restores contact without starting a turn.

Report five facts separately: sent, runtime ready, natively accepted, reported complete,
Linear accepted. Idle sessions and Herdr "done" states are none of them. On resume, restate
the fixed binding, approved scope, current owner of each live piece of work and the one next
action from the registry before creating or sending anything.
