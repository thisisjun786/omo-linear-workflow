---
name: olw-run
description: "Execute approved Linear scope as one of four roles: an optional manager or supervisor over linked parents, an independently approved parent over one project's issue children, or a child over one issue in direct, planned or research mode. Uses the omo-linear-workflow CLI for designation, creation, instructions, questions, stage hand-offs and reports; issue children execute with mass-ulw, planned children first plan with ulw-plan, and parents and managers wait on native delivery without goal loops or polling. Use olw-plan for planning and olw-check for drift."
---

# OLW Run

Carry approved scope through delivery at exactly one level. Read
[Supervisor, parent and child](../references/roles.md) first: it fixes the roles, their
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

Add `--fixture` only for a fixture snapshot. When a ready manager exists (see
[Manager](#manager)), the new parent is linked to it automatically; pass `--no-manager` to
stay unlinked. The parent receives its initial brief by direct
prompt and waits for explicit instructions in that same durable session. Its project/issue
approval remains its own. A user can later link an initialized parent to a ready management
session, even under a different designation. For a supervisor, its snapshot must include the
project; the scope-free manager has no such membership check:

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
Linear, pick the ready batch by dependency order, and create one child per independent issue.
Choose the child's mode at creation; the child never switches it:

```sh
bun "$OMO_INITIATIVE_ROOT/dist/cli.js" child create --parent <BINDING> --issue <ID> --mode planned --json
bun "$OMO_INITIATIVE_ROOT/dist/cli.js" send --from <PARENT> --to <CHILD> --id <MESSAGE_ID> --kind instruction --text-file packet.txt --json
```

- `direct` (default): small, well-specified development work. One session, mass-ulw.
- `planned`: large or ambiguous development work with open design decisions or cross-module
  changes. A plan stage (Fable 5.1, ulw-plan) writes and gets one plan approved, then an
  execute stage (Opus 5.5 medium, ulw-execute driving mass-ulw) implements it.
- `research`: the deliverable is findings, not code. One session, ulw-research.

A packet whose mode disagrees with the child's mode yields a `blocked` report without work.
If a plan stage finds no plan is needed, it reports `blocked` with the reason
`no_plan_needed`. The parent then closes that generation (`close --binding <plan or execute
binding>`) and creates a new child with `--mode direct`; the registry allows one live owner per
issue.

The child's base branch comes from the registry, not the packet. The packet carries the issue
ID/key, `deliverable: pr | report | document`, the criteria verbatim, the integration branch, allowed write scope, delivery limits, an
absolute evidence directory, and what evidence to return. Its envelope ID identifies this
packet; the child uses `report:<packet-id>` for its single final report. Creation of a
`direct` child selects mass-ulw mode (plan, execute and research stages select their own
skills) but returns readiness separately from execution: a created child has done
nothing yet. Only an explicit issue packet starts work. `child create --mode research` defaults
to `report`; direct/planned default to `pr`. Select `--deliverable document` for a document.
The immutable binding, brief, instruction envelope and `status` carry this choice; the packet
must agree. A planned child's execute stage inherits it; plan handoff is not final delivery.

### Answering questions and approving plans

A child's `question` delivery wakes the parent. Decide first, from the criteria, accepted
Linear decisions and repository evidence, then answer the exact question ID:

```sh
bun "$OMO_INITIATIVE_ROOT/dist/cli.js" answer --from <PARENT> --question <QUESTION_ID> --text-file answer.txt [--answers-file answers.json] --json
```

One question gets one answer; `answer:<question-id>` is deduplicated like a report. The
plan stage's approval request arrives as a question too. Review the plan at the reported
head against the criteria and approve it yourself, or answer with the changes you need.
Escalate only what you can't decide (scope changes, contradictions in the criteria, product
choices, anything needing the user's authority):

```sh
bun "$OMO_INITIATIVE_ROOT/dist/cli.js" ask --from <PARENT> --id <MESSAGE_ID> --text-file question.txt [--questions-file questions.json] --json
```

The question goes to the ready linked manager, or to the local user inbox when there is
none (`--to-user` selects the inbox explicitly). End the turn; the answer arrives as a
delivery. Relay the answer down to the child with `answer`; never widen it.

After approving a plan, the plan stage runs `stage complete` and reports. Then start the
execute stage in the same worktree:

```sh
bun "$OMO_INITIATIVE_ROOT/dist/cli.js" stage start --from <PLAN_BINDING> --parent <PARENT> --stage execute --id <MESSAGE_ID> --json
```

This stops the plan session, opens the execute tab in the child workspace and returns a
new binding ID for the execute stage. Address that binding from now on; the issue keeps one
live owner. Nothing from the original packet transfers: the execute brief carries only
`plan_path` and `plan_head`. Send the issue packet again to the execute binding with `send`
(criteria, limits, evidence directory, plan path). That packet's envelope ID is the packet
ID the execute stage reports under (`report:<packet-id>`). Only an explicit packet starts
work.

If `stage start` is interrupted and the execute binding becomes `uncertain`, do not resend, send the packet directly to its local-only TUI, or invent a new message ID. Neither `stage start` nor `reconcile` relaunches it, because native queued input may have existed only in the lost runtime's memory. Inspect the exact pane and checkout, then explicitly `close --binding <EXECUTE_BINDING>` (using `--discard` only after checking unpublished work). Close verifies the workspace, pane and durable session before stopping it, preserves the old session file and attempt history, and retires only the abandoned execute edge. Re-run the original `stage start` command to reserve a fresh execute binding.

When a child's report arrives, verify before integrating: compare the reported head and
evidence against the criteria at that head, re-read the base, and merge into the project
branch only when they hold. Return an in-scope correction to the same child with the violated
criterion, reviewed revision, evidence and required outcome. New scope or a real contradiction
in the criteria goes up, not to the child. Serialize integrations that share a target and
verify each landing. Release and deployment stay with the user.

For an **owned-clone parent**, each `pr` child delivers one PR into the integration branch.
Review its body, verbatim criteria and evidence at the reported head, then use:

```sh
bun "$OMO_INITIATIVE_ROOT/dist/cli.js" pr merge --from <PARENT> --pr <URL_OR_NUMBER> --json
```

The helper requires the accepted child's reported head, uses a merge commit with a head-match
guard, fetches and fast-forwards the parent clone, then pushes the integration branch without
force. Do not locally merge these child branches. `report`/`document` results require artifact
review, not a PR. **Deprecated legacy `--repo` parents** keep the existing local-merge flow.

When the project's agreed scope is delivered, integrated and reconciled, an owned parent opens
its integration-to-default-branch PR and stops for the user; it never merges that final PR:

```sh
bun "$OMO_INITIATIVE_ROOT/dist/cli.js" pr open --from <PARENT> --base <DEFAULT_BRANCH> --body-file project-result.md --json
```

Then report the project PR URL (legacy parents report their local integration result):

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

Own one issue on a worktree forked from the parent's branch. The brief names your stage:
`direct`, `plan`, `execute` or `research`. Every stage shares these rules:

- Your user is the parent. Prose in the pane reaches nobody. Ask with the `olw_ask` tool
  (up to 4 questions per call, with options and a recommended default), then end the turn;
  the answer arrives as a delivery and wakes you. Native `ask_user_question` is blocked in
  bound roles and points you to `olw_ask`.
- A packet whose mode disagrees with your stage is a `blocked` report without work.
- Never merge, touch the parent branch or write Linear records.

**plan stage** (Fable 5.1, ulw-plan): run the ulw-plan procedure in the issue worktree and
write the plan at the `plan_path` in your brief. Run plan-reviewer rounds as ulw-plan
requires. Where ulw-plan waits for the user's okay, ask the parent with `olw_ask` instead.
On approval, commit the plan and hand off:

```sh
bun "$OMO_INITIATIVE_ROOT/dist/cli.js" stage complete --from <PLAN_BINDING> --plan <ABS_PLAN_PATH> --head <SHA> --id <MESSAGE_ID> --text-file handoff.txt --json
```

The plan must be inside the worktree and `--head` must equal the worktree HEAD. The command
records the hand-off (path, digest, head) and sends it as a completed report. End the turn;
the parent starts the execute stage. Do not implement.

**execute stage** (Opus 5.5 medium, ulw-execute + mass-ulw): the brief carries `plan_path`
and `plan_head`, nothing from the plan stage's packet. Wait for the parent's issue packet to
this binding; it names the criteria, limits and evidence directory. Run ulw-execute on the
plan; its phases drive mass-ulw under the contract below. Report once with
`report:<packet-id>`, where the packet ID is that packet's envelope ID.

**research stage** (Opus 5.5 xhigh, ulw-research): the deliverable is findings. Collection
may run as mass-ulw waves inside the same session.

**direct stage** (Opus 5.5 medium, mass-ulw): startup selects `mass-ulw` mode
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

Never merge, modify the parent branch or write Linear records. Among OLW roles, contact only
the parent. For `deliverable: pr` under an **owned-clone parent**, commit verified issue work,
then push the child branch to `origin` and open exactly one PR into the parent's integration
branch using the helper. The PR body must contain the issue key, the criteria verbatim and
criterion-by-criterion evidence. The helper publishes the integration base if necessary, never
force-pushes, and returns an existing open PR instead of duplicating it. Report once through
the existing route with the returned URL and head SHA, never from an internal node:

```sh
bun "$OMO_INITIATIVE_ROOT/dist/cli.js" pr open --from <CHILD> --body-file pr-body.md --json
bun "$OMO_INITIATIVE_ROOT/dist/cli.js" report --from <CHILD> --id report:<PACKET_ID> --outcome completed --pr <URL> --head <SHA> --evidence <ABS_PATH> --text-file result.txt --json
```

For `report`/`document`, do not push and do not open a PR. Return an explicit evidence file
path or existing Linear document URL with `--deliverable-path <PATH_OR_URL>` instead of
`--pr/--head`. If code changes are needed, propose a new direct issue to the parent, not an
implementation under the research/document assignment. The child does not write Linear.
For deprecated legacy parents, omit these PR flags and return the local head for parent merge.
A plan stage uses `stage complete`, not `pr open` or a final PR report. If delivery limits forbid
publication, report blocked; do not silently claim completion without the required deliverable.

`result.txt` names the head commit, the branch, each criterion with its evidence, what's
unverified, and anything left running or on disk. Blocked on a decision only a person can
make is `blocked` with the exact question; a check that failed and can't be fixed in scope is
`failed`. Ending the turn is not a report.

## Manager

The manager is the session the user directs. It isn't bound to an initiative or project and
may manage several parents. Open it (or reattach to the existing one) with:

```sh
bun "$OMO_INITIATIVE_ROOT/dist/cli.js" manage --json
```

It runs inside the OLW host in a Herdr workspace with the user's default model. Parents
created while it's ready link to it automatically (`parent create` without `--no-manager`),
and their questions and reports arrive there natively. A manager link grants contact only;
each parent's approval stays on its own designation.

On a parent's question: answer what the criteria and accepted decisions settle, and ask the
user the rest in this session. By policy the manager is the role that asks the user
directly (the runtime blocks native asks only in bound children and parents). Reply by
question ID:

```sh
bun "$OMO_INITIATIVE_ROOT/dist/cli.js" answer --from <MANAGER> --question <QUESTION_ID> --text-file answer.txt --json
```

Questions that reached the user inbox instead (no ready manager, or `ask --to-user`) are
listed with `questions --project <ID> --json`, which wakes nobody. The user answers them
without a binding:

```sh
bun "$OMO_INITIATIVE_ROOT/dist/cli.js" answer --as-user --question <QUESTION_ID> --text-file answer.txt --json
```

Instruct linked parents with `send --kind instruction`; never address a child. Close with
`close --binding <MANAGER>`; parents keep working and keep their links for inspection.

### Updates

`manage` runs an update check at start and puts the result in the manager brief as an
`update_check` line (or `unavailable; run olw update check` when the check couldn't run).
`olw update check [--json] [--tag pkg=tag]` reports the pinned OMO and
Senpi versions against the npm dist-tags (`omo-ai` `beta`, `@code-yeongyu/senpi` `latest`)
and never installs anything. When newer versions exist, `olw update prepare [--remote NAME|URL] [--json]`
creates an update branch `olw/update-omo-<v>-senpi-<v>` from the selected remote's `dev`
(`--remote` picks a GitHub remote to fetch from and push to; default `origin`; non-GitHub remotes are refused) in a separate
worktree, runs install, typecheck, test and build there, and opens a PR to `dev` (a draft
if anything failed). It never merges and never touches the live host. Merging and
reinstalling remain the user's decision.

## Waiting and recovery

After sending instructions, end the turn when only waiting remains. A child's `report` or
`question` wakes its parent through native delivery; a parent's native report or question
wakes its linked manager or supervisor, and an `answer` wakes the role that asked.
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
