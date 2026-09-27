# Operations

This guide holds the operational detail behind the [README](../README.md): install details, how OLW uses opencodex, scope import, parents and the manager, roles and models, runtime behavior, the official Herdr runtime and its switch gate, verification, recovery, limits, and contribution rules.

## Install details

The supported installation target is **Linux x64**. Install Bun >=1.4.0, Node.js >=24.20.0, pnpm 10.33.3 and Git first. With Node/npm already installed, `npm install --global pnpm@10.33.3` selects the required pnpm version. Then clone to a stable checkout path and run:

```sh
bun run install:local
"$HOME/.local/bin/olw" --help
bun run herdr --version
bun run cli -- doctor --json
```

The installer runs a frozen dependency install and the complete managed build, then creates `~/.local/bin/olw`. For another directory, use `bun run install:local -- --bin-dir "$HOME/bin"`; the argument is a directory, not the launcher filename. `bun run install:local --help` shows the options. It refuses to overwrite an unrelated command or symlink. Re-running it from the same checkout is supported. Keep the checkout at its installed path, and add the bin directory to PATH manually if needed. The launcher preserves your working directory and passes this checkout as the default control root.

No prerequisite installer, shell-profile edit, credential setup, proxy-policy change or service/session restart is performed. The existing `omo` launcher isn't replaced. To uninstall, inspect and remove only the installed `olw` launcher; your checkout, `.omo/` state and external access files remain.

`git` must be on PATH. The first build downloads the official Herdr 0.9.1 release asset and verifies its pinned SHA-256. No Rust or Zig is needed. Later builds verify and reuse the managed artifact. A checksum mismatch fails closed.

Herdr isn't an optional component you install and match separately. It's OLW's required managed runtime. `bun run herdr` runs this build, and OLW creates its roles inside Herdr. The TUI and the shared host run this repository's `node_modules/.bin/omo`, so global OMO updates never mix versions. You also need opencodex serving the role models through its OMO client integration (`ocx integration client enable --client omo`). This repository doesn't issue or copy provider credentials. Account logins are managed in opencodex.

