# OMO Linear Workflow (OLW)

This repository owns a Herdr-based OMO initiative orchestrator. Source repositories
and the user's existing workspaces are read-only unless explicitly assigned.

## Contracts

- One parent per project and one child per issue. A user-created supervisor is
  optional (at most one per initiative); a project may have no initiative.
- Standalone parents require an explicit scope digest, designation and execute
  permission. Linking/unlinking a supervisor never transfers or widens that approval.
  A cross-designation link requires the project in the supervisor's approved snapshot.
- Manager loss/closure does not pause parents or children. Parent reports can be
  posted to the local user inbox (`reports --project ID`); `posted` is not native
  acceptance or user acknowledgment. Never migrate an existing logical ID or resend
  accepted/uncertain delivery. Only a proven pre-delivery rejection permits a same-ID,
  same-payload successor with preserved attempt history.
- Herdr creates every role workspace. Parents and children use distinct Herdr
  worktrees; a child's base is its parent's project integration branch.
- Runtime bindings use stable IDs, not display labels or the focused pane.
- Linear owns accepted scope and decisions. Local storage owns runtime identity
  and delivery receipts. Never infer accepted delivery from an idle agent.
- Event-driven delivery only. No supervisor/parent goal loops or repeated prompt
  polling. An issue child may hold one explicit packet-bound goal and run native
  mass-ulw phases; its workers are not OLW roles. Follow the child contract in
  `skills/run/SKILL.md`, verify artifacts, and keep parent acceptance separate.
- Preserve user focus with explicit IDs and `--no-focus`.
- Do not silently replace a requested model or reasoning level.
- Herdr is a required managed runtime, pinned by `vendor/herdr/manifest.json`
  and its patch. `bun run build` prepares it; never fall back to a global PATH
  binary or restart existing servers as part of a build.

## Model policy

- Models reach OMO only through opencodex. Its OMO integration owns
  `providers.opencodex` in `models.json`; never edit that block or add
  `modelOverrides` to it. OLW routing reads it; it does not own availability.
- The user's opencodex enable/disable choices are authoritative. Do not
  re-enable a disabled model to satisfy an upstream chain.
- opencodex publishes new-model metadata late or wrong (every model at a 32000
  `maxTokens` stand-in, lidge-jun/opencodex#5828). The user owns overrides in
  `MODEL_CATALOG` (`src/proxy/model-catalog.ts`): context, output, input
  modalities and reasoning per ocx model id. A set field always wins over ocx.
  The `dist/extension/model-catalog.js` extension, loaded by the managed
  launcher and role panes, re-registers corrected opencodex models at session
  start. `bun run proxy:routing catalog` lists changes, redundant fields and
  stale entries to prune.
- Keep OMO picker scope at `all` unless the user explicitly requests a local
  restriction again.
- Back up configuration before an authorized change, preserve unrelated user
  entries, and verify the live catalog without restarting existing sessions.

## Engineering

Use strict TypeScript on Bun. Use Zod at input boundaries and bun:sqlite for any
transactional registry. No `any`, unsafe assertions, ignored errors, or sleeps in
tests. Subscribe before triggering async actions and bound every wait.

Every behavior starts with a failing regression test, then its smallest fix.
Capture RED, GREEN, real-surface output, and cleanup receipts in `.omo/evidence/`.
Use `apply_patch` for authored files. Keep parallel producers' write scopes
disjoint. Run diagnostics, `bun test`, `bun run typecheck`, and `bun run build`.

Only the lead commits. Each verified increment is a separate Conventional Commit.
Do not push during QA. Use explicit temporary fixtures; a live Linear write check
requires separate user approval for its target, operations and cleanup. Preserve
its receipts, never repeat an uncertain create, and close only QA-created
workspaces/worktrees/processes.
