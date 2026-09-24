# Changelog

All notable changes to OMO Linear Workflow (OLW) are recorded here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions
follow the rules in [docs/releases.md](docs/releases.md). `package.json`
`version` is the canonical version; the matching `## [VERSION]` section below is
what `bun run release:check` reads when a release is prepared.

Section headings are exactly `## [VERSION]`; the check rejects anything else.
The tag date goes on the first line of the section body (`Released: YYYY-MM-DD`)
when the version is actually tagged. A section without that line hasn't been
published.

## [Unreleased]

### Added

- Issue children start in packet-bound mass-ulw mode, using native phase workflows
  and independent artifact verification before reporting to the existing parent.
- Real child workflow QA for successful execution and recovery of invalid work
  without repeating successful nodes: `qa:child-workflow happy|failed-node`.

### Changed

- Models route through opencodex. The routing synchronizer reads the
  opencodex-owned catalog in `models.json`, and OLW role pins use `opencodex`.
- Child fixture standby permits internal workers only after explicit instruction;
  creating additional OLW roles and accessing live Linear remain forbidden.
- Only children may hold an issue-packet goal. Supervisor/parent waiting and model
  assignments remain unchanged; existing bindings are not reinitialized.

### Removed

- The CLIProxyAPI model extension (`dist/proxy/index.js`), its `/proxy-refresh`
  command, access files and manual-first CLIProxyAPI policy document. Role
  launches and the shared host profile no longer load it. Remove that path from
  OMO's `settings.json` `extensions`. A routing receipt without a provider is
  still re-planned at the next start.

## [0.1.0]

Released: 2026-09-23

Initial source release of OMO Linear Workflow (OLW).

### Added

- A non-overwriting Linux x64 installer for a source checkout and its `olw` launcher.
- CI for metadata, type checking, lint, tests, the managed Herdr build and installation smoke tests.
- Version/tag validation and source-only GitHub releases triggered by maintainer tags.
- Version, upgrade, rollback and contribution policies, issue forms and a PR template.

- Bun CLI (`bun run cli`) that imports a revision-pinned Linear initiative scope
  snapshot into local SQLite and creates supervisor, parent and child role
  bindings on top of it.
- Herdr-backed role workspaces: one supervisor per initiative, one parent
  worktree per project on an integration branch, one child worktree per issue
  based on its parent's branch.
- Event-driven delivery between roles through OMO native threads with
  persistent claims, idempotent message IDs and stored receipts. No polling
  loops.
- `status`, `pause`, `resume`, `reconcile` and `close` commands that inspect
  and release runtime resources while preserving worktrees, branches and
  session records.
- Managed Herdr runtime pinned by `vendor/herdr/manifest.json` and
  `patches/herdr-0.9.1-omo.patch`, built by `bun run build` with digest-verified
  artifacts and receipts. No fallback to a global PATH binary.
- Proxy model extension (`dist/proxy/index.js`) that registers CLIProxyAPI
  models in OMO, honours the manual-first model policy, and refreshes the
  catalog at startup, on new agents and on `/proxy-refresh`.
- Automatic upstream routing tracking (`bun run proxy:routing`) that maps the
  installed global OMO's category and agent chains onto proxy models while
  protecting manual overrides.
- Ollama Cloud DeepSeek routing through the proxy extension.
- OMO skills `olw-define`, `olw-plan`, `olw-run` and `olw-check` for defining,
  planning, executing and checking approved scope through the native runtime.
- Isolated QA scripts (`qa:events`, `qa:linear`, `qa:proxy`, `qa:routing`,
  `qa:herdr`) that run against owned fixtures and clean up after themselves.
- English and Korean READMEs, plus operator guides for the proxy model policy
  and automatic routing.

### Known limits

- Linux x64 is the only supported installer target.
- Live Linear OAuth and real Linear writes have not been exercised.
- The OLW orchestration runtime does not automatically merge work or mutate Linear.
  GitHub source releases require a maintainer to push a version tag.
