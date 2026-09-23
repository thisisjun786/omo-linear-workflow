# Verification index

The current executable result is [final-runtime.md](final-runtime.md), not the
intermediate producer logs. Implementation commit: `621a21b`.

| Requirement | Failing-first evidence | Current passing evidence |
| --- | --- | --- |
| C1: durable unique ownership, hierarchy and duplicate receipts | `core/red.txt`, `core/red-worker.txt` | 50-test final gate; store process/reopen tests; real CLI status and event replay |
| C2: Herdr role workspaces, distinct worktrees and parent ancestry | `herdr/red.txt`, `cli/red.txt`, [lead-fixes.md](lead-fixes.md) | Actual `qa:herdr`, exact role tuples, no duplicate launch, focus and closure checks |
| C3: native idle wake, correlated receipts, invalid-route and restart safety | `transport/red.txt`, `transport/client-red.txt`, [final-repairs.md](final-repairs.md) | Actual `qa:events`; both upward reports, fresh-process duplicate suppression, uncertain loss reconciliation |
| C4: scope validation and actual MCP/skill boundary | `linear/red.log` | Actual `qa:linear`: three MCP read calls, stable IDs, four loaded ported skills |
| Final gate | Intermediate failures retained in producer directories | 50 tests, strict typecheck, lint, build; source LSP has no errors |
| Cleanup | [cleanup.md](cleanup.md) | Every isolated QA world/server/host removed; default Herdr untouched |

The latest local dependencies are OMO beta.84 and Senpi 2026.9.22-4. Models and
thinking remain Astra/high, Kimi k3/max, and Opus 5/xhigh; current authenticated
provider IDs are `chatgpt-subscription`, `kimi-coding`, and
`anthropic-subscription`. Older logs predate the provider-name migration.

## Independent review and staged DAGs

- Discovery/design: `dag_beaded2f-9ab2-43ee-b67a-e6739539ca86`. The accepted
  design was retained; a redundant late revision was cancelled, so this run's
  engine status is not claimed as green.
- Implementation: `dag_8ff1c76c-44be-402a-82cb-e92f51ace468`, seven nodes.
- Verification: `dag_3b0e8236-5793-43f8-aed9-c1dc29e7e9a8`, amended after fixes.
  [Lifecycle](final-lifecycle-review.md) and [delivery](final-delivery-review.md)
  reviews both resolved their blocking findings. The final runtime node exposed
  a real provider migration; the lead fixed it and personally reran all three
  real QA commands successfully.

The blind README review's root/digest/ID/setup gaps were addressed in the shipped
README. Role model values are enforced by `src/core/policy.ts`; the README and
skill reference table agree with that policy. These duplicate tables are
documentation and independent test expectations, not separate runtime settings.

Sentinel responses prove routing and wake, not autonomous task quality. Local
MCP fixture results do not prove live Linear authentication or accepted delivery
in Linear. Live OAuth and writes were not attempted.
