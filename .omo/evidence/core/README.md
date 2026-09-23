# Core implementation evidence

## RED

- `red.txt`: `bun test tests/store.test.ts tests/core/schema.test.ts` exited 1 because the declared `openRegistry` boundary returned `registry not implemented`; schema and exact-role policy assertions already passed.
- `red-worker.txt`: `bun test tests/store.test.ts -t 'worker executes'` exited 1 because the declared worker returned `not_implemented` instead of the requested lookup Result.

## GREEN

- `final-store-test.txt`: `bun test tests/store.test.ts` exited 0 (5 tests, 29 assertions).
- `final-schema-test.txt`: `bun test tests/core/schema.test.ts` exited 0 (2 tests, 5 assertions).
- `final-typecheck.txt`: targeted strict TypeScript diagnostics for every owned source and test exited 0.
- `final-biome.txt`: `bunx biome check src/core tests/store.test.ts tests/core` exited 0.

The store regression uses two separately spawned Bun processes, arms both through stdin/stdout barriers before release, and exercises one real WAL SQLite file. Every test uses a unique temporary directory removed in `finally`; the worker closes its registry and the test reopens the same database. No Herdr, OMO model, or Linear resource was created, so cleanup has no external receipt.

## Repository-wide diagnostic mismatch

`bunx tsc --noEmit --pretty false` was also run. It reached the owned files and initially identified issues that were fixed, but remains nonzero because lead-owned installed dependency declarations fail under the repository config (`@code-yeongyu/senpi` OAuth optionality and missing DOM request/header types). The targeted strict command in `final-typecheck.txt` uses `--skipLibCheck` and `DOM` only to isolate owned files; it reports no owned diagnostic.
