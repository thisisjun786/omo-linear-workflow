# Two-stage issue children and question escalation

Status: design agreed with the user on 2026-09-26. Implemented; see "Implemented data model" below for where the shipped code differs from the first draft. The `olw-run` skill and [roles.md](../skills/references/roles.md) carry the current guidance.

## What the user asked for

1. Parent stays Opus 5.5 xhigh.
2. An issue child runs in two sessions when the work is large enough:
   - **Plan session:** Fable 5.1 runs the ulw-plan procedure and writes one approved plan.
   - **Execute session:** a new Opus 5.5 medium session runs `/ulw-execute` on that plan, and ulw-execute drives mass-ulw phases.
3. Small development work skips the plan and runs mass-ulw directly (today's behavior). Research work runs ulw-research instead.
4. A child's questions go to its parent. The parent answers when it can. What the parent cannot decide goes up to the management session (supervisor), or to the user inbox when there is no manager.

## Current behavior this changes (with code references)

This table describes the code before the change. Every row was addressed; the shipped shapes are in "Implemented data model".

| Area | Today | Why it blocks the request |
|---|---|---|
| Role model | `src/core/policy.ts` `modelForRole`: parent and child both `opencodex/anthropic/claude-opus-5-5` `xhigh`. `RoleModel.thinking` and the seed schema accept only `high`, `max`, `xhigh`. | Child needs Fable 5.1 (plan) and Opus medium (execute). `medium` is not a valid value. |
| One owner per issue | `src/core/store.ts` `ownershipKey(child) = issue:<id>` with a UNIQUE index on live bindings. | Two live sessions for one issue are impossible, and closing the plan session first loses its identity. |
| Child creation | `src/orchestrator.ts` `createChild` always allocates a new worktree and branch. `#create` launches omo with `--model`, `--thinking`, `--no-model-fallback`. | The execute session must reuse the plan session's worktree, branch and `.omo/plans/` file. |
| Child brief | `src/linear/brief.ts` `roleBehavior(child)`: `execution_mode: mass-ulw`, skills `[olw-run, mass-ulw]`. | There is no stage, mode or skill selection. |
| Message kinds and routes | `src/core/store.ts` authorize route matrix: instruction supervisor->parent and parent->child; report child->parent and parent->supervisor. `contracts.ts` kinds: instruction, coordination, report, operational_notice. | A child can only report once (`report:<packet-id>`). It has no way to ask and wait. |
| Questions inside a session | ulw-plan waits for an explicit user okay and asks through `ask_user_question`. Nobody watches a child pane. `src/extension/runtime.ts` already intercepts `thread_create` and `thread_send` for bound roles in `onToolCall`. | A child's question would block forever in an unwatched pane. The existing hook is the place to reroute it. |
| omon | `~/.local/bin/omon` only sets `OMO_PROFILE`. Role launch passes an explicit `--model`, so a profile has no effect. | "omon's ulw-plan procedure" means the ulw-plan skill run on Fable 5.1, not the omon launcher itself. |

## Proposed model

### Child stages are Herdr tabs of one issue owner

One issue keeps one **issue owner record** (today's child binding). It has one worktree, one branch and one report route, and it gets **no new worktree per stage**. Each stage is a new durable session in its own **Herdr tab** of the child workspace:

```
child workspace "JUN-274 ..."            one worktree, one branch, one owner
  tab "plan"     Fable 5.1 / xhigh     ulw-plan
  tab "execute"  Opus 5.5 / medium     /ulw-execute, which drives mass-ulw
```

- The ownership key and its UNIQUE index stay on the owner, so there is still one owner per issue.
- Only the current stage is addressable. The parent always addresses the owner, and the registry routes to the current stage session.
- A finished stage's tab stays open for inspection, with contact closed. Both tabs close with the child.
- The final report comes from the execute stage (or the single stage) under `report:<packet-id>` of the packet sent to that stage's binding.

### Mode selection

The parent picks the mode per issue at creation with `child create --mode direct|planned|research` (default `direct`). The parent already reads the full criteria, so it has the context for the choice:

| Mode | When | Stages |
|---|---|---|
| `direct` | Small, well-specified development work. JUN-273, 274 and 275 were all this size. | one tab: Opus 5.5 xhigh (today's model), mass-ulw |
| `planned` | Large or ambiguous development work: several components, open design decisions, cross-module changes. | plan tab (Fable 5.1 xhigh, ulw-plan), then execute tab (Opus 5.5 medium, ulw-execute + mass-ulw) |
| `research` | The deliverable is findings, not code. | one tab: Opus 5.5 xhigh, ulw-research. Its collection can run as mass-ulw DAG waves (ulw-research Phase 1 "mass research" path) inside the same tab. |

The child may push back: if the plan stage finds the work smaller than expected, it says so. The parent closes that generation (`close --binding <plan or execute binding>`) and creates a new child with `--mode direct`; one live owner per issue. The child never switches its own mode. A packet whose mode disagrees with the child's stage yields a `blocked` report without work.

### Stage hand-off

1. The plan stage runs ulw-plan in the issue worktree. It writes `.omo/plans/<issue-key>.md` and the plan-reviewer loop runs as usual.
2. ulw-plan's "wait for the user's okay" step becomes a **question to the parent** (see below). The parent approves the plan itself (user decision), requests changes, or escalates only a real scope or product question.
3. On approval, the plan stage runs `stage complete --from <plan> --plan <abs path> --head <sha> --id <id> --text-file <file>`. OLW checks the plan is inside the worktree and the head matches, records the hand-off (plan path, plan sha256, head) and sends it as a completed report to the parent. Then the stage ends its turn.
4. The parent runs `stage start --from <plan> --parent <parent> --stage execute --id <id>`. OLW (not the agent) stops the plan session (TUI quit, then engine terminate), opens the execute tab in the same worktree, and launches Opus 5.5 medium with only `plan_path` and `plan_head` in its brief. The result is a new binding ID for the execute stage. Nothing from the plan stage's packet transfers.
5. The parent sends the issue packet to the execute binding with `send` (criteria, limits, evidence directory, plan path). Only that packet starts work; its envelope ID is the packet ID the execute stage reports under.
6. ulw-execute runs its phases with mass-ulw. At the end the execute stage reports to the parent once, `report:<packet-id>`, exactly as today's child does.

### Question and answer escalation

Add two message kinds and routes:

| Kind | Route | Meaning |
|---|---|---|
| `question` | child -> parent, parent -> supervisor | A blocking question with an ID, the exact question, options if any, and what the sender will do meanwhile (wait). |
| `answer` | parent -> child, supervisor -> parent | The answer to one question ID. |

Rules:

- **Children never ask the user.** In bound child and parent sessions, the OLW extension registers an `olw_ask` tool (up to 4 questions per call, options, a recommended default) and blocks native `ask_user_question` and `request_user_input` in `onToolCall`, the same hook that already guards `thread_create`. `olw_ask` sends a `question` to the owner and returns "end your turn and wait". The answer arrives by native delivery and wakes the child. This also covers ulw-plan's approval step and ulw-execute's plan-selection question. The CLI equivalent is `ask --from <binding> --id <id> --text-file <file> [--questions-file <json>]`.
- **The parent decides first.** It answers from the criteria, the Linear decisions and repository evidence. It escalates only what it cannot decide: scope changes, contradictions in the criteria, product choices, anything that needs the user's authority.
- **Escalation goes up one level to the management session.** A management session normally exists (user decision): it is the session the user is directing. Parents created while it's ready are linked to it (unless `parent create --no-manager`), and the `question` goes there. When no manager is ready, or with `ask --to-user`, the question is posted to the user inbox; `questions --project <id>` lists it and `answer --as-user --question <id>` answers it without a binding. The management session answers what it can decide and asks the user the rest in its own TUI. By policy it is the role that asks the user directly; the runtime blocks native asks only in bound children and parents.
- **Answers go back down the same path, by question ID.** `answer --from <binding> --question <question-id> --text-file <file>` sends `answer:<question-id>` to the asker. One question ID gets one answer, and replays are deduplicated like reports.
- **No waiting loops.** A role that asked ends its turn. It is woken by the `answer` delivery, which is the same event-driven model as today.

### The OLW shared host

An OMO session has two parts: the **agent engine** (model calls, tools, session history) and the **TUI** you type into. Normally each `omo` you start runs both itself.

OLW starts one long-lived engine process, the **shared host**, on its own socket `<control root>/.omo/state/omo.sock` (`omo host ensure`, `src/orchestrator.ts` `defaultEnsureHost`; profile `src/host-profile.ts`). Every role session runs its engine inside that host. The Herdr pane only shows a TUI attached to it. On 2026-09-26 the host (pid 160596) reported 4 attached interactive sessions: the tally parent and its three children.

This is what makes OLW messaging work:

- A role's `send` or `report` becomes a native `thread_send` to the target session's durable ID. The host delivers it and wakes the target. The OLW extension in the host records the message ID, receipt and deduplication in the registry.
- Delivery only reaches sessions in the same host. `src/core/store.ts` rejects other routes with `host_mismatch`.
- Sessions survive a closed pane or a detached TUI, because the engine lives in the host rather than in the pane.

An ordinary `omo` session, like the one the user directs today, runs its own engine. It is not in the OLW host (its environment has no `OMO_RPC_SOCKET`), so an OLW role cannot deliver a message to it.

### The management session

User decisions: the session the user directs is the management session. It is **not bound to one initiative**. The future LINA app is expected to manage several initiatives and many parent sessions from one conversation, so the manager's scope stays open-ended.

- **`olw manage`** opens the user's directing session inside the OLW host: a TUI in a Herdr workspace named "manager", with the user's normal default model. The user directs work from it. Parents' questions and reports arrive there natively, and the manager answers what it can and asks the user the rest.
- **Manager binding without a fixed scope.** It has no initiative or project assignment. It gains a management link to each parent when that parent is created from it (`parent create` run by the manager links automatically) or linked explicitly. The one-supervisor-per-initiative rule does not apply to it.
- **Authority stays with each parent's own approval.** A manager link grants contact (questions, answers, reports and instructions to linked parents). It never widens a parent's scope: approval stays on the parent's designation and snapshot digest, as `parent link` already works today.
- **One manager at a time, by default.** A second `olw manage` reattaches to the existing manager session instead of creating another. Several managers can be allowed later if LINA needs them.
- **Existing initiative supervisors** remain valid, and existing bindings are not migrated. A manager is a new, more general form of the same role.
- An arbitrary running `omo` session cannot be adopted as the manager without restarting it inside the OLW host. Relaying through `herdr agent prompt` into a foreign session was considered and rejected: it has no delivery receipt and no deduplication.

## Implemented data model

The draft above talks about one issue owner record with stage sessions under it. The shipped registry does it the other way round, which keeps the existing UNIQUE ownership index untouched:

- **One binding per stage.** Each stage (`direct`, `plan`, `execute`, `research`) is a normal child binding with its own ID, durable session and Herdr tab. Stages of a planned child share the checkout (worktree and branch); the execute binding is created with the plan binding's checkout instead of a new one.
- **Lineage.** The `stage_lineage` table links a binding to its issue, stage, ordinal, previous binding and hand-off record (`planPath`, `planSha256`, `head`, `completedAt`). `stage start` requires the previous stage's hand-off and the next ordinal.
- **Generations.** A lineage carries a generation number. A fresh `direct` or `plan` stage for an issue whose earlier stages are all closed starts a new generation, so an issue can be re-run without touching the old chain. `status` is generation-scoped: each row's `stageBindings` lists the stages of that row's own generation, so an old row keeps showing the old chain next to the new one.
- **One live owner per issue.** The ownership key stays `issue:<id>` on live bindings. `stage start` stops the plan session before the execute binding becomes live, so the index never sees two.
- **Close.** `close --binding` on any lineage member closes the live stage session, marks every member of that generation closed and closes the child workspace once. Closing an old generation leaves a newer one live. Legacy children (no lineage row) close as before.
- **Manager.** The manager is a child-free binding with role `manager`, a fixed designation and a fixed synthetic snapshot. `olw manage` creates it once and reattaches later; the launch model comes from the user's `~/.omo/agent/settings.json` defaults, with `opencodex/anthropic/claude-opus-5-5` `medium` as the fallback. Its identity check doesn't pin provider, model or thinking, and activation doesn't configure its model, so the user may change models in it. Its brief always carries an `update_check` line from the check `manage` ran at start (`unavailable; run olw update check` when the check couldn't run).

## Implementation units (in dependency order)

This list is the original plan, kept as history. Where it differs from the shipped code, "Implemented data model" above and the `olw-run` skill are correct. In particular, unit 5 shipped as a block plus a separate tool: native `ask_user_question`/`request_user_input` calls in bound child and parent sessions are rejected with a reason pointing at `olw_ask`, not converted; only `olw_ask` delivers a question. Unit 7's `execution_mode` packet field became `child create --mode`.

1. **Model policy:** add `medium` to `RoleModel.thinking` and the seed schema. Make the model depend on role and stage: parent Opus 5.5 xhigh, plan Fable 5.1 xhigh, execute Opus 5.5 medium, direct Opus 5.5 xhigh, research Opus 5.5 xhigh.
2. **Registry:** add stage sessions to the child owner: a stage list, the live stage, and hand-off records. Route delivery to the live stage session and keep the ownership key.
3. **Orchestrator:** add `stage start` to launch a stage in the existing child worktree. It creates a new Herdr tab in the child workspace, a new session, the stage model and the first prompt. Close the previous stage's contact after its hand-off and keep its tab.
4. **Messages:** add the `question` and `answer` kinds, their authorization routes, and IDs and deduplication. Add the CLI commands `ask` and `answer`.
5. **Extension:** in bound children and parents, intercept `ask_user_question` and turn it into a `question`.
6. **Manager:** add a scope-free manager binding and `olw manage` (open or reattach the directing session on the OLW host), link parents created from it, and route parent questions and reports to it.
7. **Brief and skills:** add `execution_mode` to the packet. Add mode-specific child briefs and update `olw-run` for the parent's mode choice, answering duties and escalation.
8. **Tests** for each unit, plus one real run: a `planned` issue whose plan stage asks one question the parent must escalate.

This was a HEAVY change: a registry schema change, new message routes and new launch paths. It ran through ulw-plan (plan, review, then execute); the plan is `.omo/plans/olw-two-stage-children.md`.

## Model availability

Checked on 2026-09-26 through the opencodex loopback `/v1/chat/completions`: `anthropic/claude-fable-5-1` with `reasoning_effort: xhigh` and `anthropic/claude-opus-5-5` with `reasoning_effort: medium` both returned HTTP 200 and the requested reply. Both models list `medium` and `xhigh` in their catalog `thinkingLevelMap`. A plain `omo -p` print-mode probe hung without output on this host; that is a separate print-mode issue and not a model availability problem.

## Decisions

1. Execute stage: Opus 5.5 medium. Accepted.
2. Research mode: Opus 5.5 xhigh with ulw-research.
3. The parent approves child plans by itself.
4. Stages share one worktree and split into Herdr tabs (plan, execute).
5. A management session always exists: it is the session the user directs.
6. The manager is not bound to an initiative. It can manage several initiatives and parents; `olw manage` opens it.
