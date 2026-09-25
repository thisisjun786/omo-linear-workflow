---
name: olw-run
description: "Execute approved Linear scope as one of three roles: an optional supervisor over one initiative's linked parents, an independently approved parent over one project's issue children, or a child over one issue. Uses the omo-linear-workflow CLI for designation, creation, instructions and reports; issue children execute with mass-ulw, while parents and supervisors wait on native delivery without goal loops or polling. Use olw-plan for planning and olw-check for drift."
---

# OLW Run

Carry approved scope through delivery at exactly one level. Read
[Supervisor, parent and child](../references/roles.md) first: it fixes the three roles, their
models, who instructs whom, and the CLI. This skill never widens the role the current session
holds. Find that role with:

```sh
bun "$OMO_INITIATIVE_ROOT/dist/cli.js" status --project <ID> --json
```

and match the binding whose durable session ID is this session's. An unbound control session
may create a standalone parent or an optional supervisor only when the user explicitly
requested that scope's execution/designation. Use `status --initiative` for a supervisor. It must
not impersonate an existing supervisor, parent or child or execute their assigned work.

## Determine the requested operation

- **Designate a supervisor:** only an explicit request to execute a named initiative's approved
  projects. Requires an imported snapshot digest from [olw-plan](../plan/SKILL.md). A link, a
  status question, a plan request or a quoted example is not a designation.
- **Run a project or milestone:** start an independently approved parent; no supervisor or
  initiative is required. Carry only its approved issues, including successors that become
  ready, through delivery. A milestone or named batch narrows the same assignment.
- **Status only:** read the registry and Linear without waking anyone.
- **Verify completed work:** use [olw-check](../check/SKILL.md) and route corrections through
  the existing owner.

Explicit read-only, plan-only, no-create, no-merge, pause or no-contact limits win over the
default and travel down without widening. Each outward step (create, send) is gated on those
limits at that moment; a step a limit forbids is returned prepared and unsent, named as unsent.

## Standalone parent

Import an approved snapshot containing the project and its approved issues. Use
`initiative: null` when there is no initiative; never create a placeholder or hidden supervisor.
The user-authorized control session creates the project parent explicitly:

```sh
bun "$OMO_INITIATIVE_ROOT/dist/cli.js" parent create --scope-digest <SHA256> --designation <ID> --execute --project <ID> --repo <ABS_ROOT> --base <REF> --json
```

Add `--fixture` only for a fixture snapshot. The parent receives its initial brief by direct
prompt and waits for explicit instructions in that same durable session. Its project/issue
approval remains its own. A user can later link an initialized parent to a ready management
session whose snapshot includes the project, even under a different designation:

```sh
bun "$OMO_INITIATIVE_ROOT/dist/cli.js" parent link --parent <PARENT> --supervisor <SUPERVISOR> --json
bun "$OMO_INITIATIVE_ROOT/dist/cli.js" parent unlink --parent <PARENT> --json
```

These are user operations, not a role's way to escape its assignment. They preserve the
binding, pause state, linked Git worktree and issue scope. They send no prompt, recreate no
role and replay no work. Use `status --project` for current management state, not an old brief's
initial link. Both approvals must permit execution and contact; the manager cannot add issues
to the parent's approval through a link or an instruction.

## Supervisor (optional)

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
ID, the criteria verbatim, the integration branch, allowed write scope, delivery limits, an
absolute evidence directory, and what evidence to return. Its envelope ID identifies this
packet; the child uses `report:<packet-id>` for its single final report. Creation selects
mass-ulw mode but returns readiness separately from execution: a created child has done
nothing yet. Only an explicit issue packet starts work.

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

Use `blocked` with the exact user question or `failed` with the failure and evidence when
that's the truth. A report is this parent's claim, not manager/user/Linear acceptance.
Without a ready manager the report is recorded in the local user inbox. A ready linked
manager receives native delivery; its pause is honored. The parent may explicitly post to
the user instead, including when the linked manager is paused or its runtime has disappeared:

```sh
bun "$OMO_INITIATIVE_ROOT/dist/cli.js" report --from <PARENT> --id <USER_NOTICE_ID> --outcome blocked --text-file question.txt --to-user --json
bun "$OMO_INITIATIVE_ROOT/dist/cli.js" reports --project <ID> --json
```

`posted` with `receipt: null` means durable recording only, not native acceptance or user
acknowledgment. End the turn after posting; the user reads `reports` or the parent's final
message and answers by prompting the parent's exact session. No fake user binding, polling
or automatic notification is implied. Parent pause blocks new posts; manager pause does not.
If a native attempt was already claimed, do not change its recipient or resend an accepted/uncertain outcome. A distinct
user notice must identify that attempt and its unresolved state, not claim it was delivered.

## Child

