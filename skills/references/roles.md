# Supervisor, parent and child

Shared role contract for `olw-define`, `olw-plan`, `olw-run` and `olw-check`. Adapted from
the CRW `integrations.md`, `initiative-supervision.md` and `operations.md` policy at the
pinned revision named in [NOTICE.md](../NOTICE.md). This file describes policy the
skills follow. The orchestrator enforces routes and ownership in code; nothing written
here is itself an enforcement, and Linear permissions aren't enforced by these skills.

## One task, one Linear level, one role

| Role | Bound to | Model / reasoning | Workspace | Instructs | Reports to |
|---|---|---|---|---|---|
| Manager (the session the user directs, `olw`) | nothing fixed; linked parents | the user's default model from `~/.omo/agent/settings.json` (fallback `opencodex/anthropic/claude-opus-5-5` / `medium`) | Current Herdr pane (`manage` can create a control-root workspace), no fixed implementation branch | its linked parents only | the user, directly in its own TUI |
| Supervisor (optional management session) | one initiative ID | `opencodex/gpt-6-astra` / `high` | Herdr workspace at the control root, no implementation branch | its project parents only | the user |
| Parent | one project ID | `opencodex/anthropic/claude-opus-5-5` / `xhigh` | Herdr worktree on the project integration branch | its own issue children only | linked manager/supervisor or local user inbox |
| Child, `direct` stage | one issue ID | `opencodex/anthropic/claude-opus-5-5` / `xhigh` | Herdr worktree forked from its parent's branch | internal mass-ulw workers, no OLW roles | its parent |
| Child, `plan` stage (`--mode planned`) | one issue ID | `opencodex/anthropic/claude-fable-5-1` / `xhigh` | the same issue worktree, its own Herdr tab | nobody; ulw-plan only | its parent (plan approval as a question, then `stage complete`) |
| Child, `execute` stage (`--mode planned`) | one issue ID | `opencodex/anthropic/claude-opus-5-5` / `medium` | the same issue worktree, a second Herdr tab | internal mass-ulw workers through ulw-execute | its parent (the packet sent to this binding) |
| Child, `research` stage | one issue ID | `opencodex/anthropic/claude-opus-5-5` / `xhigh` | Herdr worktree forked from its parent's branch | internal mass-ulw workers, no OLW roles | its parent |

A project parent is the execution unit; it needs neither an initiative nor a supervisor.
No hidden supervisor is created. Mapped parents own independent clones; their children are
linked worktrees of those clones. Deprecated `--repo` parents retain the legacy linked-worktree
layout and local merges. Management links do not change branches or ancestry. A planned child's
stages share one worktree and one branch; each stage is its own binding and durable
session, and only one stage is live at a time.

A task holds exactly one live scope in exactly one role. A parent doesn't also supervise, and a
supervisor holds no checkout and merges nothing. Peer parents sharing an approved designation
and non-null initiative may coordinate directly, but neither assigns the other's work. Escalate
unresolved decisions to the linked supervisor or the user.

Identity is the stable ID: the Linear initiative, project or issue ID plus the durable OMO
session ID recorded in the registry. A title, folder, branch, pane, chat link or display name
makes no role and moves no ownership. Don't route by the focused pane or a working directory.

