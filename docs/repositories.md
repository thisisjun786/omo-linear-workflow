# Repository mirrors and owned checkouts

A project in a scope snapshot may identify its target Git repository:

```json
{
  "project": { "id": "project-id", "key": "P-ENG-12", "url": "...", "revision": "..." },
  "repository": {
    "remote": "ssh://git@github.com/owner/repository.git",
    "defaultBranch": "main"
  },
  "issues": []
}
```

The optional mapping is canonical snapshot data, so adding or changing it changes the scope
digest and requires approval. Snapshots created before this field was added remain valid and keep
their original digest.

`olw repo fetch --remote URL` creates or updates one bare, fetch-only mirror under
`<root>/.omo/repos`. `olw repo list` reports mirrors already known locally. Both commands accept
`--json`. `olw doctor` includes the same read-only repository status (path, normalized remote,
last successful fetch time, and last error) and never fetches.

OLW invokes Git directly and relies on the user's existing SSH agent or Git credential helper. It
does not copy or store credentials. URLs containing embedded HTTPS credentials or SSH passwords
are rejected.

## Owned parent clones

For a mapped project, omit `--repo` when creating a parent. OLW ensures and fetches the mirror,
then makes a local clone in `<root>/.omo/checkouts/<repo>-<projectKey>-<shortBinding>/`.
The project ID is used when no display key is present; path components are sanitized. Local
cloning hardlinks objects where supported, never uses `--shared` or alternates, and resets
`origin` to the actual remote. The clone remains independent of mirror pruning.

The integration branch starts at `origin/<defaultBranch>`. An optional `repository.base` in the
approved snapshot selects another branch, tag or commit; an explicit `--base REF` takes precedence.
OLW records the resolved commit, branch, remote, `kind: "owned-clone"` and copy receipt path in the
registry. Herdr creates a plain `workspace.create` at the clone root. Its Git common directory
naturally gives each project its own readable sidebar group, even for the same remote.

Children use official `worktree.create` with cwd set to the parent clone and branch from the
parent integration branch. Their directories remain under `<root>/.omo/worktrees/`; their Git
administration and objects belong to the parent's clone. Plan/execute tabs share that one worktree.
Neither owned parents nor their children use `worktree.create_grouped`.

New parents require an approved repository mapping. The deprecated `--repo` option is rejected,
not used as an override. Existing rows without a checkout kind decode as `linked-worktree`,
including read-only status. Child and successor creation for those parents is rejected with
`legacy_parent_unsupported` before any external side effect. Close or migrate the parent with
approval, or continue it on the retained pre-switch OLW/patched Herdr stack; see
[rollback](operations.md#one-release-rollback). No old checkout is moved or migrated, and legacy
`originalRepoRoot` continues to identify the user's repository.

## Issue deliverables and PR integration

One issue produces one PR, or an explicitly selected PR-less deliverable. `child create` records
`--deliverable pr|report|document` on the binding; research defaults to report, direct/planned to
pr. The child brief, issue instruction envelope and `status` carry it. Plan/execute share the
choice: plan handoff does not open a PR; the execute stage delivers it.

For an owned-clone parent:

```sh
olw pr open --from CHILD --body-file pr-body.md [--title TITLE] [--draft] --json
olw report --from CHILD --id report:PACKET --outcome completed --pr URL --head SHA --evidence PATH --text-file result.txt --json
olw pr merge --from PARENT --pr URL_OR_NUMBER --json
```

The child PR body includes the issue key (stable ID when no key was imported), **verbatim criteria**
and evidence. OLW checks the key; review checks criteria/evidence, not a prose parser. Open validates
the owned-parent relationship, deliverable and checkout branch/origin, publishes the parent's
integration base and the child branch to origin with ordinary non-force pushes, then runs
`gh pr create --base INTEGRATION --head CHILD`. It returns `{url, head}`; an existing open PR
for that head branch is returned, not duplicated. A conflicting base/head is refused. Tracked
changes must be committed first; untracked local evidence/config files are not published.

Parent review precedes merge. Merge requires the latest accepted completed child report, validates
PR base, same-repository head branch and reported SHA, and uses
`gh pr merge --merge --match-head-commit SHA`. It fetches origin, fast-forwards the integration
branch, and pushes without force. A failed local update after remote merge is recoverable by
repeating the same command; it never resets a diverged branch or automatically resolves conflicts.
PR state, native report acceptance and review/Linear acceptance are separate facts.

For report/document, do not push or open a PR. Report with `--deliverable-path PATH_OR_URL` naming
an evidence file or existing Linear document. If implementation is needed, propose a new direct
issue to the parent; do not expand the PR-less assignment or write Linear from the child.

Project finish is `olw pr open --from PARENT --base DEFAULT_BRANCH [--body-file FILE] --json`.
It opens integration -> the approved default branch and stops for the user, never merges it.
The optional body defaults to a project-review notice; provide the actual project evidence.

`gh` uses the existing GitHub authentication and the binding's origin (not inherited `GH_REPO`).
Tests inject `OLW_GH_BIN` and a `file://` bare remote; no GitHub access is necessary.
Legacy `--repo` parents and their children retain the **deprecated local-merge flow**; PR helpers
refuse them. Deliverable selection does not migrate a legacy checkout to the new PR flow.

## Explicit local-only files and setup

Create `<root>/.omo/repos/config.json` locally (not in version control), keyed by the exact
snapshot remote URL:

```json
{
  "ssh://git@github.com/owner/repository.git": {
    "localFiles": [{ "source": "/absolute/secrets/project.env", "target": ".env" }],
    "setup": ["pnpm install --frozen-lockfile"],
    "setupTimeoutMs": 120000
  }
}
```

Only named sources are read: OLW never scans or copies from the user's repository. Each new
mapped parent and child gets its own copy, mode `0600`. Targets must be relative, cannot traverse
symlink directories, and cannot address `.git`. A target file is atomically replaced, not followed
as a symlink. Legacy checkouts and execute-stage tab reuse are not initialized again.

Receipts are recorded incrementally in `.omo/state/checkouts/<binding>.json` with source/target
paths and permissions, never file contents. Optional trusted shell commands execute sequentially
in the new checkout. Each has a deadline (default 120 seconds, maximum 600 seconds) that kills its
process group; nonzero exits and timeouts fail creation visibly, preserve the checkout, and retain
the receipt. Stdout/stderr are captured in private `0600` adjacent setup logs; copied contents and
lines are redacted before persistence. Commands themselves are not logged. Setup is trusted local
code: do not configure commands that disclose transformed/encoded secrets or send them externally.

See [operations](operations.md#closing-owned-parents) for preservation and unpushed-commit reports.
