# Lead integration corrections

## Herdr protocol

- Real `worktree.remove` replies with `worktree_removed`, not `ok`.
  Corrected fixture first failed with Zod "expected ok"; dedicated schema now
  accepts the actual reply. No force removal was added.
- A socket chunk split inside a Korean UTF-8 codepoint changed `/tmp/한글` into
  `/tmp/���글`. A deterministic Socket readable-push regression reproduced it;
  native stream UTF-8 decoding fixes it.
- Post-ACK subscription disconnects were silently swallowed. The exact close
  event test first failed at its bounded timeout, then passed. Unexpected closure
  now yields a `connection.error` callback; explicit unsubscribe does not.
- Herdr regression suite: 7 pass, 0 fail, 17 assertions. Actual current Herdr
  subscribe ACK and snapshot also succeeded without mutations; connection closed.

## Registry worker and replay

- Public extension `pi.exec` does not accept stdin. Real worker argv invocation
  failed with invalid_request before the worker accepted one JSON argv argument.
  Both argv and stdin tests now pass; no shell pipeline needed.
- Identical envelopes with reordered JSON keys incorrectly conflicted. The new
  regression failed with message_conflict; schema canonicalization before
  comparison fixed it. Changed values still conflict.
- Store suite: 6 pass, 0 fail, 34 assertions, including real SQLite and independent
  process ownership competition.

## Strict dependency declarations

The project retains strict checking without skipLibCheck. The pinned local Senpi
package carries two declaration-only compatibility corrections through pnpm:

1. MCP SDK's clientMetadataUrl may explicitly be undefined, as its implementation
   and Senpi getter already support.
2. Gaxios implements the callable fetch signature, not Bun fetch's additional
   static preconnect member.

No runtime JavaScript, global OMO installation or global SDK was patched.
Web API and async iterable libraries are declared in tsconfig. An isolated strict
ESNext check of the public ExtensionAPI passed.

## Formatting recovery

A lead formatting helper incorrectly sent no stdin and applied empty formatter
output to ten files. It was stopped and removed. All ten originals were restored
from saved read/patch records; their byte/character counts matched the recorded
pre-change values exactly. Store/Herdr/skills suites then passed all 16 tests and
64 assertions. No test was deleted, skipped or weakened.

The corrected path writes stdin before ending it, rejects blank output, previews
the entire change, retains original text, and applies changes through apply_patch.
