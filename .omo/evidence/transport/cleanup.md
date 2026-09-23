# Transport cleanup

- Producer tests used unique `mkdtemp` registries and removed them in `finally`.
- Native RPC and Herdr/model boundaries were faked; no real host, pane, workspace, model, or Linear resource was created.
- The Node extension bundle inspection used `/tmp/omo-transport-build` and removed it after inspection (`CLEANUP_OK`).
- No background process remains from this lane.
