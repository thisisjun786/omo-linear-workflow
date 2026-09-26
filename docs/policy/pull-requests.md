# Pull Requests

Use a short-lived branch from `dev` and target `dev` with one coherent change. Keep unrelated refactoring and behavior changes separate. Reviewability and safe rollback matter more than line count.

`main` identifies the released source and accepts no development or promotion PRs. Only an owner-authorized [release](releases.md) advances it, to one exact verified commit.

Follow the [language policy](../../CONTRIBUTING.md#language) for PR titles and bodies.

## Describe the change

The [PR template](../../.github/PULL_REQUEST_TEMPLATE.md) asks for:

- The problem, the approach, and relevant issue links.
- Tests or manual checks performed, with results and any gaps.
- Compatibility, migration, and recovery implications when applicable: documented CLI flags and exit codes, the SQLite schema, stored state layout, the scope snapshot format, routing state files.

For runnable changes, show evidence from the affected usage path, not only unit tests. The isolated QA scripts (`bun run qa:events`, `qa:linear`, `qa:proxy`, `qa:routing`, `qa:child-workflow`) exist for that; name which ones you ran. For documentation, reading and link/format checks are appropriate; don't write tests that pin prose.

User-facing changes add a line under `## [Unreleased]` in [CHANGELOG.md](../../CHANGELOG.md). If the README changes, update both `README.md` and `README.ko.md`, or say in the PR that the Korean file needs a translation.

## Review and merge

A PR can merge when:

1. The [CI workflow](ci.md) passes against the latest base.
2. Review threads are resolved, either by a fix or a recorded decision with a reason.
3. The repository owner explicitly authorizes the merge.

This is a single-owner repository. Another person's GitHub approval isn't required, including on the owner's own PRs. Agent reviews are supporting evidence for the owner; they don't grant merge authority and don't count as a human approval. Record what a review checked and what it couldn't establish.

## History

Use English [Conventional Commit](https://www.conventionalcommits.org/en/v1.0.0/) titles for commits and PRs, for example `docs: clarify contribution steps` or `fix: handle empty input`. Each commit inside a PR should be a verified increment with its own Conventional Commit message, because those commits stay in history.

Merge PRs with a merge commit, never squash or rebase. `dev` requires a PR and passing checks. Don't push development changes directly to `dev` or `main`; only a release advances `main`. Both branches prohibit force pushes and deletion. Passing CI doesn't authorize merging, and merging doesn't publish a [release](releases.md).

## Branch ownership

Check the owner and linked worktrees before deleting a merged branch. Preserve unmerged work from closed PRs until its disposition is agreed.

Policy changes use this same PR process. Repository rules and the [workflows](../../.github/workflows/ci.yml) define enforcement; update the documentation alongside any authorized configuration change. What CI runs is documented in the [CI policy](ci.md).