The clone in the README installs `main`, the latest released commit; add `--branch v0.1.0` to install the first release instead. See [GitHub Releases](https://github.com/thisisjun786/omo-linear-workflow/releases) for published versions and source archives.

## Models through opencodex

OLW role sessions and the shared host use OMO's `opencodex` provider directly. opencodex's OMO integration keeps `providers.opencodex` in `~/.omo/agent/models.json` current; OLW only reads it and loads no model extension of its own. Model registration, enablement and account logins belong to opencodex: enable or disable a model there, not in OLW. Don't add `modelOverrides` inside `providers.opencodex`, because opencodex treats foreign edits to its block as a conflict and stops refreshing it.

### Pinned upstream routing review

Before a regular `omo` or `omon` start and before OLW prepares its shared host, the installed global OMO policy and opencodex catalog are checked. Routing is pinned by default: upstream route and catalog changes are reported, never applied automatically. The launcher stays quiet when unchanged and prints a non-blocking review command when findings exist. Selective apply keeps backups and a recovery journal; `--follow` retains the former automatic mode. OLW role assignments are reviewed for catalog health but are never silently changed.

```sh
bun run proxy:routing status
bun run proxy:routing check --force
bun run proxy:routing apply categories.deep-low
bun run proxy:routing dismiss categories.deep-low
bun run proxy:routing baseline save
```

Initial activation, ownership boundaries, recovery and the execution path are described in the [pinned routing guide](proxy-routing.md).

Verification: `bun test tests/proxy`, `bun run typecheck`, `bun run qa:proxy`. The last command uses real accounts to verify file-reading tool calls for the three role models through opencodex. It doesn't create or change Herdr workspaces or existing role sessions.

## Scope import

Linear authentication and lookups go through OMO's existing Linear MCP connection. When authentication is needed, the user runs `/mcp auth linear`. Then ask OMO to read `skills/define/SKILL.md` (`olw-define`) and `skills/plan/SKILL.md` (`olw-plan`) to prepare a revision-pinned snapshot. Import doesn't prove remote authentication or the latest revision, so the MCP verification steps in the skills must not be skipped. The local QA fixture `tests/fixtures/scope.json` must always be imported with `--fixture`.

See [`tests/fixtures/scope.json`](../tests/fixtures/scope.json) for the snapshot format. A local input check runs like this:

```sh
bun run cli -- scope import --file tests/fixtures/scope.json --fixture --json
```

For `--scope-digest`, use `value.digest` from the import response. It isn't a hash of the file itself. `--designation` is a unique name that distinguishes this run, and `BINDING` is the `binding.id` from each create response (`value.binding.id` with `--json`).

Each project must declare its target remote/default branch in the approved [scope repository mapping](repositories.md). The deprecated `parent create --repo` path is rejected.

## Parents, supervisors and the manager

A project parent is the execution unit. It can start without any supervisor or initiative; use `"initiative": null` in a project-only snapshot. Standalone creation requires an explicit scope digest, designation and `--execute` (`--fixture` for fixture approval). A supervisor is an optional, explicitly created management session:

```sh
bun run cli -- supervisor create --initiative ID --scope-digest MANAGER_SHA --designation MANAGER_ID --execute
bun run cli -- parent link --parent PARENT --supervisor MANAGER
bun run cli -- parent unlink --parent PARENT
# Alternative creation mode for a project that has no live parent:
bun run cli -- parent create --supervisor MANAGER --project ID
```

Don't mix `--supervisor` with standalone approval flags. Linking an initialized parent may cross designations if the manager's approved snapshot includes the project and both approvals permit execution/contact. It changes only the optional management link, never the parent's approval, issue set, worktree, pause state or identity. No hidden role or automatic replay is created. `status`, `reports`, `questions`, `notices` and `reconcile` accept `--project` or `--initiative`; filters use approved scope provenance, not later manager membership. `reports`, `questions` and `notices` also allow no filter.

The management session is the session you direct. `manage` opens it inside the OLW host with your default model, or reattaches to the existing one; parents created while it's ready link to it unless `parent create --no-manager` is passed. `manage` also runs an update check and puts the result in the manager's brief:

```sh
bun run cli -- --root "$PWD" manage --json
bun run cli -- --root "$PWD" update check --json          # pinned versions vs npm dist-tags; never installs
bun run cli -- --root "$PWD" update prepare --json        # update branch + PR to dev in a separate worktree; never merges
```

`update check` compares the pinned `omo-ai` (`beta`) and `@code-yeongyu/senpi` (`latest`) versions with npm; `--tag pkg=tag` overrides a dist-tag. `update prepare` creates `olw/update-omo-<v>-senpi-<v>` from the remote's `dev` in a separate worktree (`--remote NAME|URL` picks a GitHub remote to fetch `dev` from and push to; default `origin`; non-GitHub remotes are refused), runs install, typecheck, test and build there and opens a PR to `dev` (a draft if anything failed). It never touches the live host.

`--root` is this tool's control root, and `$PWD` in the examples is this repository. The default Herdr socket comes from the current pane's `HERDR_SOCKET_PATH`. Pass `--herdr-socket /abs/socket` only when selecting a different server. Creating and shutting down isolated QA servers is handled by the QA scripts below.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | success |
| 2 | invalid scope or input |
| 3 | runtime unavailable |
| 4 | uncertain outcome |

## Child modes and stages

`--mode` picks how a child works, one of `direct`, `planned` or `research`: `direct` (default, one session, mass-ulw), `planned` (a plan stage on Fable 5.1 with ulw-plan, then an execute stage on Opus 5.5 medium with ulw-execute; both stages share one worktree, each in its own Herdr tab) or `research` (ulw-research). A child asks its parent with the `olw_ask` tool; the parent answers with `answer`, and escalates with `ask` to the manager or, without one, to the user inbox that `questions` lists and `answer --as-user` answers. After approving a plan the plan stage runs `stage complete` and the parent runs `stage start`, which stops the plan session and opens the execute stage under a new binding ID. Then send the issue packet to that binding; its envelope ID is the packet ID the execute stage reports under. The design is in [two-stage children](two-stage-children.md).

New issue children in `direct` mode start in **mass-ulw mode**, but wait for the parent's explicit issue packet before creating a goal or workflow. The child uses native DAG workers inside that issue, verifies their artifacts and reports once to its parent. Those workers are category-routed tasks, not extra OLW/Linear roles; the parent still verifies and integrates the delivery. See the [child execution contract](../skills/run/SKILL.md#child) for scope, phase keys, evidence and recovery. This is an execution policy using OMO's existing workflow engine, not a new sandbox or scheduler. Existing bindings aren't reinitialized automatically.

## Roles and models

| Role | Model / reasoning | Workspace |
| --- | --- | --- |
| Manager (`olw manage`) | your default model from `~/.omo/agent/settings.json` (fallback `opencodex/anthropic/claude-opus-5-5` / `medium`) | control root Herdr workspace |
| Supervisor (optional) | `opencodex/gpt-6-astra` / `high` | control root Herdr workspace |
| Parent | `opencodex/anthropic/claude-opus-5-5` / `xhigh` | project integration branch checkout |
| Child, `direct` or `research` | `opencodex/anthropic/claude-opus-5-5` / `xhigh` | issue worktree based on the parent branch |
| Child, `plan` stage | `opencodex/anthropic/claude-fable-5-1` / `xhigh` | the same issue worktree, its own tab |
| Child, `execute` stage | `opencodex/anthropic/claude-opus-5-5` / `medium` | the same issue worktree, a second tab |

These assignments apply to new bindings. Existing supervisor, parent and child bindings keep the model, provider and thinking level recorded at their initial session as the verification baseline, and reconcile doesn't automatically switch running sessions to the new policy. The manager is the exception: it starts on your OMO default model, its identity check doesn't pin provider, model or thinking, and activation doesn't configure its model, so you can change models in it freely.

## Behavior

Herdr creates the workspace and the parent and child worktrees. The parent branch is `omo/<designation>/projects/<project>-<binding>`, the child branch is `omo/<designation>/issues/<issue>-<binding>`, and the child's base is a verified commit on the parent branch. The new binding suffix lets you replace a role while keeping the earlier working branch.

Each new parent owns an independent clone; official Herdr groups its children by that clone's Git common directory. Two projects targeting one remote stay separate. Manager links and pause/resume don't move groups. Child and successor creation for a legacy linked-worktree parent fails with `legacy_parent_unsupported` before external side effects. Close or migrate it with approval, or continue it on the retained pre-switch OLW/patched Herdr stack per [rollback](#one-release-rollback). Existing workspaces are never silently regrouped.

The controller subscribes to file events first, then launches OMO. When the TUI's `session_start` atomically writes a readiness record under `.omo/state/ready/`, the controller connects to that exact session through the public OMO RPC, sets and verifies the model and reasoning (skipped for the manager), and then sends the first instruction. It doesn't rely on Herdr's OMO detection or on unsupported session-path reports.

The initial instruction leaves a persistent claim before it's sent. The role stays `initializing` until actual acceptance is confirmed, and becomes `ready` only after that. If the ACK is lost, acceptance is confirmed from the exact user message or delivery receipt already stored. Without evidence, nothing is resent.

Later communication between sessions uses the native `thread_send` with `delivery: auto`. A waiting parent resumes on a child's report. There's no separate agent polling loop and no custom message broker. Accepted messages replay their stored receipt; sending/uncertain messages aren't resent. Only `turn_conflict_before_delivery` proves that the target wasn't invoked: repeating the identical command with the same logical ID rechecks authorization and claims one successor native key. `delivery.attempts` retains earlier keys and receipts, and late results can't overwrite a newer attempt. Legacy `turn_conflict` isn't that proof.

### Reports to the user

Parent reports with no linked manager, or an absent/not-ready/closed manager, are recorded in a local user-addressed inbox. `report --to-user` explicitly selects that inbox even when a manager is ready or paused. Read it with `reports --project ID --json`; use `blocked` for an exact user question and `failed` for a failure with evidence. Answer by prompting the parent's exact durable session. `state: "posted"`, `toBindingId: null`, `receipt: null` means recorded locally, **not native acceptance, user acknowledgment, or Linear completion**. Posting and reading reports wake nobody. There's no synthetic user Binding.

A paused manager blocks new native contact to itself, not parent-child work or explicit user posts; a paused parent blocks its own new contact/posts. If the manager's runtime disappears while stored state still says ready, inspect the native attempt and use `--to-user` for a distinct notice about that failure/question. Never silently migrate that attempt. Repeating a report ID reads its original recipient and receipt after link/unlink/close; changed payload or an explicit recipient change conflicts, and sending/uncertain records remain unresolved. Existing native rejection/uncertainty exit codes stay nonzero; a successful local post exits 0 without claiming native acceptance.

### Operational notices

Explicit native assistant errors create separate `operational_notice` records, not completion reports. `notices --project ID --json` reads all recorded operational outcomes without a live host. Healthy owners receive one claimed native notice; absent/paused routes remain visible locally without waking anyone. The notice preserves the original binding and error entry, while `ready` remains an identity/initialization status. Normal idle, cancellation and reload alone aren't errors. See [maintained runtime repairs](runtime-patches.md) for native patch ownership and verification boundaries.

### Ignore the thread tools directory

The native thread tools may create `.omo/thread-tools/` in the target working repository. Add this runtime path to the working repository's ignore rules so generated files don't interfere with commits or worktree cleanup.

```gitignore
.omo/thread-tools/
```

## Official Herdr runtime and switch gate

The [release manifest](../herdr-release.json) pins official v0.9.1 assets and SHA-256 checksums
for Linux and macOS x64/arm64 (the supported OLW installer target remains Linux x64) from
`https://github.com/herdrdev/herdr/releases/download/v0.9.1/`. `bun run build`
(or `bun run herdr:build`) downloads the current platform asset to `.omo/herdr/bin/`,
keyed by version, platform and checksum, and verifies its SHA-256 before publishing it.
Every use also checks the digest. No compiler, patched source, build receipt or arbitrary
global PATH binary is used. A bad download is never published. An occupied invalid cache is
rejected; inspect and move only the named artifact directory aside before downloading it again.

`bun run build` prepares the whole runtime including Herdr, while `bun run herdr:build`
runs only the Herdr step. New role TUIs and the shared host receive this binary directory
at the front of PATH. Existing servers, bindings and workspaces aren't restarted or migrated
automatically.

Before any operational switch, run `olw doctor --json` against the control root.
`legacy_parents_remaining` lists every non-closed parent without an owned clone,
including binding ID, project ID, cwd and workspace ID. The switch is blocked until
those parents are resolved with user approval. Do not rewrite binding identities
or silently regroup linked worktrees. Create new parents with repository mappings;
`parent create --repo` is rejected. `child create` (all modes) and `stage start`
for a legacy linked-worktree parent return `legacy_parent_unsupported` before
Herdr, Git, host access or role reservation. Close or migrate that parent with
user approval, or continue it using the retained pre-switch OLW checkout together
with its matching patched Herdr stack as described below. Using the new CLI with
the old server does not restore explicit-group support.

Senpi's built-in integration reports `pi`; OLW also recognizes older `omo` labels.
It owns session reports and active/blocked/idle state, including detached eval work.
OLW only publishes its own readiness receipt and does not send duplicate Herdr
session reports (`pane.report_agent_session`). Owned parent clones naturally form
separate groups by Git common directory; children use the official `worktree.create` RPC.
The old `~/.omo/agent/extensions/herdr-senpi-agent-state.ts` should
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

## Verification

```sh
bun test
bun run typecheck
bun run lint
bun run build
bun run qa:events
bun run qa:child-workflow happy
bun run qa:child-workflow failed-node
bun run qa:linear
```

`qa:events` runs against an isolated Herdr server and a Git fixture. It checks the three roles' actual models, worktree ancestry, focus preservation, automatic resume on report, duplicate prevention, runtime-loss detection and data retention on close, then cleans up its resources. The default Herdr is the managed artifact, and the same manifest, patch and receipt are passed to the QA control root. `qa:linear` wires a local HTTP fixture into the real OMO MCP execution path and confirms that all four skills load. To test compatibility with a different server build, set `QA_HERDR_BINARY=/abs/herdr` explicitly. A passing isolated QA run doesn't by itself prove the TUI behavior of the server currently in use.

`qa:child-workflow` uses real proxy models and an isolated three-role fixture. `happy` checks a child-owned DAG with parallel producers and dependent verification, then one claimed report. `failed-node` checks an invalid completed producer, recovery by amending the same run, and reuse of successful work. After the native parent acknowledgment, it checks durable run/node history and independent file-verification receipts, then cleans up the owned runtime. It doesn't trust the agent's completion claim or access live Linear.

QA with real Herdr, real models and real reports has passed. New managed supervisor and parent sessions also verified actual Linear MCP discovery, first-use activation, authenticated project/document/issue reads, and reload using the existing OAuth connection. With explicit user approval, a managed parent also created one temporary Linear issue, updated and independently read it back, then canceled it and verified the final state. No existing business issue was changed. Whether the default Herdr supports OMO detection is separate from this CLI's execution and communication.

### Isolated official-runtime QA

`bun run qa:two-stage --official-offline` exercises real Senpi TUIs, the shared host,
OLW CLI/registry/delivery, and an isolated official Herdr server. Only inference is
replaced by a deterministic no-network provider. It verifies built-in `pi` detection,
manager focus and reattach, child-to-parent-to-manager question escalation and answers,
plan-to-execute tabs, and two owned parent/child groups. It neither reads live credentials
nor links the live control root. Herdr update checks are disabled and the checksum-verified
binary is copied to the temporary control root's managed artifact directory. Its receipt
is `.omo/evidence/lina-275-official-qa.json`, including cleanup. The ordinary real-model
`qa:two-stage` remains available only when credential/network use is separately allowed.

### Isolated owned-clone QA

`bun scripts/qa-owned-clones.ts` copies the verified managed Herdr artifact into a temporary
control root, disables update checks, and uses a temporary HOME, a unique server,
a temporary bare remote, recording client wrapper and direct server snapshot. It exercises the real CLI, registry, Git,
Herdr workspaces/worktrees, plan/execute tabs, child PR open/report/parent merge, project PR open
and close. Native model execution/readiness and GitHub are simulated (a recording gh shim performs
real Git merges against the bare remote), so no credentials/network are needed. It verifies the
remote integration branch advances through a merge commit, project PRs leave the default branch
unchanged, separate project common-dir keys and no `worktree.create_grouped`. It removes its server
and all fixture files. The receipt is `.omo/evidence/lina-274-qa.json`; it never contacts user Herdr.

## Recovery and shutdown

`status` shows stored state. `reconcile` checks every active role's Herdr resources and actual native identity once. Roles that have disappeared are marked `uncertain` and aren't recreated automatically. A shutdown that was already requested can be continued.

`close` on a parent requires closing its issue children first. An optional manager can close independently, leaving parent links visible and parent/child work untouched. `parent unlink` works even when the manager is gone. Closure closes the workspace and the exact native session, then releases ownership, **preserving worktree files, branches and session records**. If another client is attached to the native session or the resource identity has changed, it keeps ownership and returns an error. Detach the observing client and run it again.

Existing registry rows, designations, initial briefs and delivery receipts need no SQL migration or rewriting. Legacy parents and their children remain linked Git worktrees; the switch doesn't convert them to clones. Link/unlink, resume and reconnect don't recreate a parent or replay earlier work. Scope expansion still requires fresh approval.

If the workspace creation response itself was lost, check Herdr directly. Only after confirming that no workspace was created, release the unconfirmed reservation with `close --binding ID --confirm-absent`. Closed roles aren't reopened. Create a new binding under the same approval instead.

## Limits

One Herdr server and one native OMO host are used. Automatic merge, release and Linear mutation aren't provided. Native acceptance, work completion reports and Linear acceptance are different states. `pause` and `resume` only change whether contact is allowed. They don't recreate sessions. Shutdown or an uncertain work outcome doesn't mean Linear completion.

## Contributing and releases

[CONTRIBUTING.md](../CONTRIBUTING.md) covers issues, focused PRs, verification and review expectations; the policies under [docs/policy](policy/pull-requests.md) state the branch rules: PRs target `dev` and merge with a merge commit, `main` is the released source, and only an owner-authorized release advances it. GitHub supplies bug/proposal forms and a PR template. [Version and release policy](policy/releases.md) defines SemVer, `vVERSION` tags, source-only releases, upgrades and rollback. [CHANGELOG.md](../CHANGELOG.md) holds release notes. `bun run release:check` validates the package version and notes. CI runs without provider credentials and includes the checksum-verified official Herdr download and an isolated installation smoke test. An owner-pushed version tag runs those checks before publishing a GitHub release.
