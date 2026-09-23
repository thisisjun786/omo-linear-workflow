# Herdr adapter evidence

## RED

Command: `bun test ./tests/herdr.test.ts`
Result: exit 1, 0 pass / 5 fail. Every regression reached the declared adapter stub and failed with `Herdr client not implemented`; no failure was a missing import. Full output: `red.txt`.

## GREEN

Command: `bun test ./tests/herdr.test.ts`
Result: exit 0, 5 pass / 0 fail / 15 assertions. Full output: `green.txt`.

Command: `bunx biome check src/herdr tests/herdr.test.ts tests/herdr`
Result: exit 0, 5 files checked.

Command: `bunx tsc --noEmit --target ESNext --lib ESNext --module ESNext --moduleResolution Bundler --types bun --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --noPropertyAccessFromIndexSignature --verbatimModuleSyntax --isolatedModules --esModuleInterop --skipLibCheck src/herdr/client.ts src/herdr/schema.ts src/herdr/index.ts tests/herdr.test.ts tests/herdr/argv-fixture.ts`
Result: exit 0.

Changed-file language diagnostics: no errors in tests; the language server timed out refreshing the three source files after previously reporting them clean, so the targeted strict TypeScript command above is the source diagnostic proof.

Repository-wide `bunx tsc --noEmit --pretty false` was also run and exited 2 on installed dependency declarations plus concurrent core-lane `.ts` imports/test typing. It reported no Herdr-owned diagnostic.

## Cleanup

All tests use per-test temporary directories and Unix sockets. `afterEach` closes every client/server and recursively removes each fixture directory. The shell fixture writes only beneath its test temporary directory. No real Herdr, model, Linear, workspace, or worktree operation was invoked.

## Contract note

`subscribe` returns `Promise<() => void>` because the explicit frozen requirement says it must not resolve before the separate connection receives `subscription_started`; a synchronous `() => void` return cannot represent that ACK barrier.
