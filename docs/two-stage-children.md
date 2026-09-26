# Two-stage issue children and question escalation

Status: design agreed with the user on 2026-09-26. Not implemented.

## What the user asked for

1. Parent stays Opus 5.5 xhigh.
2. An issue child runs in two sessions when the work is large enough:
   - **Plan session:** Fable 5.1 runs the ulw-plan procedure and writes one approved plan.
   - **Execute session:** a new Opus 5.5 medium session runs `/ulw-execute` on that plan, and ulw-execute drives mass-ulw phases.
3. Small development work skips the plan and runs mass-ulw directly (today's behavior). Research work runs ulw-research instead.
4. A child's questions go to its parent. The parent answers when it can. What the parent cannot decide goes up to the management session (supervisor), or to the user inbox when there is no manager.

## Current behavior this changes (with code references)

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
- The final report comes from the execute stage (or the single stage) under the original packet's `report:<packet-id>`.

### Mode selection

The parent picks the mode per issue packet with a new required field `execution_mode`. The parent already reads the full criteria, so it has the context for the choice:

| Mode | When | Stages |
|---|---|---|
| `direct` | Small, well-specified development work. JUN-273, 274 and 275 were all this size. | one tab: Opus 5.5 xhigh (today's model), mass-ulw |
| `planned` | Large or ambiguous development work: several components, open design decisions, cross-module changes. | plan tab (Fable 5.1 xhigh, ulw-plan), then execute tab (Opus 5.5 medium, ulw-execute + mass-ulw) |
| `research` | The deliverable is findings, not code. | one tab: Opus 5.5 xhigh, ulw-research. Its collection can run as mass-ulw DAG waves (ulw-research Phase 1 "mass research" path) inside the same tab. |

The child may push back: if the plan stage finds the work smaller than expected, it reports "no plan needed" and the parent resends as `direct`. The child never switches its own mode.

### Stage hand-off

1. The plan stage runs ulw-plan in the issue worktree. It writes `.omo/plans/<issue-key>.md` and the plan-reviewer loop runs as usual.
2. ulw-plan's "wait for the user's okay" step becomes a **question to the parent** (see below). The parent approves the plan itself (user decision), requests changes, or escalates only a real scope or product question.
3. On approval, the plan stage records a `stage_complete` hand-off: plan path, plan digest, head commit. Then it ends its turn.
4. OLW (not the agent) opens the execute tab in the same worktree. It launches Opus 5.5 medium with `/ulw-execute <plan>` as the first prompt, and the brief carries the original packet ID and the evidence directory.
5. ulw-execute runs its phases with mass-ulw. At the end the execute stage reports to the parent once, exactly as today's child does.

### Question and answer escalation

Add two message kinds and routes:

| Kind | Route | Meaning |
|---|---|---|
| `question` | child -> parent, parent -> supervisor | A blocking question with an ID, the exact question, options if any, and what the sender will do meanwhile (wait). |
| `answer` | parent -> child, supervisor -> parent | The answer to one question ID. |

Rules:

- **Children never ask the user.** In a bound child session, the OLW extension intercepts `ask_user_question` in `onToolCall`, the same hook that already guards `thread_create`. It converts the call into a `question` to the parent and returns "sent to parent, end your turn and wait". The answer arrives by native delivery and wakes the child. This also covers ulw-plan's approval step and ulw-execute's plan-selection question.
- **The parent decides first.** It answers from the criteria, the Linear decisions and repository evidence. It escalates only what it cannot decide: scope changes, contradictions in the criteria, product choices, anything that needs the user's authority.
- **Escalation goes up one level to the management session.** A management session always exists (user decision): it is the session the user is directing. Parents are linked to it when they are created, and the `question` goes there. The management session answers what it can decide and asks the user the rest in its own TUI. It is the only role allowed to use `ask_user_question`.
- **Answers go back down the same path, by question ID.** When the user replies in the parent session, the parent turns it into an `answer` to the child. One question ID gets one answer, and replays are deduplicated like reports.
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

## Implementation units (in dependency order)

1. **Model policy:** add `medium` to `RoleModel.thinking` and the seed schema. Make the model depend on role and stage: parent Opus 5.5 xhigh, plan Fable 5.1 xhigh, execute Opus 5.5 medium, direct Opus 5.5 xhigh, research Opus 5.5 xhigh.
2. **Registry:** add stage sessions to the child owner: a stage list, the live stage, and hand-off records. Route delivery to the live stage session and keep the ownership key.
3. **Orchestrator:** add `stage start` to launch a stage in the existing child worktree. It creates a new Herdr tab in the child workspace, a new session, the stage model and the first prompt. Close the previous stage's contact after its hand-off and keep its tab.
4. **Messages:** add the `question` and `answer` kinds, their authorization routes, and IDs and deduplication. Add the CLI commands `ask` and `answer`.
5. **Extension:** in bound children and parents, intercept `ask_user_question` and turn it into a `question`.
6. **Manager:** add a scope-free manager binding and `olw manage` (open or reattach the directing session on the OLW host), link parents created from it, and route parent questions and reports to it.
7. **Brief and skills:** add `execution_mode` to the packet. Add mode-specific child briefs and update `olw-run` for the parent's mode choice, answering duties and escalation.
8. **Tests** for each unit, plus one real run: a `planned` issue whose plan stage asks one question the parent must escalate.

This is a HEAVY change: a registry schema change, new message routes and new launch paths. I recommend running it through ulw-plan (plan, review, then execute) rather than as a bare implementation.

## Model availability

Checked on 2026-09-26 through the opencodex loopback `/v1/chat/completions`: `anthropic/claude-fable-5-1` with `reasoning_effort: xhigh` and `anthropic/claude-opus-5-5` with `reasoning_effort: medium` both returned HTTP 200 and the requested reply. Both models list `medium` and `xhigh` in their catalog `thinkingLevelMap`. A plain `omo -p` print-mode probe hung without output on this host; that is a separate print-mode issue and not a model availability problem.

## Decisions

1. Execute stage: Opus 5.5 medium. Accepted.
2. Research mode: Opus 5.5 xhigh with ulw-research.
3. The parent approves child plans by itself.
4. Stages share one worktree and split into Herdr tabs (plan, execute).
5. A management session always exists: it is the session the user directs.
6. The manager is not bound to an initiative. It can manage several initiatives and parents; `olw manage` opens it.
