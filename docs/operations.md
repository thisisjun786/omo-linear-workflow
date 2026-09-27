# Operations

## Official Herdr runtime and switch gate

`herdr-release.json` pins official v0.9.1 assets from
`https://github.com/herdrdev/herdr/releases/download/v0.9.1/`. `bun run build`
(or `bun run herdr:build`) downloads the current platform asset to `.omo/herdr/bin/`
and verifies its SHA-256 before publishing it. Every use also checks the digest.
No compiler, patched source, build receipt or arbitrary global PATH binary is used.
A bad download is never published. An occupied invalid cache is rejected; inspect
and move only the named artifact directory aside before downloading it again.

Before any operational switch, run `olw doctor --json` against the control root.
`legacy_parents_remaining` lists every non-closed parent without an owned clone,
including binding ID, project ID, cwd and workspace ID. The switch is blocked until
those parents are resolved with user approval. Do not rewrite binding identities
or silently regroup linked worktrees. Create new parents with repository mappings;
`--repo` is a deprecated legacy path, not a supported official-server group setup.

Senpi's built-in integration reports `pi`; OLW also recognizes older `omo` labels.
It owns session reports and active/blocked/idle state, including detached eval work.
OLW only publishes its own readiness receipt and does not send duplicate Herdr
session reports. The old `~/.omo/agent/extensions/herdr-senpi-agent-state.ts` should
be removed only during a separately approved operational switch. A build does not
remove that extension, change `~/.local/bin/herdr`, replace an existing live control
root's `.omo/herdr`, or restart any server.

### One-release rollback

Retain the previous patched `.omo/herdr/bin` version directory and its `build.json`
for one release. Do not delete `~/.local/bin/herdr` or the live control root's cache.
The complete pre-switch source contract (manifest, patch and build logic) is retained
in Git at `5b81040`. To roll back, use a separate checkout of that revision and copy
(not link) the matching retained patched artifact directory into its `.omo/herdr/bin`.
Its original resolver validates the build receipt and executable digest. If that
cache is gone, follow `vendor/herdr/README.md` at that revision to rebuild with its
pinned toolchains. Never replace an official artifact with a patched binary under
the same path: checksum verification will reject it.

Switching the launcher/control-root selection and stopping or restarting a live
server require separate user approval. Restoring files alone does not switch the
running server. Preserve all registry, worktree and session state; inspect legacy
parents before deciding which server to start. This release performs none of those
operational actions.

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

## Isolated official-runtime QA

`bun run qa:two-stage --official-offline` exercises real Senpi TUIs, the shared host,
OLW CLI/registry/delivery, and an isolated official Herdr server. Only inference is
replaced by a deterministic no-network provider. It verifies built-in `pi` detection,
manager focus and reattach, child-to-parent-to-manager question escalation and answers,
plan-to-execute tabs, and two owned parent/child groups. It neither reads live credentials
nor links the live control root. Herdr update checks are disabled and the checksum-verified
binary is copied to the temporary control root's managed artifact directory. Its receipt
is `.omo/evidence/lina-275-official-qa.json`, including cleanup. The ordinary real-model
`qa:two-stage` remains available only when credential/network use is separately allowed.

## Isolated owned-clone QA

`bun scripts/qa-owned-clones.ts` copies the verified managed Herdr artifact into a temporary
control root, disables update checks, and uses a temporary HOME, a unique server,
a temporary bare remote, recording client wrapper and direct server snapshot. It exercises the real CLI, registry, Git,
Herdr workspaces/worktrees, plan/execute tabs, child PR open/report/parent merge, project PR open
and close. Native model execution/readiness and GitHub are simulated (a recording gh shim performs
real Git merges against the bare remote), so no credentials/network are needed. It verifies the
remote integration branch advances through a merge commit, project PRs leave the default branch
unchanged, separate project common-dir keys and no `worktree.create_grouped`. It removes its server
and all fixture files. The receipt is `.omo/evidence/lina-274-qa.json`; it never contacts user Herdr.
