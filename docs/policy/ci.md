# Continuous Integration

The [CI workflow](../../.github/workflows/ci.yml) runs one job, `validate`, on Linux x64. It runs the same commands a contributor runs locally, plus the native Herdr build and an installer smoke test.

## When it runs

| Event | Coverage |
| --- | --- |
| Pull request | Every PR, regardless of changed paths. The required result for merging into `dev`. |
| Push to `main` | The released source after a release advances `main`. |
| Manual dispatch | The same checks on any branch. |
| Release | The [release workflow](releases.md) calls this workflow before publishing. |

Every PR runs the full job. There's no path-based selection: a documentation-only PR still installs dependencies and builds Herdr. New runs cancel obsolete runs for the same PR or branch, except when called from the release workflow. The job has a 60 minute timeout.

Today the workflow's push trigger lists `main` but not `dev`, so a merge into `dev` doesn't rerun CI on the merge commit. The PR run against GitHub's merge candidate is the evidence for that change. See the release policy for what a release verifies.

## What runs

In order, after installing the pinned toolchain (Node 24.20.0, pnpm 10.33.3, Bun 1.4.0, Rust 1.96.1 with `rustfmt`, Zig 0.16.0) and `pnpm install --frozen-lockfile`:

1. `bun run release:check`: `package.json` `version` matches a well-formed `## [VERSION]` changelog section.
2. `bun run typecheck`: strict TypeScript with `tsc --noEmit`.
3. `bun run lint`: Biome over `src`, `tests` and `scripts`.
4. `bun test`: the Bun test suite. Tests use fixtures and never touch a real Linear workspace or a live provider.
5. `bun run build`: builds the CLI and the managed Herdr pinned by `vendor/herdr/manifest.json`, including Herdr's source preparation, Rust fmt and tests, and the Zig release build. Cargo downloads are cached by the manifest hash; the pnpm store is cached by the lockfile and patch hash.
6. Installer smoke: `bun run install:local -- --bin-dir "$RUNNER_TEMP/olw-bin"` followed by `olw --help` from that directory.

CI has no provider credentials, no proxy access files and no Linear account. Nothing it runs may depend on them. The runtime-facing QA scripts (`bun run qa:events`, `qa:proxy`, `qa:routing`, `qa:child-workflow`) run only on a contributor's or the owner's machine and are reported in the PR as manual verification.

## Passing and failing

The job passes when every step exits 0. A green `validate` means the tests, type check, lint, build and installer smoke passed for that commit. It doesn't establish real-surface behavior against Herdr servers, Linear or models; that evidence comes from the QA scripts named in the PR.

Don't add workflow-level path filters. A PR that skips the job can't produce the required result.

## Local verification

```sh
bun test
bun run typecheck
bun run lint
bun run release:check
bun run build
git diff --check
```

During iteration, run the affected test file (`bun test tests/skills.test.ts`) rather than the whole suite each time; run the whole suite before opening the PR. Pure prose needs reading and link/format checks, not tests pinning its wording.

## Extending CI

Add a new check together with the code it verifies and the local command that runs it. Share commands between local and CI execution through `package.json` scripts. Bug fixes need a regression test that fails without the fix. Build and install checks use the produced artifact, as the installer smoke does. Cache downloads and reproducible build inputs, never previous pass/fail results. Add platforms only for an actual support commitment; Linux x64 is the only supported target today.

## Boundaries

The workflow runs with `contents: read` and `persist-credentials: false`. It never publishes anything. Don't expose account secrets, personal data or running services to PR code. The [PR policy](pull-requests.md) governs integration; CI success doesn't authorize merging or a release.
