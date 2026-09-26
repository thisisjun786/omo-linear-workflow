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

- User-managed opencodex model metadata catalog (`MODEL_CATALOG` in
  `src/proxy/model-catalog.ts`). It overrides the context window, output limit,
  input modalities and reasoning flag that ocx exports late or wrong, for example
  the 32000 output stand-in on every model (lidge-jun/opencodex#5828). The
  managed `omo` launcher and role panes load `dist/extension/model-catalog.js`,
  which re-registers corrected models at session start.
  `bun run proxy:routing catalog` lists the active changes and any redundant or
  stale entries.
- Issue children start in packet-bound mass-ulw mode, using native phase workflows
  and independent artifact verification before reporting to the existing parent.
- Real child workflow QA for successful execution and recovery of invalid work
  without repeating successful nodes: `qa:child-workflow happy|failed-node`.
- Model chain warnings on every managed `omo` start, in `olw doctor` (under
  `chains`, still `ok`) and via `bun run proxy:routing chains`: a category or
  agent with no working model or a single remaining model, and OLW role models
  missing from the opencodex catalog. Warnings never block a start and print once
  per change.

### Changed

- Models route through opencodex. The routing synchronizer reads the
  opencodex-owned catalog in `models.json`, and OLW role pins use `opencodex`.
- Child fixture standby permits internal workers only after explicit instruction;
  creating additional OLW roles and accessing live Linear remain forbidden.
- Only children may hold an issue-packet goal. Supervisor/parent waiting and model
  assignments remain unchanged; existing bindings are not reinitialized.
- An upstream xAI route is followed by the same model on Cursor when opencodex
  publishes it (`xai/grok-4.7`, then `cursor/grok-4.7`). No other same-model host
  becomes a second lane.
- A managed category or agent route whose upstream choices opencodex no longer
  publishes is written without models and listed as `unroutable`, instead of
  rejecting the whole routing update.

### Removed

- The CLIProxyAPI model extension (`dist/proxy/index.js`), its `/proxy-refresh`
  command, access files and manual-first CLIProxyAPI policy document. Role
  launches and the shared host profile no longer load it. Remove that path from
  OMO's `settings.json` `extensions`. A routing receipt without a provider is
  still re-planned at the next start.

### Fixed

- The managed `omo` launcher works with omo-ai installed through bun (5.0.0 and
  later). It finds the omo-ai package from its manifest instead of assuming a
  symlinked bin, so the generated bun launcher script no longer fails the routing
  preflight with `ENOENT ... ~/.bun/package.json`.
- Once routing has been adopted, a failed routing preflight no longer blocks the
  interactive `omo` launcher: it prints the error and starts OMO with the retained
  routing. Before adoption, and for OLW role launches, a failed preflight still
  stops the launch.

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
