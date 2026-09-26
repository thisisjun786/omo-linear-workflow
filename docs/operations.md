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

Owned parents and their `pr` children fetch origin with pruning **before** inspecting publication
and before changing lifecycle state or terminating a runtime. Close refuses with `unpushed_commits`
and the commit IDs absent from every remote-tracking ref. Parent inspection includes all local
branches (including unmerged children); child inspection covers its own branch. Fetch failure also
refuses close. Publication elsewhere is discovered by the fetch, and deleted stale refs cannot hide
unpublished commits. `--discard` explicitly bypasses this guard, but still preserves checkout files.
A failed launch that never created its clone can be released with `--confirm-absent` after inspection.
Legacy linked-worktree and PR-less child close behavior is unchanged.

## Isolated owned-clone QA

`bun scripts/qa-owned-clones.ts` uses the managed Herdr artifact, a temporary HOME, a unique server,
a temporary bare remote, recording client wrapper and direct server snapshot. It exercises the real CLI, registry, Git,
Herdr workspaces/worktrees, plan/execute tabs, child PR open/report/parent merge, project PR open
and close. Native model execution/readiness and GitHub are simulated (a recording gh shim performs
real Git merges against the bare remote), so no credentials/network are needed. It verifies the
remote integration branch advances through a merge commit, project PRs leave the default branch
unchanged, separate project common-dir keys and no `worktree.create_grouped`. It removes its server
and all fixture files. The receipt is `.omo/evidence/lina-274-qa.json`; it never contacts user Herdr.