A child starts in the stage its mode selects (`child create --mode direct|planned|research`,
default `direct`) but waits for an explicit issue packet. Its native workflow
nodes are implementation workers, not another hierarchy level or registry owner. They use
category routing rather than the child role's fixed model assignment. The child owns their
scope, phase runs, verification and final report; the parent still owns acceptance and
integration. The [child execution contract](../run/SKILL.md#child) defines the goal, keys,
worker limits, evidence and recovery. These are execution instructions, not a filesystem
sandbox or new permission enforcement in the native DAG engine.

The manager is a scope-free management role, not a launcher identity. Type `olw` in Herdr
(or `olw manage --here`) to attach it in the current pane; a live manager is focused instead.
`olw manage` retains the separate-workspace entry. The durable session is never replaced by
an unrelated session. Outside OLW message handling it is a normal assistant. For an OLW
notice, inspect `olw reports` or `olw questions --project ID`, answer with `olw answer`,
review evidence within existing approval, and escalate decisions beyond that approval to
the user. Reports and questions arrive only at idle, as a one-line notice plus the envelope.
It holds a fixed designation, not an initiative or project. A parent created
while the manager is ready links to it unless `--no-manager` is passed. The link grants
contact, never approval, exactly like `parent link`.

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
Linear record and never merges; it delivers and reports. Each owned-clone issue with
`deliverable: pr` pushes to origin and opens one PR into its parent's integration branch,
including issue key, verbatim criteria and evidence, then reports its URL and head SHA once.
The parent reviews that exact head and runs `pr merge --from PARENT --pr URL` (merge commit,
fetch, fast-forward and non-force push), not a local child merge. The project's final PR goes
from integration to the default branch and stops for user review; the parent never merges it.
`research` defaults to `report`; direct/planned default to `pr`. `--deliverable document`
selects a document. PR-less children never push/open PRs and report a deliverable path or
existing Linear document URL; code changes require proposing a new direct issue to the parent.
Legacy parents keep local integration unchanged. A supervisor writes the initiative's
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

Questions go up and answers come back down the same path, by question ID:

| Kind | Route | Meaning |
|---|---|---|
| `question` | child -> parent; parent -> manager/supervisor, or the user inbox when none is ready or with `--to-user` | one blocking question (up to 4 sub-questions with options); the sender ends its turn and waits |
| `answer` | parent -> child; manager/supervisor -> parent; the user -> a posted inbox question (`answer --as-user`) | the answer to exactly one question ID, id `answer:<question-id>`, deduplicated like a report |

A child asks through the `olw_ask` tool, which the OLW extension registers in bound child
and parent sessions; native `ask_user_question` is blocked there. The parent decides first
and escalates only what needs the manager's or the user's authority. By policy the manager
is the role that asks the user directly; the runtime blocks native asks in bound children
and parents only. A plan stage's approval request and its `stage complete`
hand-off are a question and a completed report on this same path.

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
| Check the installation | `doctor` |
| Open or reattach the manager session (user operation) | `manage` |
| Import a validated scope snapshot | `scope import --file <scope.json>` |
| Designate a supervisor (explicit) | `supervisor create --initiative ID --scope-digest SHA256 --designation ID --execute` |
| Create a standalone project parent | `parent create --scope-digest SHA256 --designation ID --execute --project ID --repo ABS_ROOT --base REF [--no-manager]` |
| Create under an existing supervisor | `parent create --supervisor BINDING --project ID --repo ABS_ROOT --base REF` |
| Explicit management link (user operation) | `parent link --parent BINDING --supervisor BINDING`, `parent unlink --parent BINDING` |
| Create an issue child | `child create --parent BINDING --issue ID [--mode direct\|planned\|research] [--deliverable pr\|report\|document]` |
| Hand off an approved plan (plan stage) | `stage complete --from PLAN_BINDING --plan ABS_PATH --head SHA --id MESSAGE_ID --text-file handoff.txt` |
| Start the execute stage (parent) | `stage start --from PLAN_BINDING --parent PARENT_BINDING --stage execute --id MESSAGE_ID` |
| Open an owned-clone issue PR | `pr open --from CHILD --body-file FILE [--title TITLE] [--draft]` |
| Integrate a reviewed child PR | `pr merge --from PARENT --pr URL_OR_NUMBER` |
| Open the project PR, never merge it | `pr open --from PARENT --base DEFAULT_BRANCH [--body-file FILE]` |
| Instruct the level below | `send --from BINDING --to BINDING --id MESSAGE_ID --kind instruction --text-file brief.txt` |
| Report to the level above | `report --from BINDING --id MESSAGE_ID --outcome completed\|blocked\|failed --evidence ABS_PATH --text-file result.txt [--pr URL --head SHA \| --deliverable-path PATH_OR_URL]` |
| Post explicitly to the user (parent only) | `report --from BINDING --id MESSAGE_ID --outcome blocked\|failed\|completed --text-file result.txt --to-user` |
| Ask the level above (parent only; children use the `olw_ask` tool) | `ask --from BINDING --id ID --text-file question.txt [--questions-file JSON] [--to-user]` |
| Answer one question | `answer --from BINDING --question QUESTION_ID --text-file answer.txt [--answers-file JSON]`, or `answer --as-user ...` for a posted inbox question |
| Read without waking | `status --project ID`, `reports --project ID`, `questions --project ID`, `notices --project ID` |
| Pause / resume contact | `pause --binding BINDING`, `resume --binding BINDING` |
| Close a role | `close --binding BINDING [--confirm-absent]` |
| One explicit observation | `reconcile --project ID` (or `--initiative ID`) |
| Check for OMO/Senpi updates (never installs) | `update check [--json] [--tag pkg=tag]` |
| Prepare an update PR in a separate worktree (GitHub remote only; never merges) | `update prepare [--remote NAME\|URL] [--json]` |
| List known repository mirrors | `repo list [--json]` |
| Create or fetch one repository mirror | `repo fetch --remote URL [--json]` |

`--fixture` is mandatory when standalone approval uses a fixture snapshot. Do not combine
standalone approval flags with `--supervisor`. Project/initiative filters follow each role's
own approved scope, not a later manager link; use `--project` for a project-only parent.
`status` shows a child's `mode`, current `stage`, `stageBindings` and `openQuestions`. Both
are generation-scoped: each re-creation of an issue starts a new lineage generation, an old
row keeps reporting its own generation, and `close` on a stage binding closes every stage of
that generation and its workspace once, leaving a newer generation live.

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
