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

Unmapped projects can still use `--repo PATH --base REF`; `--repo` is deprecated in help JSON.
A mapping and `--repo` together are an error, not an override. Existing rows without a checkout
kind decode as `linked-worktree`, including read-only status. No old checkout is moved or migrated,
and legacy `originalRepoRoot` continues to identify the user's repository.

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
