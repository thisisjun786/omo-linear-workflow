# P4 Linear adapter verification report

## Scope
Implemented `src/linear/**`, `tests/linear.test.ts`, `tests/fixtures/scope.json`, and this evidence directory. No edits to core schema, skills, package files, or other producers' lanes. No live Linear/OAuth/network calls.

## Changed paths
- `src/linear/index.ts`
- `src/linear/scope.ts`
- `src/linear/brief.ts`
- `tests/linear.test.ts`
- `tests/fixtures/scope.json`
- `.omo/evidence/linear/red.log`
- `.omo/evidence/linear/green.log`
- `.omo/evidence/linear/typecheck.log`
- `.omo/evidence/linear/lint.log`
- `.omo/evidence/linear/full-test.log`
- `.omo/evidence/linear/build.log`
- `.omo/evidence/linear/report.md`

## RED / GREEN
1. RED: committed stub implementations returned `not_implemented` / `stub brief`; all 12 assertions failed for the right reason. See `red.log`.
2. GREEN: implemented `readScopeSnapshot` using frozen `scopeSnapshotSchema`, plus explicit validation for whitespace-only revisions and duplicate membership IDs. Implemented `buildRoleBrief` with embedded machine bindings, scope references, role behavior, and QA-standby instructions for fixture source. All 12 tests pass. See `green.log`.

## Verification commands and exit results
| Command | Result |
|---|---|
| `bun test tests/linear.test.ts` | exit 0, 12 pass |
| `bun test` | exit 0, 27 pass across 5 files |
| `bunx biome check src/linear tests/linear.test.ts tests/fixtures/scope.json` | exit 0, no issues |
| `bun run lint` | exit 1, but only pre-existing errors in lead-owned `scripts/qa-*.ts`; owned files clean |
| `bun run typecheck` | exit 2, but only pre-existing errors in upstream `node_modules` type declarations; owned code typechecks |
| `bun run build` | exit 1, `scripts/build.ts` does not exist (lead-owned) |

## Contract notes
- `readScopeSnapshot` returns `Result<ScopeSnapshot>` with codes `read_error`, `parse_error`, `schema_violation`, `malformed_revision`, `duplicate_membership`.
- `buildRoleBrief` computes the same SHA-256 digest the registry uses (`JSON.stringify(snapshot)`), so brief `snapshot_digest` matches the frozen digest contract.
- Fixture briefs explicitly set `qa_standby: true`, `respond_only_to_explicit_messages: true`, `never_fetch_live_linear: true`, `never_create_additional_sessions: true`, `never_implement_repository_work_autonomously: true`, and `no_autonomous_goal_loop: true`.

## Cleanup
Tests use `mkdtemp` under `os.tmpdir()` and remove directories in `afterEach`. No persistent QA resources remain.
