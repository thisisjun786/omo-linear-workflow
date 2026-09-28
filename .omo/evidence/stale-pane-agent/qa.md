# Real-surface check: stale agent label

The live Herdr (0.9.1) manager pane `w4J:p1X` still reported `agent: pi` after its TUI had exited. `pane.process_info` for the same pane lists only a shell. A live role pane (`w4K:p8`) lists bun.

`bun .omo/evidence/stale-pane-agent/probe.ts w4J:p1X w4K:p8` returned:

```
Bun v1.4.0 (Linux x64)
```

Before this fix, `olw` treated the stale label as a running manager TUI. It skipped the relaunch and failed with `runtime_unavailable` / "Exact durable native session is not open". A `pane.release_agent` request returned ok but did not clear the label. This check is read-only; no processes were created.
