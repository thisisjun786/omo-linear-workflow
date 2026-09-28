# Real-surface QA: TUI proof on a handed-off host

Command: `bun scripts/qa-handoff-proof.ts`. It uses a disposable Senpi host under a mktemp root with a temporary agent dir, and never touches the live control root.

Steps: `host ensure`, then `host handoff` to generation 1. Open a real `RpcClient` session on the public socket, publish a readiness receipt that binds this process pid/starttime to a nonce, and call `proveTuiConnection`. Then disconnect and call it again.

The kernel reports the live listener under both `omo.sock.next-1` and `omo.sock`.

| code | proof with a real attached client | proof after disconnect |
|---|---|---|
| origin/dev (before fix) | **false** (bug reproduced) | false |
| this branch | **true** | false |

Cleanup receipt: every run stopped its host with `host stop` in `finally` and removed its temp root (`rootRemoved: true`). A process check found no leftover `olw-handoff-proof` processes.

The script now enforces pass criteria: it prints `QA_PASS` and exits 0 only when the proof with a real attached client is true, the proof after disconnect is false, host stop succeeds, and the temp root is removed. Otherwise it exits 1. Re-run: this branch printed `QA_PASS`, exit 0. With `origin/dev`'s readiness.ts it printed `QA_FAIL`, exit 1. No leftover processes.
