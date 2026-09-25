# OMO Linear Workflow (OLW)

English | [한국어](README.ko.md)

A Bun CLI that connects approved Linear project or initiative scope to Herdr worktrees and OMO native threads. Linear owns scope and decisions. Local SQLite keeps the approved snapshot, execution authorization, runtime identity and delivery receipts.

## Setup

The supported installation target is **Linux x64**. Install Bun >=1.4.0,
Node.js >=24.20.0, pnpm 10.33.3 and Git first. With Node/npm already installed,
`npm install --global pnpm@10.33.3` selects the required pnpm version.
Then use a stable checkout path:

```sh
git clone https://github.com/thisisjun786/omo-linear-workflow.git ~/code/omo-linear-workflow
cd ~/code/omo-linear-workflow
bun run install:local
"$HOME/.local/bin/olw" --help
bun run herdr --version
bun run cli -- doctor --json
```

The installer runs a frozen dependency install and the complete managed build,
then creates `~/.local/bin/olw`. For another directory, use
`bun run install:local -- --bin-dir "$HOME/bin"`; the argument is a directory,
not the launcher filename. `bun run install:local --help` shows the options. It refuses to overwrite an
unrelated command or symlink. Re-running it from the same checkout is supported.
Keep the checkout at its installed path, and add the bin directory to PATH
manually if needed. The launcher preserves your working directory and passes
this checkout as the default control root.

No prerequisite installer, shell-profile edit, credential setup, proxy-policy
change or service/session restart is performed. The existing `omo` launcher is
not replaced. To uninstall, inspect and remove only the installed `olw` launcher;
your checkout, `.omo/` state and external access files remain.

`git` must be on PATH. The first build uses Rust 1.96.1 from Rustup and Zig 0.16.0
to prepare Herdr with the OMO support patch applied. If `cargo` or `zig` isn't on
PATH, point the `CARGO` and `ZIG` environment variables at the executables. Later
builds reuse the verified artifact, so Herdr isn't compiled on every build.

Herdr isn't an optional component you install and match separately. It's OLW's
required managed runtime. `bun run herdr` runs this build, and OLW creates its
roles inside Herdr. The TUI and the shared host run this repository's
`node_modules/.bin/omo`, so global OMO updates never mix versions. You also need
opencodex serving the role models below through its OMO client integration
(`ocx integration client enable --client omo`). This repository doesn't issue or
copy provider credentials. Account logins are managed in opencodex.

## Contributing and releases

