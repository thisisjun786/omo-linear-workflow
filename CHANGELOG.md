# Changelog

All notable changes to OMO Linear Workflow (OLW) are recorded here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions
follow the rules in [docs/policy/releases.md](docs/policy/releases.md). `package.json`
`version` is the canonical version; the matching `## [VERSION]` section below is
what `bun run release:check` reads when a release is prepared.

Section headings are exactly `## [VERSION]`; the check rejects anything else.
The tag date goes on the first line of the section body (`Released: YYYY-MM-DD`)
when the version is actually tagged. A section without that line hasn't been
published.

## [Unreleased]

### Fixed

- Detect crash-restarted shared hosts that lost OLW's launch profile, preserve the existing idle-host handoff on the next OLW entry, and make `olw doctor` report endpoint generation, profile match, RSS threshold warnings, seven-day daemon crash history, and the exact scoped recovery environment and command without invoking session APIs that reconcile daemon state.
- Retry report and question deliveries under the same logical ID after a tool-call guard proves native execution never started, while preserving attempt history and keeping accepted or uncertain outcomes non-retryable.
- Report bound manager, supervisor, parent, and child state from the shared RPC host to each role's current Herdr pane, with one reporter owner across reattachment, event-driven turn/question/background states, closed-binding exclusion, and non-blocking transport.
- Make bare `olw` and `olw manage` automatically hand off a mismatched shared OMO host only when every session counter is zero and a separate validated native session-list read proves it empty, with cross-process serialization, bounded native commands, post-handoff reachability/profile verification, and phase-accurate TTY failures. Hosts with attached sessions or unreadable status remain untouched and report the exact manual command. The occupied-host JSON response intentionally changes its `message` and expands `details.sessions` to all six counters; recovery failures add a machine-readable `recoveryPhase` and error field.
- Carry authorized sender data with manager notice claims so a failed secondary lookup cannot strand reports or questions in `sending`; same-ID replay keeps the original delivery attempt.
- Exit promptly on interruption during abandoned manager startup recovery, releasing the recovery claim without closing the binding or starting another manager.
- Reject here-mode entry on a different server from the saved manager without changing its binding; report both sockets and the original-server/close recovery options.
- Honor interruption during existing-manager host, snapshot and verification checks instead of focusing afterward and reporting success.
- Keep manager live ownership beyond lease expiry for both bare entry and plain `manage`, fence termination, and handle interruption from before reservation, including rejected pre-launch operations; safely recover abandoned unstarted claims.
- Retain the manager's original OLW-owned workspace across moves to user panes and back, and remove that owned workspace exactly once at close.
- Restore `reports` to posted user-inbox records by default; use `reports --all` for manager-addressed records, including pending or failed delivery states.
- Reject here-mode socket or foreground-process mismatches rather than binding to a same-named pane on another server.
- Identify manager reattachment owners by PID and process start time, so recycled PIDs do not block recovery. Legacy claims with unknown start time keep PID-only liveness.
- Preserve foreground manager exit codes before readiness and release failed startup reservations immediately.
- Forward foreground entry signals and recover dead-owner reattachment claims without a lease wait; live owners return `manager_busy` instead of an empty-pane success.
- Recheck manager idle state at native send admission without the native follow-up polling queue.

### Changed

- Issue children in `direct` mode (the default) run Opus 5.5 at `medium` thinking instead of `xhigh`. Parents stay `xhigh`; `planned` keeps Fable 5.1 `xhigh` then Opus 5.5 `medium`; `research` stays Opus 5.5 `xhigh`. Existing bindings keep the model they were launched with.
- Type `olw` in Herdr to open or reattach the single durable manager in the current pane, or focus its live pane. `manage --here` shares this entry; plain `manage` retains separate-workspace behavior.
- Parent reports and questions wait for manager idle admission and arrive as compact notices with retrievable full payloads and unchanged delivery receipts. Accepted limitation: a turn starting between the idle check and native acceptance may receive the notice mid-turn; delivery remains exactly once.
- Manager guidance applies only when handling OLW messages, leaving ordinary assistant work unrestricted.
- Pinned `omo-ai` 5.0.1 and its exact `@code-yeongyu/senpi` 2026.9.27 dependency, porting the maintained runtime repairs to the new executable bundles.

## [0.2.0]

Released: 2026-09-27