Own one issue on a worktree forked from the parent's branch. Startup selects `mass-ulw` mode
and the `olw-run` and `mass-ulw` execution skills; it does not create a goal, run or worker.
Wait for the parent's explicit issue packet. Check its issue ID against the binding and read
its full criteria and limits. If they disagree, report `blocked` without launching work.
Fixture standby still forbids live Linear access and autonomous work; only an explicit fixture
packet can authorize internal workflow nodes, never additional OLW roles or direct
`thread_create` calls.

Load the installed `mass-ulw` skill and its complete planning reference before defining a graph.
It owns native DAG syntax, category routing and recovery. Apply these OLW boundaries:

1. Register one goal for this packet's assigned issue, with the criteria and independent
   artifact/check verification. Reuse it across phases; never create a goal per node or expand
   it to the project. If the packet supplies no evidence directory, use
   `$OMO_INITIATIVE_ROOT/.omo/evidence/olw/<binding-id>/<packet-id>/`.
2. Start one native workflow run per phase, keyed `olw:<binding-id>:<packet-id>:p<n>`, and retain
   its actual `run_id`. Workers use the child's checkout or native task isolation derived from
   it, with absolute artifact paths and disjoint write scopes. They are category workers, not
   OLW/Linear owners. Each self-contained English node prompt starts with `TASK:` and names
   `DELIVERABLE`, `SCOPE`, `VERIFY` and `STOP WHEN`. Workers must not invoke the OLW CLI, create
   roles, delegate further, open goals, contact Linear or other roles, merge, commit, push or open
   a PR. The child remains responsible for the work and any authorized commit.
3. Include a verification node depending on the producers, using the repository's real checks
   and artifacts. Dependency edges only order work: pass artifact paths explicitly. Start
   returns immediately; node and settlement notifications resume the same packet. End the
   turn while only waiting remains. Do not poll snapshots or keep a cell blocked on `wait`.
4. Treat node/run completion as a claim. Inspect actual artifacts and check outputs yourself.
   Recover in the same run with `retry`, `amend` or `send` as the native skill specifies;
   completed-but-wrong work needs `amend`, not a fresh run key. Preserve valid completed work.
   A missing artifact, failed check or blocked node is not completed issue delivery.
5. Record binding/issue/packet IDs, the goal, each run key/ID, node states and attempts, artifact
   paths, checks and results, recovery actions, head and branch in `evidence.json`. Implement
   and commit only within the packet's permissions; push or open a PR only if it allows.
   Recheck the head and evidence before reporting once with `report:<packet-id>`. Complete
   the issue goal after verified delivery, not after the last node finishes. Parent acceptance
   is separate and is not part of the child's goal. A later correction packet reuses the
   existing issue owner and applicable run evidence; it is not a reason to duplicate workers.

Never merge, touch the parent branch or write Linear records. Among OLW roles, contact only
the parent. Report through the existing claimed route, never directly from an internal node:

```sh
bun "$OMO_INITIATIVE_ROOT/dist/cli.js" report --from <CHILD> --id <MESSAGE_ID> --outcome completed --evidence <ABS_PATH> --text-file result.txt --json
```

`result.txt` names the head commit, the branch, each criterion with its evidence, what's
unverified, and anything left running or on disk. Blocked on a decision only a person can
make is `blocked` with the exact question; a check that failed and can't be fixed in scope is
`failed`. Ending the turn is not a report.

## Waiting and recovery

After sending instructions, end the turn when only waiting remains. A child's `report`
wakes its parent through native delivery; a parent's native report wakes its linked supervisor.
Local user posts wake nobody. Parents and supervisors must not poll `status`, hold a goal
or re-prompt themselves. A child's packet-bound execution goal is the sole exception: native
workflow notifications resume its active phase, without polling or starting unrelated work.
On any wake, re-read your own outstanding assignments from `status` before acting on the
payload that woke you, so events that arrived mid-turn aren't lost.

Only `turn_conflict_before_delivery` permits a successor attempt: repeat the same logical ID and unchanged payload, keep `delivery.attempts`, and never substitute a fresh logical ID. The CLI reports `recovery: retry_same_id`; legacy `turn_conflict` is not sufficient proof. Operational notices are not ordinary agent reports and are never retried this way.

Choose each message ID once. Retrying an uncertain send reuses the same ID and text; exit 4
means uncertain, and the answer is one `reconcile`, never a resend under a new ID. Pause a
child with `pause` to stop contact; `resume` restores contact without starting a turn.

Manager loss/close/unlink does not pause parents or children. A manager can close while
parents remain active; parents close only after their issue children. Reconnect/link creates
no duplicate parent and replays no accepted or uncertain delivery. Same-ID report reads retain
the original recipient across management changes; `reports` remains available without a host.

Report facts separately: sent, runtime ready, natively accepted, locally posted, reported
complete, Linear accepted. Idle sessions and Herdr "done" states are none of them. On resume, restate
the fixed binding, approved scope, current owner of each live piece of work and the one next
action from the registry before creating or sending anything.
