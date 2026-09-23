# OMO Linear Workflow (OLW)

English | [한국어](README.ko.md)

A Bun CLI that connects an approved Linear initiative scope to Herdr worktrees and OMO native threads. Linear owns scope and decisions. Local SQLite keeps the approved snapshot, execution authorization, runtime identity and delivery receipts.

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
CLIProxyAPI serving the role models below, plus the proxy access configuration.
This repository doesn't issue or copy provider credentials. Account logins are
managed in CLIProxyAPI.

## Contributing and releases

[CONTRIBUTING.md](CONTRIBUTING.md) covers issues, focused PRs, verification and
review expectations; GitHub supplies bug/feature forms and a PR template.
[Version and release policy](docs/releases.md) defines SemVer, `vVERSION` tags,
source-only releases, upgrades and rollback. [CHANGELOG.md](CHANGELOG.md) holds
release notes. `bun run release:check` validates the package version and notes.
CI runs without provider credentials and includes the required native Herdr
build and an isolated installation smoke test. A maintainer-pushed version tag
runs those checks before publishing a GitHub release. No initial tag has been
published yet; the clone above installs `main`.

## Proxy model extension

`bun run build` produces two separate bundles: `dist/extension/index.js` for
session control and `dist/proxy/index.js` for model connectivity. New OLW role
sessions and the generated shared host profile load both explicitly, so they
don't depend on the user's global extension settings. The proxy extension can
also be used on its own with regular OMO.

```sh
omo -e /absolute/path/to/omo-linear-workflow/dist/proxy/index.js
```

Register the same path in the `extensions` array of OMO's `settings.json` and it
loads from the next start. Don't register the older standalone proxy extension
path alongside it.

Access files are read from the two locations below by default. Replace the
example keys with real values and keep file permissions at `600`. Never put keys
or provider OAuth files in the repository.

`~/.config/cliproxyapi/omo-client.json`:

```json
{"baseUrl":"http://127.0.0.1:8317/v1","apiKey":"CLIENT_KEY"}
```

`~/.config/cliproxyapi/management-access.json`:

```json
{"managementUrl":"https://your-host:8318/management.html","managementKey":"MANAGEMENT_KEY"}
```

The client key is used for model calls. The management key is used to look up
model definitions and aliases. Chat models are registered by merging `/v1/models`
with management metadata, and refreshed at startup, when a new agent runs, and on
`/proxy-refresh`. If some metadata lookups fail, the last successful list is kept.
Individual models with incomplete data are excluded with a warning, and models
dedicated to image or video generation aren't registered. Availability is checked
right before each request, then the call goes out over a real Responses, Messages
or Chat Completions transport.

`providers.cliproxyapi.modelOverrides` in `models.json` still applies to user
settings such as context size. The managed OMO launcher checks the upstream model
chains for categories and agents before start and syncs them to proxy paths. The
explicit per-role model assignments for OLW are kept separately. This feature
doesn't enable other providers or restore direct authentication. A cost of `0`
for a model with no registered price means no information, not free.

### Model registration and disablement policy

Model registration and enablement are managed directly by the user in the
CLIProxyAPI management UI. OAuth models are toggled through **OAuth Model
Disablement**, and OLW only reads that policy. Manual registration, enabling and
disabling take priority over automatic routing recommendations. The current OMO
list restriction has been lifted with `scope all`, and unused models aren't
automatically blocked again at startup. Directly registered OpenAI-compatible
providers such as MiMo aren't subject to the OAuth policy, so their separate
model registration list is preserved. Management files, exceptions and recovery
steps follow the [manual-first model policy](docs/proxy-model-policy.md).

### Automatic upstream routing tracking

Before a regular `omo` or `omon` start and before OLW prepares its shared host,
the installed global OMO's version and the actual policy bundle hash are checked.
When they change, the category and agent model order and thinking levels are
mapped onto the current proxy list. Routing the user changed by hand afterwards
is protected. If a chain can't be mapped or the bundle format is new, the previous
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
three role models. It needs the local access files and doesn't create or change
Herdr workspaces or existing role sessions.

Linear authentication and lookups go through OMO's existing Linear MCP connection. When authentication is needed, the user runs `/mcp auth linear`. Then ask OMO to read `skills/define/SKILL.md` (`olw-define`) and `skills/plan/SKILL.md` (`olw-plan`) to prepare a revision-pinned snapshot. Import doesn't prove remote authentication or the latest revision, so the MCP verification steps in the skills must not be skipped. The local QA fixture `tests/fixtures/scope.json` must always be imported with `--fixture`.

See [`tests/fixtures/scope.json`](tests/fixtures/scope.json) for the snapshot format. A local input check runs like this:

```sh
bun run cli -- scope import --file tests/fixtures/scope.json --fixture --json
```

For `--scope-digest`, use `value.digest` from the import response. It isn't a hash of the file itself. `--designation` is a unique name that distinguishes this run, and `BINDING` is the `binding.id` from each create response (`value.binding.id` with `--json`).