[CONTRIBUTING.md](CONTRIBUTING.md) covers issues, focused PRs, verification and
review expectations; GitHub supplies bug/feature forms and a PR template.
[Version and release policy](docs/releases.md) defines SemVer, `vVERSION` tags,
source-only releases, upgrades and rollback. [CHANGELOG.md](CHANGELOG.md) holds
release notes. `bun run release:check` validates the package version and notes.
CI runs without provider credentials and includes the required native Herdr
build and an isolated installation smoke test. A maintainer-pushed version tag
runs those checks before publishing a GitHub release. The clone above installs
`main`; add `--branch v0.1.0` to install the first release instead. See
[GitHub Releases](https://github.com/thisisjun786/omo-linear-workflow/releases)
for published versions and source archives.

## Models through opencodex

OLW role sessions and the shared host use OMO's `opencodex` provider directly.
opencodex's OMO integration keeps `providers.opencodex` in `~/.omo/agent/models.json`
current; OLW only reads it and loads no model extension of its own. Model
registration, enablement and account logins belong to opencodex: enable or
disable a model there, not in OLW. Do not add `modelOverrides` inside
`providers.opencodex`, because opencodex treats foreign edits to its block as a
conflict and stops refreshing it.

### Automatic upstream routing tracking

Before a regular `omo` or `omon` start and before OLW prepares its shared host,
the installed global OMO's version and the actual policy bundle hash are checked.
When they change, or when the models opencodex publishes to OMO change, the
category and agent model order and thinking levels are mapped onto that opencodex
list (`providers.opencodex` in `models.json`, kept current by
`ocx integration client enable --client omo`). Routing the user changed by hand
afterwards is protected. If a chain can't be mapped or the bundle format is new, the previous
settings are kept and an error is reported. The current session isn't restarted,
and OLW's Parent and Child model assignments aren't changed.

```sh
bun run proxy:routing status
bun run proxy:routing check --force
bun run proxy:routing sync --force
```

Initial activation, ownership boundaries, recovery and the execution path are
described in the [automatic routing operations guide](docs/proxy-routing.md).

Verification: `bun test tests/proxy`, `bun run typecheck`, `bun run qa:proxy`.
The last command uses real accounts to verify file-reading tool calls for the
three role models through opencodex. It doesn't create or change Herdr
workspaces or existing role sessions.

Linear authentication and lookups go through OMO's existing Linear MCP connection. When authentication is needed, the user runs `/mcp auth linear`. Then ask OMO to read `skills/define/SKILL.md` (`olw-define`) and `skills/plan/SKILL.md` (`olw-plan`) to prepare a revision-pinned snapshot. Import doesn't prove remote authentication or the latest revision, so the MCP verification steps in the skills must not be skipped. The local QA fixture `tests/fixtures/scope.json` must always be imported with `--fixture`.

See [`tests/fixtures/scope.json`](tests/fixtures/scope.json) for the snapshot format. A local input check runs like this:

```sh
bun run cli -- scope import --file tests/fixtures/scope.json --fixture --json
```

For `--scope-digest`, use `value.digest` from the import response. It isn't a hash of the file itself. `--designation` is a unique name that distinguishes this run, and `BINDING` is the `binding.id` from each create response (`value.binding.id` with `--json`).

## Commands

```sh
bun run cli -- --root "$PWD" scope import --file approved-scope.json
bun run cli -- --root "$PWD" parent create --scope-digest SHA --designation ID --execute --project ID --repo /abs/repo --base main
bun run cli -- --root "$PWD" child create --parent BINDING --issue ID
bun run cli -- --root "$PWD" send --from BINDING --to BINDING --id MSG --kind instruction --text-file brief.txt
bun run cli -- --root "$PWD" report --from BINDING --id MSG --outcome completed --evidence /abs/path --text-file result.txt
bun run cli -- --root "$PWD" reports --project ID --json
bun run cli -- --root "$PWD" notices --project ID --json
bun run cli -- --root "$PWD" status --project ID --json
bun run cli -- --root "$PWD" pause --binding BINDING
bun run cli -- --root "$PWD" resume --binding BINDING
bun run cli -- --root "$PWD" reconcile --project ID
bun run cli -- --root "$PWD" close --binding BINDING
```

A project parent is the execution unit. It can start without any supervisor or initiative;
use `"initiative": null` in a project-only snapshot. Standalone creation requires an explicit
scope digest, designation and `--execute` (`--fixture` for fixture approval). A supervisor is
an optional, explicitly created management session:

```sh
bun run cli -- supervisor create --initiative ID --scope-digest MANAGER_SHA --designation MANAGER_ID --execute
bun run cli -- parent link --parent PARENT --supervisor MANAGER
bun run cli -- parent unlink --parent PARENT
# Alternative creation mode for a project that has no live parent:
bun run cli -- parent create --supervisor MANAGER --project ID --repo /abs/repo --base main
```

Do not mix `--supervisor` with standalone approval flags. Linking an initialized parent may
cross designations if the manager's approved snapshot includes the project and both approvals
permit execution/contact. It changes only the optional management link, never the parent's
approval, issue set, worktree, pause state or identity. No hidden role or automatic replay is
created. `status`, `reports`, `notices`, and `reconcile` accept `--project` or `--initiative`; filters use
approved scope provenance, not later manager membership. `reports` and `notices` also allow no filter.

`--root` is this tool's control root, and `$PWD` in the examples above is this repository. The actual target repository is given separately through `--repo` on `parent create`.

The default Herdr socket comes from the current pane's `HERDR_SOCKET_PATH`. Pass `--herdr-socket /abs/socket` only when selecting a different server. Creating and shutting down isolated QA servers is handled by the QA scripts below. Exit codes: 0 success, 2 invalid scope or input, 3 runtime unavailable, 4 uncertain outcome.

## Roles

| Role | Model / reasoning | Workspace |
| --- | --- | --- |
| Supervisor (optional) | `opencodex/gpt-6-astra` / `high` | control root Herdr workspace |
| Parent | `opencodex/anthropic/claude-opus-5-5` / `xhigh` | project integration branch worktree |
| Child | `opencodex/anthropic/claude-opus-5-5` / `xhigh` | issue worktree based on the parent branch |

These assignments apply to new bindings. Existing bindings keep the model,
provider and thinking level recorded at their initial session as the verification
baseline, and reconcile doesn't automatically switch running sessions to the new
policy.

New issue children start in **mass-ulw mode**, but wait for the parent's explicit
issue packet before creating a goal or workflow. The child uses native DAG workers
inside that issue, verifies their artifacts and reports once to its parent. Those
workers are category-routed tasks, not extra OLW/Linear roles; the parent still
verifies and integrates the delivery. See the [child execution contract](skills/run/SKILL.md#child)
for scope, phase keys, evidence and recovery. This is an execution policy using
OMO's existing workflow engine, not a new sandbox or scheduler. Existing bindings
aren't reinitialized automatically.

## Behavior

Herdr creates the workspace and the parent and child worktrees. The parent branch is `omo/<designation>/projects/<project>-<binding>`, the child branch is `omo/<designation>/issues/<issue>-<binding>`, and the child's base is a verified commit on the parent branch. The new binding suffix lets you replace a role while keeping the earlier working branch.

Each new parent is an explicit top-level Herdr group head; its children join by the actual parent workspace ID. Two projects in one Git repository stay separate. Manager links and pause/resume do not move groups. Existing legacy parents keep their existing layout, and unrelated workspaces/focus are not changed. An older server must support the managed grouped-worktree RPC before creating new parent groups; no fallback silently changes the layout.

The controller subscribes to file events first, then launches OMO. When the TUI's `session_start` atomically writes a readiness record under `.omo/state/ready/`, the controller connects to that exact session through the public OMO RPC, sets and verifies the model and reasoning, and then sends the first instruction. It doesn't rely on Herdr's OMO detection or on unsupported session-path reports.

The initial instruction leaves a persistent claim before it's sent. The role stays `initializing` until actual acceptance is confirmed, and becomes `ready` only after that. If the ACK is lost, acceptance is confirmed from the exact user message or delivery receipt already stored. Without evidence, nothing is resent.

Later communication between sessions uses the native `thread_send` with `delivery: auto`. A waiting parent resumes on a child's report. There's no separate agent polling loop and no custom message broker. Accepted messages replay their stored receipt; sending/uncertain messages are not resent. Only `turn_conflict_before_delivery` proves that the target was not invoked: repeating the identical command with the same logical ID rechecks authorization and claims one successor native key. `delivery.attempts` retains earlier keys and receipts, and late results cannot overwrite a newer attempt. Legacy `turn_conflict` is not that proof.

Parent reports with no linked manager, or an absent/not-ready/closed manager, are recorded
in a local user-addressed inbox. `report --to-user` explicitly selects that inbox even when
a manager is ready or paused. Read it with `reports --project ID --json`; use `blocked` for
an exact user question and `failed` for a failure with evidence. Answer by prompting the
parent's exact durable session. `state: "posted"`, `toBindingId: null`, `receipt: null` means
recorded locally, **not native acceptance, user acknowledgment, or Linear completion**.
Posting and reading reports wake nobody. There is no synthetic user Binding.

A paused manager blocks new native contact to itself, not parent-child work or explicit user
posts; a paused parent blocks its own new contact/posts. If the manager's runtime disappears
while stored state still says ready, inspect the native attempt and use `--to-user` for a
distinct notice about that failure/question. Never silently migrate that attempt. Repeating a
report ID reads its original recipient and receipt after link/unlink/close; changed payload or
an explicit recipient change conflicts, and sending/uncertain records remain unresolved.
Existing native rejection/uncertainty exit codes stay nonzero; a successful local post exits 0
without claiming native acceptance.

Explicit native assistant errors create separate `operational_notice` records, not completion reports. `notices --project ID --json` reads all recorded operational outcomes without a live host. Healthy owners receive one claimed native notice; absent/paused routes remain visible locally without waking anyone. The notice preserves the original binding and error entry, while `ready` remains an identity/initialization status. Normal idle, cancellation and reload alone are not errors. See [maintained runtime repairs](docs/runtime-patches.md) for native patch ownership and verification boundaries.

The native thread tools may create `.omo/thread-tools/` in the target working repository. Add this runtime path to the working repository's ignore rules so generated files don't interfere with commits or worktree cleanup.

```gitignore
.omo/thread-tools/
```

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

`qa:child-workflow` uses real proxy models and an isolated three-role fixture.
`happy` checks a child-owned DAG with parallel producers and dependent verification,
then one claimed report. `failed-node` checks an invalid completed producer, recovery
by amending the same run, and reuse of successful work. After the native parent
acknowledgment, it checks durable run/node history and independent file-verification
receipts, then cleans up the owned runtime. It does not trust the agent's completion
claim or access live Linear.

## Recovery and shutdown

`status` shows stored state. `reconcile` checks every active role's Herdr resources and actual native identity once. Roles that have disappeared are marked `uncertain` and aren't recreated automatically. A shutdown that was already requested can be continued.

`close` on a parent requires closing its issue children first. An optional manager can close
independently, leaving parent links visible and parent/child work untouched. `parent unlink`
works even when the manager is gone. Closure closes the workspace and the exact native session, then releases ownership, **preserving worktree files, branches and session records**. If another client is attached to the native session or the resource identity has changed, it keeps ownership and returns an error. Detach the observing client and run it again.

Existing registry rows, designations, initial briefs and delivery receipts need no SQL
migration or rewriting. Parents and children remain linked Git worktrees; no clone/push
semantics are introduced. Link/unlink, resume and reconnect do not recreate a parent or
replay earlier work. Scope expansion still requires fresh approval.

If the workspace creation response itself was lost, check Herdr directly. Only after confirming that no workspace was created, release the unconfirmed reservation with `close --binding ID --confirm-absent`. Closed roles aren't reopened. Create a new binding under the same approval instead.

## Limits

One Herdr server and one native OMO host are used. Automatic merge, release and Linear mutation aren't provided. Native acceptance, work completion reports and Linear acceptance are different states. `pause` and `resume` only change whether contact is allowed. They don't recreate sessions. Shutdown or an uncertain work outcome doesn't mean Linear completion.

QA with real Herdr, real models and real reports has passed. New managed supervisor and parent sessions also verified actual Linear MCP discovery, first-use activation, authenticated project/document/issue reads, and reload using the existing OAuth connection. With explicit user approval, a managed parent also created one temporary Linear issue, updated and independently read it back, then canceled it and verified the final state. No existing business issue was changed. Whether the default Herdr supports OMO detection is separate from this CLI's execution and communication.

## Managed Herdr

The [pinned manifest](vendor/herdr/manifest.json), the [OMO support patch](patches/herdr-0.9.1-omo.patch)
and the [build, update and recovery guide](vendor/herdr/README.md) are Herdr's ownership points.
Artifact locations are keyed by upstream commit, patch hash and Rust/Zig versions,
and the receipt and the executable's SHA-256 are verified before running. A missing
or mismatched artifact is never silently replaced with a Herdr from the global PATH.

`bun run build` prepares the whole runtime including Herdr, while `bun run herdr:build`
runs only the Herdr step. New role TUIs and the shared host receive this binary
directory at the front of PATH. Existing servers, bindings and workspaces aren't
restarted or migrated automatically.

The Linux x64 binary rebuilt at integration time had the same SHA-256 as the
existing installation and the server actually running. The original
`~/code/herdr-omo-0.9.1` and the older `~/code/herdr-omo` were preserved, but
future builds don't depend on those external source trees.
The verification record is in [managed Herdr evidence](.omo/evidence/managed-herdr-integration.md).
