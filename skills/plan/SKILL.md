---
name: oi-plan
description: "Decompose an agreed goal into Linear projects, milestones and one-PR implementation issues, then read the full canonical criteria back and generate the validated scope snapshot JSON that the omo-initiative CLI imports. Use oi-define for intent, oi-run for execution, oi-check for drift. Planning and importing create no supervisor."
---

# OI Plan

Build a usable plan from what exists and what the user wants next, and produce the scope
snapshot the orchestrator consumes. Linear holds the canonical planning and decision
documents; repositories hold implementation and reproducible evidence. Read
[Linear through OMO's native MCP](../references/linear.md) before touching either.

Take an agreed initiative definition as input, then cover its requested scope in one
operation: projects, useful milestones, issues and dependencies. If the goal itself needs
definition, use [oi-define](../define/SKILL.md). An existing project or standalone issue can
supply the goal without an initiative. Reuse existing levels; don't invent an initiative or
extra projects to fill the hierarchy. Consultation, plan-only, draft-only and read-only
requests authorize no Linear writes, and invoking this skill doesn't supply write intent.

## Establish the baseline

Discover and authenticate the Linear connector as the reference describes, then read the
initiative, its projects, milestones, issues, full acceptance criteria, dependencies and linked
decision documents. Paginate scoped results before concluding an item is absent. Inspect
repository guidance, branches, worktrees and relevant PR evidence where code is involved.

Distinguish proposed, implemented, reviewed, merged, deployed and behaviorally verified work. A
Done label or a local commit doesn't establish the later states. When evidence disagrees, keep
the source links and record the disagreement.

## Shape the plan

- **Project:** a finishable outcome. Name the result naturally.
- **Milestone:** an observable result or delivery boundary. Follow explicit user grouping.
- **Issue:** one implementation PR. State the problem or visible outcome, the deliverable, the
  target repository, scope and exclusions, acceptance criteria, canonical links,
  prerequisites and meaningful verification. Non-PR work names its agreed result where the
  PR target would be.

A second issue exists because a second merge must happen: a different target repository, a
part that must land before the rest can be written or verified, or a part already owned by a
live issue. Parts that can't pass verification apart land together. File count, diff size and
the wish to parallelize never split an issue. Derive order from dependency edges and
overlapping edit surfaces; avoid cycles.

Make criteria observable: behavior, state that must survive, and important failure cases.
Don't weaken criteria to match code already written. Name each issue's actual target
repository; a label isn't a target, and an unresolved target stays a planning dependency
rather than an invented checkout.

Dates come from an authority, delivery evidence or an existing record, never from an
estimate. Where none exists, say so instead of padding.

## Reconcile and apply

For an existing plan, compute a compact change set: reuse, create, update or leave unresolved.
Match stable IDs and semantic scope before titles. Re-running the same request converges on
the same items.

A request to create, update or apply the plan in Linear authorizes its scoped hierarchy and
document writes. A narrower update doesn't authorize unrelated new projects. Apply within
scope, read back the resulting items and relations, and don't add a second approval step for
routine authorized writes. After an uncertain write, look up the existing result before
retrying; repair fields on the created ID rather than repeating the create.

## Generate the scope snapshot

After the plan is written and read back (or, for a plan-only request, from the current
accepted plan), build the snapshot file described in
[Scope snapshot for the CLI](../references/linear.md#scope-snapshot-for-the-cli):

1. Re-read every included initiative, project and issue by ID through the connector and take
   `id`, `url` and `revision` from those reads. Include linked decision documents in
   `decisionRefs`.
2. Include only the projects and issues the approved definition covers. Say what was left out
   and why.
3. Set `source` to `linear-export`. A hand-written QA file is `fixture` and is never mixed with
   live refs.
4. Write the file, then import it:

   ```sh
   bun "$OMO_INITIATIVE_ROOT/dist/cli.js" scope import --file ./scope.json --json
   ```

5. Report the returned digest beside the Linear revisions it was built from. Exit 2 means the
   file was rejected; rebuild it from a fresh read instead of hand-editing values.

The digest identifies what a later designation approves. Importing binds nobody and starts
nothing; see [Definition is not execution approval](../references/roles.md#definition-is-not-execution-approval).
If the connector isn't authenticated, stop at the plan and report that the snapshot couldn't
be generated from live reads. Don't substitute a fixture and present it as an export.

## Deliver

Return Linear links, meaningful changes, unresolved decisions, the snapshot digest (or the
reason there is none) and the next ready issue batch with prerequisites. For a full plan, cover
the entire agreed scope with issue-level criteria and dependencies; an outline isn't a
completed plan. Creating the plan executes nothing: no role session, no branch, no PR, no
merge. Hand executable work to [oi-run](../run/SKILL.md) only when execution was requested.
