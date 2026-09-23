# OMO Initiative

This repository owns a Herdr-based OMO initiative orchestrator. Source repositories
and the user's existing workspaces are read-only unless explicitly assigned.

## Contracts

- One supervisor per initiative, one parent per project, one child per issue.
- Herdr creates every role workspace. Parents and children use distinct Herdr
  worktrees; a child's base is its parent's project integration branch.
- Runtime bindings use stable IDs, not display labels or the focused pane.
- Linear owns accepted scope and decisions. Local storage owns runtime identity
  and delivery receipts. Never infer accepted delivery from an idle agent.
- Event-driven delivery only. No agent goal loops or repeated prompt polling.
- Preserve user focus with explicit IDs and `--no-focus`.
- Do not silently replace a requested model or reasoning level.
- Herdr is a required managed runtime, pinned by `vendor/herdr/manifest.json`
  and its patch. `bun run build` prepares it; never fall back to a global PATH
  binary or restart existing servers as part of a build.

## Engineering

Use strict TypeScript on Bun. Use Zod at input boundaries and bun:sqlite for any
transactional registry. No `any`, unsafe assertions, ignored errors, or sleeps in
tests. Subscribe before triggering async actions and bound every wait.

Every behavior starts with a failing regression test, then its smallest fix.
Capture RED, GREEN, real-surface output, and cleanup receipts in `.omo/evidence/`.
Use `apply_patch` for authored files. Keep parallel producers' write scopes
disjoint. Run diagnostics, `bun test`, `bun run typecheck`, and `bun run build`.

Only the lead commits. Each verified increment is a separate Conventional Commit.
Do not push or modify real Linear objects during QA. Use explicit temporary
fixtures and close only QA-created workspaces/worktrees/processes.