## Commands

```sh
bun run cli -- --root "$PWD" scope import --file approved-scope.json
bun run cli -- --root "$PWD" supervisor create --initiative ID --scope-digest SHA --designation ID --execute
bun run cli -- --root "$PWD" parent create --supervisor BINDING --project ID --repo /abs/repo --base main
bun run cli -- --root "$PWD" child create --parent BINDING --issue ID
bun run cli -- --root "$PWD" send --from BINDING --to BINDING --id MSG --kind instruction --text-file brief.txt
bun run cli -- --root "$PWD" report --from BINDING --id MSG --outcome completed --evidence /abs/path --text-file result.txt
bun run cli -- --root "$PWD" status --initiative ID --json
bun run cli -- --root "$PWD" pause --binding BINDING
bun run cli -- --root "$PWD" resume --binding BINDING
bun run cli -- --root "$PWD" reconcile --initiative ID
bun run cli -- --root "$PWD" close --binding BINDING
```

`--root` is this tool's control root, and `$PWD` in the examples above is this repository. The actual target repository is given separately through `--repo` on `parent create`.

The default Herdr socket comes from the current pane's `HERDR_SOCKET_PATH`. Pass `--herdr-socket /abs/socket` only when selecting a different server. Creating and shutting down isolated QA servers is handled by the QA scripts below. Exit codes: 0 success, 2 invalid scope or input, 3 runtime unavailable, 4 uncertain outcome.

## Roles

| Role | Model / reasoning | Workspace |
| --- | --- | --- |
| Supervisor | `cliproxyapi/gpt-6-astra` / `high` | control root Herdr workspace |
| Parent | `cliproxyapi/claude-opus-5-5` / `xhigh` | project integration branch worktree |
| Child | `cliproxyapi/claude-opus-5-5` / `xhigh` | issue worktree based on the parent branch |

These assignments apply to new bindings. Existing bindings keep the model,
provider and thinking level recorded at their initial session as the verification
baseline, and reconcile doesn't automatically switch running sessions to the new
policy.

## Behavior

Herdr creates the workspace and the parent and child worktrees. The parent branch is `omo/<designation>/projects/<project>-<binding>`, the child branch is `omo/<designation>/issues/<issue>-<binding>`, and the child's base is a verified commit on the parent branch. The new binding suffix lets you replace a role while keeping the earlier working branch.

The controller subscribes to file events first, then launches OMO. When the TUI's `session_start` atomically writes a readiness record under `.omo/state/ready/`, the controller connects to that exact session through the public OMO RPC, sets and verifies the model and reasoning, and then sends the first instruction. It doesn't rely on Herdr's OMO detection or on unsupported session-path reports.

The initial instruction leaves a persistent claim before it's sent. The role stays `initializing` until actual acceptance is confirmed, and becomes `ready` only after that. If the ACK is lost, acceptance is confirmed from the exact user message or delivery receipt already stored. Without evidence, nothing is resent.

Later communication between sessions uses the native `thread_send` with `delivery: auto`. A waiting parent resumes on a child's report. There's no separate agent polling loop and no custom message broker. The same message ID with the same payload returns the stored receipt instead of sending again.

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
bun run qa:linear
```

`qa:events` runs against an isolated Herdr server and a Git fixture. It checks the three roles' actual models, worktree ancestry, focus preservation, automatic resume on report, duplicate prevention, runtime-loss detection and data retention on close, then cleans up its resources. The default Herdr is the managed artifact, and the same manifest, patch and receipt are passed to the QA control root. `qa:linear` wires a local HTTP fixture into the real OMO MCP execution path and confirms that all four skills load. To test compatibility with a different server build, set `QA_HERDR_BINARY=/abs/herdr` explicitly. A passing isolated QA run doesn't by itself prove the TUI behavior of the server currently in use.

## Recovery and shutdown

`status` shows stored state. `reconcile` checks every active role's Herdr resources and actual native identity once. Roles that have disappeared are marked `uncertain` and aren't recreated automatically. A shutdown that was already requested can be continued.

`close` starts from the children. It closes the workspace and the exact native session, then releases ownership, **preserving worktree files, branches and session records**. If another client is attached to the native session or the resource identity has changed, it keeps ownership and returns an error. Detach the observing client and run it again.

If the workspace creation response itself was lost, check Herdr directly. Only after confirming that no workspace was created, release the unconfirmed reservation with `close --binding ID --confirm-absent`. Closed roles aren't reopened. Create a new binding under the same approval instead.

## Limits

One Herdr server and one native OMO host are used. Automatic merge, release and Linear mutation aren't provided. Native acceptance, work completion reports and Linear acceptance are different states. `pause` and `resume` only change whether contact is allowed. They don't recreate sessions. Shutdown or an uncertain work outcome doesn't mean Linear completion.

QA with real Herdr, real models and real reports has passed. Live Linear OAuth and real Linear writes haven't been run. Whether the default Herdr supports OMO detection is separate from this CLI's execution and communication.

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