### Added

- Official checksum-pinned Herdr 0.9.1 releases replace the vendored patch and Rust/Zig
  build. Senpi's built-in integration owns reports; OLW recognizes `pi` and `omo` without
  duplicate session reports. Owned clones use upstream groups and `worktree.create`.
  `olw doctor` blocks the operational switch and lists remaining legacy parents. Existing
  servers, installed binaries and caches are untouched; one-release rollback is documented.
  New linked parents (`--repo`), children and successors of legacy parents are rejected with
  `legacy_parent_unsupported` before external side effects; close/migrate with approval or
  continue those parents with the retained pre-switch OLW and patched Herdr together.
- Pinned-by-default OMO model routing with accepted baselines, route-level upstream advice,
  selective `apply`/`dismiss`, optional `follow` mode, launcher and manager notices, and catalog
  health review for removed or degraded models. Advice is read-only until explicit acceptance.
- Issue deliverables (`pr`, `report`, `document`) on bindings, briefs, packets and status. Owned-clone
  children publish one PR into their parent's integration branch; `pr open` reuses open PRs and
  `pr merge` checks the reported head and merges with a merge commit. PR-less results require a
  deliverable path. Project PRs stop for user review; legacy local merges remain deprecated but unchanged.
- Fetch-before-close publication guards for owned parents and their PR children, with explicit
  `--discard`, and isolated bare-remote/gh-shim PR lifecycle QA.
- New mapped parents run in OLW-owned, hardlinked clones of repository mirrors, with readable
  per-project Herdr groups and child worktrees owned by the parent clone. Explicit private local-file
  copies, setup deadlines/logs/receipts, and close-time unpushed-commit reports are supported.
  Legacy checkouts remain unchanged; `parent create --repo` conflicts with a mapping (later rejected; see the official Herdr entry).
- Scope projects can declare a target Git remote and default branch. OLW maintains one locked,
  fetch-only mirror per remote and exposes mirror status and explicit fetching through `olw doctor`
  and `olw repo list|fetch`.
- Child modes: `child create --mode direct|planned|research`. A `planned` child runs
  a plan stage (`opencodex/anthropic/claude-fable-5-1` xhigh, ulw-plan) and then an
  execute stage (`opencodex/anthropic/claude-opus-5-5` medium, ulw-execute driving
  mass-ulw) in the same worktree, each in its own Herdr tab and binding. `stage
  complete` records the plan hand-off (path, sha256, head) and `stage start
  --stage execute` stops the plan session and opens the execute stage. `status`
  shows `mode`, `stage`, `stageBindings` and `openQuestions` per lineage generation;
  `close` on any stage closes that generation and its workspace once. The parent
  sends the issue packet to the execute binding; nothing transfers automatically.
- Questions and answers: `question` and `answer` message kinds, the `olw_ask` tool
  in bound child and parent sessions (native `ask_user_question` is blocked there),
  and the `ask`, `answer` and read-only `questions` commands. A parent's question
  goes to its ready manager or, without one or with `--to-user`, to the user inbox;
  `answer --as-user` answers an inbox question.
