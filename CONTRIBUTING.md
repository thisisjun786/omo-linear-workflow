# Contributing to OMO Linear Workflow

OLW is an early-stage, single-owner project distributed as source. Bug reports, small focused fixes and clearly scoped features are welcome.

Read [AGENTS.md](AGENTS.md) before touching orchestration code. It states the contracts the project won't break: one role per binding, Herdr owns workspaces, Linear owns scope, event-driven delivery only, no silent model substitution, and the managed Herdr runtime is never replaced by a PATH binary.

## Language

Write issue and pull request titles and bodies in English, regardless of the language used to request the work. Keep quoted source text, logs, and code unchanged. `README.md` and `README.ko.md` are the one exception: they're kept in sync, and if you can't write Korean, update the English file and say so in the PR so the owner can translate.

## Before you start

Search existing issues and PRs. For a feature or architectural change, open a [proposal](https://github.com/thisisjun786/omo-linear-workflow/issues/new?template=proposal.yml) and agree on scope with the owner before implementation. A blank issue is fine if the form doesn't fit. Small fixes and documentation improvements can go straight to a PR.

Report reproducible problems with the [bug form](https://github.com/thisisjun786/omo-linear-workflow/issues/new?template=bug.yml). For sensitive findings, follow [Security](SECURITY.md).

### Local setup

You need Bun 1.4.0 or newer, pnpm 10.33.3, Node 24.20 and `git` on PATH. The first uncached Herdr build also needs Rust 1.96.1 with `rustfmt` from Rustup and Zig 0.16.0. Later builds reuse the verified artifact.

```sh
git clone https://github.com/thisisjun786/omo-linear-workflow.git ~/code/omo-linear-workflow
cd ~/code/omo-linear-workflow
git checkout dev
pnpm install --frozen-lockfile
bun run build
bun run cli -- doctor --json
```

The README covers the installer (`bun run install:local`), proxy access files and the operator commands. The installer doesn't install OS dependencies, edit your shell profile or touch accounts; set those up yourself. Nothing in this repository issues or copies provider credentials, and none should ever be committed.

## Make a change

1. Create a focused branch from the latest `dev`. Use your fork if you don't have write access. `main` is the released source; never branch from it or target it.
2. Keep the change small enough to review as one unit. A fix and an unrelated refactor belong in separate PRs. Coordinate edits that overlap someone else's work.
3. Every behavioral change starts with a failing test, then the smallest change that makes it pass. Tests cover machine behavior: parsed fields, exit codes, stored records, emitted events. Don't pin prose, prompt wording or README text with a test.
4. Check the result and record what you ran. For code, run what CI runs (below) and, for runtime-facing changes, the isolated QA scripts that cover the affected path. For documentation, read the rendered content, check links, and run `git diff --check`; also `git diff --cached --check` for staged changes.
5. Open a PR targeting `dev` with an English Conventional Commit title, explaining the problem, the change, and the verification. Link an existing issue when relevant; a separate issue just for the PR isn't needed.
6. Address review feedback. The owner merges under the [PR policy](docs/policy/pull-requests.md), always with a merge commit.

Rules that CI and review hold you to:

- Strict TypeScript on Bun. No `any`, no non-null assertions, no ignored errors.
- Zod at input boundaries. `bun:sqlite` for anything transactional.
- No sleeps or timing-based waits in tests. Subscribe to the event or state change first, trigger the action, then await it with a bounded timeout.
- Don't restart running Herdr servers or OMO sessions from build or test code.
- Preserve the user's model choices. Enable/disable decisions made in opencodex are authoritative; OLW only reads the catalog it publishes to OMO.
- Never modify real Linear objects during QA. Use `--fixture` and the owned fixtures under `tests/fixtures/`.
- No credentials, SQLite files, `.omo/state/`, `.omo/herdr/` artifacts or other runtime output in commits. `.gitignore` covers the usual paths; check `git status` before you push anyway.

What CI runs, in the same order:

```sh
bun run release:check
bun run typecheck
bun run lint
bun test
bun run build
```

`bun run build` includes the managed Herdr build on first run. The isolated QA scripts (`bun run qa:events`, `qa:linear`, `qa:proxy`, `qa:routing`) cover runtime-facing changes. For child execution changes, also run `bun run qa:child-workflow happy` and `bun run qa:child-workflow failed-node`; these use real models, native DAG events and isolated role fixtures with cleanup. `qa:events` needs Herdr plus real model access; `qa:proxy` and `qa:routing` need proxy access files; `qa:linear` uses a local MCP fixture and no live Linear account. CI has no live provider credentials, so its automatic checks must not depend on them. See the [CI policy](docs/policy/ci.md).

If a change is user-facing, add a line under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md). Use the Keep a Changelog groups (Added, Changed, Fixed, Removed) and write the entry for an operator, not for yourself.

## Project policies

- [Issues](docs/policy/issues.md): reports, proposals, and questions.
- [Pull requests](docs/policy/pull-requests.md): scope, review, merge commits, and branch rules.
- [CI](docs/policy/ci.md): what the workflow runs and what a green result means.
- [Releases](docs/policy/releases.md): versioning, cutting a release, install, upgrade and rollback.
- [Security](SECURITY.md): reporting sensitive findings privately.
