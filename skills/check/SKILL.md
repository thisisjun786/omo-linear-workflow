---
name: oi-check
description: "Compare delivered work against the full canonical Linear criteria and accepted decisions, classify each obligation, and route in-scope corrections to the existing owner one level down. Use for requirement drift or completion checks; oi-run executes, oi-plan changes the roadmap. A check never merges, closes issues or wakes anyone by polling."
---

# OI Check

Check delivered work against what was agreed, with Linear as the canonical source of what was
agreed. Read [Linear through OMO's native MCP](../references/linear.md) for access and
[Supervisor, parent and child](../references/roles.md) for who may act on a finding. A
standalone audit stays read-only; a parent or supervisor checking under its own assignment
keeps that assignment's authority and nothing more.

## Pin the comparison

Identify the initiative, project, milestone or issues, their canonical documents, the original
intent, subsequently accepted changes, and the implementation revision. Read full criteria and
decision bodies through the authenticated connector, not list summaries. Record exact IDs and
revisions, the baseline and final commits (or a frozen diff), and the observed environment.

Treat memory and assistant proposals as locators. A newer document doesn't automatically
override a user decision, and a later explicit correction can supersede the original
requirement; cite that evidence. If authority is unclear, keep both readings as unresolved
rather than picking whichever matches the implementation.

Inspect code, tests and result artifacts. Separate source existence, passing checks,
integration into the project branch, deployment, and observed behavior. A live check outside
the authorized environment stays unverified.

## Compare criterion by criterion

Break compound criteria into observable obligations and classify each:

| Classification | Required basis |
|---|---|
| Satisfied | Evidence at the relevant revision and required delivery level |
| Agreed change | Traceable accepted change and evidence for the revised obligation |
| Explicitly deferred | Recorded deferral and the remaining condition |
| Missing or regressed | In-scope obligation contradicted by code or reproduced behavior |
| Unverified | Insufficient access or evidence, ambiguous authority, or an untested required surface |

Name significant additions outside agreed scope and explain their impact without calling every
addition a defect. Don't count deferred work as done, call absent evidence a proven defect, or
rewrite criteria so the result passes. For a suspected violation state the expected rule, the
observation, the smallest counterexample, the impact and the source anchors, and check a valid
contrasting case so a correction won't reject normal behavior. Reuse valid proof instead of
rerunning a broad suite for appearance.

When the claim includes integration, confirm the reported head is the head the branch has now,
the base is current, and the checks ran on that exact head. A moved head invalidates the
evidence it outran. A merge into the project branch doesn't prove deployment, and a verified
non-PR result needs no empty PR.

## Judge the schedule where dates exist

Where the checked subjects carry agreed dates, compare them with delivery evidence in the same
check: ahead, on plan, at risk, late or undecidable, judged against both the baseline and the
current date with the timezone stated. A passed deadline never lowers a criterion, and a
schedule verdict is its own field, never a per-criterion disposition. Return needed date
changes to [oi-plan](../plan/SKILL.md).

## Resolve findings and report

A finding is returned by the caller's own level to the level below it. A parent returns an
issue's finding to its responsible child, or handles it where the fix is the project's to
decide. A supervisor returns a project's finding to that project's parent, never to a child,
even when the finding concerns one issue. A check never sends anything into another project's
children, never creates a role, and never assumes permission to change code.

Send an in-scope correction through the existing route without asking the user to relay it:

```sh
bun "$OMO_INITIATIVE_ROOT/dist/cli.js" send --from <OWNER> --to <RESPONSIBLE> --id <MESSAGE_ID> --kind instruction --text-file correction.txt --json
```

The packet names the violated criterion, the reviewed revision, the reproducible evidence, the
required outcome and the recheck. Missing evidence gets a scoped verification request, not an
invented defect. Then end the turn; the corrected report wakes you. Recheck the corrected
revision against the original criteria and the reproduced failure, keeping the same scope until
verified or a real blocker needs a decision.

Explicit read-only, report-only and no-contact instructions win. A passing check alone
authorizes no requirement change, issue closure, merge or deployment; route roadmap changes to
`oi-plan` and integration to the owning parent under [oi-run](../run/SKILL.md).

Lead the report with the verdict and the action actually taken: correction sent, awaiting
delivery, recheck passed, integrated, or blocked. Keep "correction sent", "owner resumed" and
"result verified" as three separate facts. Add a criterion and evidence table when useful.
Under an existing assignment, write the summary to the project's coordination record and read
it back; a bounded helper returns it to the coordinator instead. Before finishing, confirm every
verdict has a source, accepted changes were considered, deferrals stay distinct from
completion, and unverified delivery levels are explicit.

An idle parent with no goal is not a finding; that's the design working. What makes it a
finding is the delivery side: an uncertain send left unreconciled, a paused recipient nobody
resumed, or a report that never arrived. Read the registry for those before reporting a stalled
run, and don't start or restart anything to supply evidence a check is missing.
