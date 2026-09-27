# OMO Linear Workflow (OLW)

English | [한국어](README.ko.md)

OLW is a Bun CLI that turns approved Linear scope into working sessions: a manager you talk to, one parent per project, and one child per issue, each in its own Herdr workspace running OMO. Linear owns scope and decisions. Local SQLite keeps the approved snapshot, execution authorization, runtime identity and delivery receipts.

## How it flows

```
you
 |  questions go up, answers come back down
 v
manager session ............ OLW host, your default OMO model
 |
 v
project parent ............. one owned clone per project
 |
 +-- issue child (direct / research) ... one worktree per issue
 |
 +-- issue child (planned)
       plan stage -> execute stage ..... same worktree, two tabs
```

A child asks its parent, the parent asks the manager, and only the manager asks you. Without a manager, questions land in your inbox (`questions`, `answer --as-user`). A child delivers a PR into the parent's integration branch, or a report or document when the issue asks for one.

## Requirements

- Linux x64
- Bun >= 1.4.0, Node.js >= 24.20.0, pnpm 10.33.3, Git
- opencodex with its OMO integration enabled: `ocx integration client enable --client omo`
- Herdr is not a separate install. The build downloads the official Herdr 0.9.1 release and verifies its pinned SHA-256; no Rust or Zig needed.

## Install

```sh
git clone https://github.com/thisisjun786/omo-linear-workflow.git ~/code/omo-linear-workflow
cd ~/code/omo-linear-workflow
bun run install:local
olw doctor --json
```

The installer builds everything, including Herdr, and creates `~/.local/bin/olw`. Keep the checkout where you installed it. Options, uninstall and what the installer never touches are in [install details](docs/operations.md#install-details).

`olw doctor` checks the local runtime and blocks the switch to official Herdr while legacy linked-worktree parents remain; see the [switch gate](docs/operations.md#official-herdr-runtime-and-switch-gate).

## Quick start

Type `olw` in any Herdr pane. It opens the manager here, or focuses its existing live pane. After exiting the TUI, type `olw` again to reattach the same durable conversation here. The session remains a normal assistant for ordinary work; OLW guidance applies when handling OLW messages.

```sh
olw
# In another pane, approve and launch project work:
olw scope import --file approved-scope.json --json
olw parent create --scope-digest DIGEST --designation ID --execute --project ID --json
olw child create --parent BINDING --issue ID --mode planned --json
olw status --project ID --json
```

`DIGEST` is `value.digest` from the import response. `BINDING` is `value.binding.id` from a create response. The project's target repository comes from the approved [scope repository mapping](docs/repositories.md); `--repo` is rejected. Add `--fixture` when importing the local fixture `tests/fixtures/scope.json`.

## Commands

| Command | What it does |
| --- | --- |
| `doctor` | Check the local runtime, repository mirrors and legacy parents |
| `olw` / `manage --here` | Open or reattach the manager in this Herdr pane; focus it if already live |
| `manage` | Open the manager in its own workspace, or focus/reattach the existing manager |
| `update check` | Compare pinned OMO and Senpi versions with npm; never installs |
| `update prepare` | Verify a pin update in a separate worktree and open a PR to `dev` |
| `scope import` | Import an approved Linear snapshot and return its digest |
| `repo list` / `repo fetch` | List or update bare fetch-only mirrors of target repositories |
| `supervisor create` | Create an optional initiative supervisor session |
| `parent create` | Create a project parent in its own owned clone |
| `parent link` / `parent unlink` | Link a parent to a supervisor or the manager, or remove that link |
| `child create` | Create an issue child (`--mode direct`, `planned` or `research`; `--deliverable pr`, `report` or `document`) |
| `pr open` / `pr merge` | Open a child or project PR; merge a child PR into the integration branch |
| `stage complete` | Record a finished plan stage with its plan file and head commit |
| `stage start` | Open the execute stage in the same worktree |
| `send` | Send an `instruction` or `coordination` message between roles |
| `report` | Report `completed`, `blocked` or `failed` to the parent, manager or your inbox (`--to-user`) |
| `reports` | Read posted user-inbox records; `--all` also includes manager-addressed reports (read-only) |
| `ask` | Ask a blocking question upward (parent only; children use the `olw_ask` tool) |
| `answer` | Answer one question by ID, as a role (`--from`) or as the user (`--as-user`) |
| `questions` / `notices` | List open questions or operational notices (read-only) |
| `status` | Show stored state for a project or initiative |
| `pause` / `resume` | Block or allow new contact to a role |
| `close` | Close a role, keeping its clone, worktree, branches and session records |
| `reconcile` | Check every active role against Herdr and the native host once |

Every command takes `--root PATH`, `--herdr-socket PATH` and `--json`. Run `olw --help --json` for the exact flags. Exit codes: 0 success, 2 invalid input, 3 runtime unavailable, 4 uncertain outcome.

## Roles and models

| Role | Model / reasoning |
| --- | --- |
| Manager | your OMO default from `~/.omo/agent/settings.json` (fallback `anthropic/claude-opus-5-5` / medium) |
| Parent | `anthropic/claude-opus-5-5` / xhigh |
| Child, `direct` or `research` | `anthropic/claude-opus-5-5` / xhigh |
| Child, `planned` plan stage | `anthropic/claude-fable-5-1` / xhigh |
| Child, `planned` execute stage | `anthropic/claude-opus-5-5` / medium |
| Supervisor (optional) | `gpt-6-astra` / high |

All models are served through opencodex. Existing bindings keep the model they started with; only the manager can change models freely. Upstream routing is pinned by default and reviewed, never applied silently; see [pinned routing](docs/proxy-routing.md).

## Documentation

- [Operations](docs/operations.md): install details, opencodex, scope import, roles, behavior, official Herdr and rollback, verification, recovery, limits
- [Repository mirrors, owned clones and PR integration](docs/repositories.md)
- [Two-stage children and question escalation](docs/two-stage-children.md)
- [Pinned routing through opencodex](docs/proxy-routing.md)
- [Maintained runtime repairs](docs/runtime-patches.md)
- Policies: [issues](docs/policy/issues.md), [pull requests](docs/policy/pull-requests.md), [CI](docs/policy/ci.md), [releases](docs/policy/releases.md)
- [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), [CHANGELOG.md](CHANGELOG.md), [GitHub Releases](https://github.com/thisisjun786/omo-linear-workflow/releases)

## Contributing

Start with [CONTRIBUTING.md](CONTRIBUTING.md). PRs target `dev`; `main` is the released source. Report sensitive issues as described in [SECURITY.md](SECURITY.md).
