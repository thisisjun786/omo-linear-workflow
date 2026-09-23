# Blind README Review

## What it is, does, and expects
- This is a Bun CLI connecting Linear-approved initiative scope to Herdr worktrees and native OMO threads.
- Linear owns scope and decisions; local SQLite stores approved snapshots, execution authorization, runtime identity, and delivery receipts.
- It creates supervisor/parent/child bindings, imports scope, sends instructions, records reports, shows status, pauses/resumes communication, and reconciles state.
- It expects execution inside Herdr, with `omo`, `herdr`, and `git` on `PATH`, Bun/pnpm dependencies installed, and three authenticated OMO role models.
- Linear access is expected through the existing OMO Linear MCP connection; approved scope must come from the specified skills and a revision-pinned snapshot.
- It expects absolute paths where shown, valid IDs/digests/bindings, an approved scope file, and a local QA fixture only when explicitly using `--fixture`.

## Unclear or assumed setup
- The README does not explain how to install/configure Bun, pnpm, Herdr, or the three model credentials, nor what “inside Herdr” concretely means.
- It does not define the required formats or locations for `approved-scope.json`, scope snapshots, designations, bindings, evidence, or runtime state.
- It assumes users know how to obtain the initiative ID, scope digest, project/repository, issue IDs, and message IDs.
- It names three OMO authentications but does not give the authentication command or identify which account/configuration each role uses.
- The MCP auth and skill-loading instructions are described procedurally but do not state the exact CLI invocation or expected output.
- It does not specify SQLite initialization, permission requirements, supported OS/version constraints, or cleanup/recovery procedures.
- The QA commands imply fixtures, an isolated Herdr server, and a local HTTP fixture, but their required environment/configuration is not documented.
- “Native OMO RPC,” `session_start`, and `delivery: auto` are relied upon without documenting endpoint/configuration details.

## What I had to guess
- I inferred that `bun run cli --` is the project’s command wrapper and that the examples are run from the repository root.
- I inferred that `--root "$PWD"` selects the initiative/runtime root and that all shown placeholder IDs must be replaced with real values.
- I inferred that “three roles’ authentication” means separate usable credentials/configuration for supervisor, parent, and child model sessions.
- I inferred that the named skill files are available to the OMO environment rather than local files supplied by this CLI.
- I inferred that successful `doctor --json` is the practical readiness check before operational commands.

## Verdict
**Needs work.** The architecture, command surface, constraints, and stated verification coverage are clear, but a new operator cannot reliably perform setup or execute the workflow without undocumented credential, artifact-format, environment, and fixture details.