# Transport verification

## RED

- `red.txt`: the five extension behaviors failed against the declared no-op boundary (`0 pass, 5 fail`, exit 1).
- `client-red.txt`: duplicate exact host rows were incorrectly accepted (`1 pass, 1 fail`, exit 1).
- `direct-argv-red.txt`: the worker regression expected direct `bun` execution and observed the old `sh` pipeline (`4 pass, 1 fail`, exit 1).

## GREEN

- `bun test tests/events.test.ts`: exit 0, 5 pass, including direct `bun <absolute-worker> <json>` invocation with a bounded timeout.
- `bun test tests/transport`: exit 0, 2 pass.
- `bunx biome check src/transport src/extension tests/events.test.ts tests/transport`: exit 0.
- Node-target extension bundle: exit 0 and `NODE_EXTENSION_NO_BUN_SQLITE`; temporary bundle removed.
- Language diagnostics: no errors in `src/transport/**`, `src/extension/**`, or `tests/transport/**`. The language-server request for the large `tests/events.test.ts` timed out; Bun compiled and passed that file in the test run.

## Repository composition status

The restored Herdr/core APIs remove the transient missing-module failure. Repository-wide `bun run typecheck` now reaches lead-owned integration tests and exits 2 because `src/host-profile.ts` and `src/orchestrator.ts` have not yet been composed. No owned transport or extension diagnostic is present. Exact output is retained in `restored-green.txt`.
