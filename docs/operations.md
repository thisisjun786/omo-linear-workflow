# Operations

## Creating a mapped project parent

Import and approve a scope snapshot with a project repository mapping, then run:

```sh
olw parent create --project PROJECT_ID --scope-digest DIGEST --designation APPROVAL_ID --execute
olw child create --parent PARENT_BINDING --issue ISSUE_ID --mode planned
```

Use `--fixture` only for fixture snapshots. No user-local checkout or `--repo` is required.
The parent clone and its children use the target repository, not the OLW installation repository.
`olw status --project PROJECT_ID --json` exposes checkout kind, path, integration branch, base
commit and receipt path. Optional local-file and setup configuration is documented in
[repositories](repositories.md#explicit-local-only-files-and-setup).

## Closing owned parents

Close children first, then `olw close --binding PARENT_BINDING --json`. Close removes the owned
Herdr workspace and terminates its runtime, but preserves the clone, child worktrees, branches,
dirty files and copy/setup receipts. It never pushes, opens a PR or deletes repository work.

For owned clones the response adds `unpushedCommits`, the commit IDs reachable from local branches
but not from any remote-tracking branch. This includes unmerged child branches in the clone.
Inspection occurs after runtime termination; a failure leaves closure incomplete and preserves
ownership for inspection/retry. Repeated close reports the current result again. A failed launch
that never created its clone can be released with `--confirm-absent` after manual inspection.

The report uses locally known remote-tracking refs and does not fetch during close. It is a
preservation warning, not a push or PR policy. If somebody pushed elsewhere, fetch explicitly in
the retained clone before interpreting the report. Remote publication policy is separate work.
Legacy linked-worktree close behavior is unchanged.

## Isolated owned-clone QA

`bun scripts/qa-owned-clones.ts` uses the managed Herdr artifact, a temporary HOME, a unique server,
a temporary bare remote and a recording socket proxy. It exercises the real CLI, registry, Git,
Herdr workspaces/worktrees, plan/execute tabs and close; only native model execution/readiness is
simulated, so it requires no model credentials or network. It verifies separate project common-dir
keys and the absence of `worktree.create_grouped`, then removes its server and all fixture files.
The receipt is `.omo/evidence/lina-273-qa.json`. It never connects to the user's Herdr server.
