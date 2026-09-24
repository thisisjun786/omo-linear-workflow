# Contributing to OMO Linear Workflow

OLW is an early-stage, single-maintainer project distributed as source. Bug
reports, small focused fixes and clearly scoped features are welcome. Large
changes are easier to land if you open an issue first so the shape is agreed
before the code exists.

Read [AGENTS.md](AGENTS.md) before touching orchestration code. It states the
contracts the project won't break: one role per binding, Herdr owns workspaces,
Linear owns scope, event-driven delivery only, no silent model substitution, and
the managed Herdr runtime is never replaced by a PATH binary.

## Local setup

You need Bun 1.4.0 or newer, pnpm 10.33.3, Node 24.20 and `git` on PATH. The
first uncached Herdr build also needs Rust 1.96.1 with `rustfmt` from Rustup and
Zig 0.16.0. Later builds reuse the verified artifact.

```sh
git clone https://github.com/thisisjun786/omo-linear-workflow.git ~/code/omo-linear-workflow
cd ~/code/omo-linear-workflow
pnpm install --frozen-lockfile
bun run build
bun run cli -- doctor --json
```

The README covers the installer (`bun run install:local`), proxy access files
and the operator commands. The installer doesn't install OS dependencies, edit
your shell profile or touch accounts; set those up yourself. Nothing in this
repository issues or copies provider credentials, and none should ever be
committed.

## Making a change

Keep each pull request focused on one thing. A fix and an unrelated refactor
belong in separate PRs.

Every behavioral change starts with a failing test, then the smallest change
that makes it pass. Tests cover machine behavior: parsed fields, exit codes,
stored records, emitted events. Don't pin prose, prompt wording or README text
with a test.

Project rules that CI and review will hold you to:

- Strict TypeScript on Bun. No `any`, no non-null assertions, no ignored errors.
- Zod at input boundaries. `bun:sqlite` for anything transactional.
- No sleeps or timing-based waits in tests. Subscribe to the event or state
  change first, trigger the action, then await it with a bounded timeout.
- Don't restart running Herdr servers or OMO sessions from build or test code.
- Preserve the user's model choices. Enable/disable decisions made in opencodex
  are authoritative; OLW only reads the catalog it publishes to OMO.
- Never modify real Linear objects during QA. Use `--fixture` and the owned
  fixtures under `tests/fixtures/`.
- No credentials, SQLite files, `.omo/state/`, `.omo/herdr/` artifacts or other
  runtime output in commits. `.gitignore` already covers the usual paths; check
  `git status` before you push anyway.

Before opening a PR, run what CI runs:

```sh
bun test
bun run typecheck
bun run lint
bun run release:check
bun run build
```

`bun run build` includes the managed Herdr build on first run. The isolated QA
scripts (`bun run qa:events`, `qa:linear`, `qa:proxy`, `qa:routing`) are useful
for runtime-facing changes. For child execution changes, also run
`bun run qa:child-workflow happy` and `bun run qa:child-workflow failed-node`;
these use real models, native DAG events and isolated role fixtures with cleanup.
`qa:events` needs Herdr plus real model access;
`qa:proxy` and `qa:routing` need proxy access files. `qa:linear` uses a local MCP
fixture and no live Linear account. CI has no live provider credentials, so
its automatic checks must not depend on them.

## Documentation

If a change is user-facing, add a line under `## [Unreleased]` in
[CHANGELOG.md](CHANGELOG.md). Use the Keep a Changelog groups (Added, Changed,
Fixed, Removed) and write the entry for an operator, not for yourself.

`README.md` and `README.ko.md` are kept in sync. If you change something the
README describes, update both. If you can't write Korean, update the English
file and say so in the PR; the maintainer will translate.

New public docs are written in English.

## Commits and pull requests

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/):
`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, `build:`. PRs are
squash-merged, so the PR title is what ends up in history. Make it a valid
Conventional Commit line on its own.

Fill in the PR template. State what changed, why, how you verified it, and any
migration or compatibility note. Link the issue if there is one.

The maintainer reviews every PR. Merging waits for green CI (test, typecheck,
lint, native Herdr build on Linux and the installer smoke run) and an approving
review. These are the repository's contribution rules; they do not assert that
GitHub branch protection or required-review settings have been enabled.
Expect questions rather than silent edits; if a change needs a different
approach the reviewer will say so once and explain why.

## Reporting problems

Use the issue forms under `.github/ISSUE_TEMPLATE/`. A useful bug report has the
OLW version (`package.json` or the commit SHA), OS and tool versions, exact
commands, expected and actual results, and redacted logs. Strip API keys,
OAuth tokens and anything from `~/.opencodex/` before pasting.

Feature requests should describe the problem and the outcome you want. A
proposed design is welcome but optional.
