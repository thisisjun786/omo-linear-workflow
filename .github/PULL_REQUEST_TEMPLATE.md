<!-- Title must be a Conventional Commit line (feat:, fix:, docs:, ...). PRs are squash-merged and the title becomes the commit. -->

## What

<!-- One focused change. What does this PR do? Link the issue if there is one. -->

## Why

<!-- The problem or contract this addresses. -->

## How it was verified

<!-- Commands you ran and what they showed. CI runs bun test, typecheck, lint, the native Herdr build on Linux and the installer smoke; anything beyond that (qa:events, qa:proxy, a real-surface check) goes here. -->

## Compatibility

<!-- Does this change a documented contract, stored state, the SQLite schema, CLI flags or exit codes? If so, describe the migration and note it in the changelog. Write "none" if not. -->

## Checklist

- [ ] Focused on one change; unrelated refactors left out
- [ ] Behavioral changes have a test that fails without the fix (machine behavior, not prose)
- [ ] No sleeps or timing-based waits in tests
- [ ] The user's opencodex model enable/disable choices are preserved
- [ ] `CHANGELOG.md` `## [Unreleased]` updated if user-facing
- [ ] `README.md` and `README.ko.md` both updated if the README is affected
- [ ] No credentials, SQLite files or `.omo/` runtime artifacts included