- The manager: `olw manage` opens or reattaches the scope-free management session
  inside the OLW host with the user's default model (fallback Opus 5.5 medium).
  Parents created while it's ready link to it automatically; `parent create
  --no-manager` opts out. `manage` runs an update check at start and puts the
  result in the manager brief.
- Update automation: `olw update check` reports the pinned OMO and Senpi versions
  against the npm dist-tags (`omo-ai` `beta`, `@code-yeongyu/senpi` `latest`) and
  never installs; `olw update prepare` builds an `olw/update-omo-<v>-senpi-<v>`
  branch from the selected remote's `dev` (default `origin`) in a separate worktree, runs install, typecheck, test and
  build there and opens a PR to `dev` (draft if anything failed). Neither touches
  the live host.
- `medium` is an accepted thinking level for role models.
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
- Durable execute-stage launch intent: concurrent recovery of an execute stage is fenced to
  one launch, and `reconcile` settles a recovery whose outcome is uncertain.

### Changed

- CI now records exact-commit results for every `dev` merge and rejects pull requests into
  `main`. Owner-authorized releases validate that evidence, publish an immutable source tag and
  GitHub release, then fast-forward `main` with dedicated release credentials. The first release
  after adopting the workflow is bootstrapped by an owner-pushed tag; later releases use dispatch.
- Repository policies follow `docs/policy/`: PRs target `dev` and merge with a merge
  commit, `main` only advances to released commits, and issue and PR text is in
  English. Issue forms are now `bug` and `proposal`.
- Pinned the official `omo-ai` 5.0.0 and `@code-yeongyu/senpi` 2026.9.26 releases, retaining only runtime-repair hunks that remain necessary.
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
- `stage start --stage execute` requires an accepted plan report and an unchanged plan file;
  legacy hand-offs without one fail closed. Repeating an identical `stage complete` attaches
  the accepted report id to the hand-off. Reported plan paths are resolved.
- The manager session keeps the user's native model and thinking level instead of
  pinning them.
- A report addressed to a paused manager goes to the user inbox.
- The child CLI `ask` command is rejected; children use the `olw_ask` tool. `ask` stays
  available to parents.
- `update prepare` rejects a stale check or one that isn't an upgrade, targets the selected
  GitHub remote with `gh -R`, reuses an existing remote pull request, and skips typecheck,
  test and build after the install step fails. `--remote` accepts GitHub remotes only.
- Repository mirror locks use a kernel `flock` that the spawned `git` inherits.

### Removed

- The CLIProxyAPI model extension (`dist/proxy/index.js`), its `/proxy-refresh`
  command, access files and manual-first CLIProxyAPI policy document. Role
  launches and the shared host profile no longer load it. Remove that path from
  OMO's `settings.json` `extensions`. A routing receipt without a provider is
  still re-planned at the next start.

### Fixed

- Upstream Sol Fast selectors are routed to standard-tier Sol through opencodex;
  Luna keeps its Fast row. Sol's priority tier cost too much for its speed gain.
- The managed `omo` launcher works with omo-ai installed through bun (5.0.0 and
  later). It finds the omo-ai package from its manifest instead of assuming a
  symlinked bin, so the generated bun launcher script no longer fails the routing
  preflight with `ENOENT ... ~/.bun/package.json`.
- Once routing has been adopted, a failed routing preflight no longer blocks the
  interactive `omo` launcher: it prints the error and starts OMO with the retained
  routing. Before adoption, and for OLW role launches, a failed preflight still
  stops the launch.
- `pr merge` matches the child's report to the requested PR instead of the latest
  report from that binding.

### Security

- Explicit local-file copies are anchored to directory handles inside the owned checkout,
  reject C0 and C1 control characters at both path boundaries, and surface cleanup failures.
  Receipts store only a source label, never the source path.
- Git remote arguments get explicit option boundaries (`--`), so a remote name or URL can't
  be read as a flag.

### Migration

Do these steps in order after pulling `v0.2.0`.

1. Rebuild the control root. Run `bun run install:local` from the checkout, or follow the
   upgrade steps in [docs/policy/releases.md](docs/policy/releases.md#upgrading). Running
   Herdr servers and OMO sessions keep the old code until you close and recreate them.
2. Switch to official Herdr. Run `olw doctor`; `legacy_parents_remaining` lists every
   linked-worktree parent from 0.1.0. Close or migrate those parents first, with approval,
   or keep them on the pre-switch stack. Then remove
   `~/.omo/agent/extensions/herdr-senpi-agent-state.ts` and restart the Herdr server.
   Rollback for one release is to keep the pre-switch checkout and its patched Herdr
   artifact directory; see [docs/operations.md](docs/operations.md#one-release-rollback).
3. Stop using `parent create --repo`. It's rejected with `legacy_parent_unsupported`. Map
   each project to a repository in the scope snapshot instead; the format is in
   [docs/repositories.md](docs/repositories.md).
4. Routing is pinned by default. Existing installs migrate without rewriting `omo.jsonc`.
   Run `bun run proxy:routing baseline save` once so the baseline gets a catalog snapshot;
   until then, `proxy:routing status` reports that the save is needed.
5. Remove the CLIProxyAPI extension path (`dist/proxy/index.js`) from OMO's `settings.json`
   `extensions`, as noted under Removed.
6. Children that called the CLI `ask` command must use the `olw_ask` tool. The command
   itself stays for parents.

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
  GitHub source releases require repository-owner authorization through the documented workflow;
  only the one-time `v0.2.0` bootstrap starts from an owner-pushed version tag.
