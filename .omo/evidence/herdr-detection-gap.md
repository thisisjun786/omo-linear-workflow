# Herdr OMO beta.82 detection gap

## Conclusion

The configured QA binary exists at `target/release/herdr` and its verified SHA-256 is `1d7e91b11f3ce35eec3248b940f03802e3767881449b99db65488e82031fc61f`. That patch recognizes the **old** Senpi entry-point path and not OMO beta.82's new bundled entry point. The supplied QA foreground argv starts with:

```
/home/jun/.bun/bin/bun
/home/jun/.local/nodejs/node-v24.20.0-linux-x64/lib/node_modules/omo-ai/node_modules/@code-yeongyu/senpi/dist/bundle/cli.js
```

`src/detect/mod.rs:377-423` treats Bun as a generic runtime and sends its script argument through package-path recognition. `agent_name_from_known_package_path` at `src/detect/mod.rs:624-672` recognizes Senpi only as these normalized five-component windows (`:657-662`):

- `node_modules/@code-yeongyu/senpi/dist/cli`
- `node_modules/@code-yeongyu/senpi/dist/cli-main`

It has no `node_modules/@code-yeongyu/senpi/dist/bundle/cli` case. Consequently `identify_agent_in_job` (`src/detect/mod.rs:261-288`) returns no agent for beta.82's Bun process, so screen-manifest matching is never given `Agent::Senpi`; `detect_agent_with_osc` returns `Unknown` immediately when its agent argument is absent (`src/detect/mod.rs:305-315`). The bundled `src/detect/manifests/senpi.toml` is therefore present but not reached. This explains `agent: null`, `agent_status: unknown`, and the unchanged low revision despite recognizable OMO chrome.

This is a version drift from the prior successful QA, not evidence that the OMO manifest itself regressed. `/var/tmp/herdr-omo-qa-report.md:13` records beta.53 using `.../@code-yeongyu/senpi/dist/cli.js`; its process test passed (`:28-31`). The existing regression test likewise covers only `dist/cli.js` at `src/detect/mod.rs:1243-1260`. Installed OMO reports `5.0.0-0.beta.82`, and its package declares `bin/omo.js`; an independently observed beta.82 process had the same Bun plus `dist/bundle/cli.js` argv prefix as the supplied QA process.

## Headless operation is not the cause

No graphical/TUI Herdr client is required for process detection. Each `TerminalRuntime` starts `spawn_basic_detection_task` when the pane runtime is created (`src/pane.rs:2214-2222`). That server-owned Tokio task runs continuously (`src/pane.rs:697-735`), probes the foreground job (`src/pane.rs:775-805`), and then reads the terminal detection buffer (`src/pane.rs:900-944`). Client attachment is absent from these gates. `scripts/qa-world.ts:83-89` deliberately starts `herdr --session ... server` with ignored stdin; that does not disable the pane runtime's detector.

## Separate session-report gap

The successful `pane.report_agent_session` acknowledgement does not mean the session was retained. OMO Initiative sends `source: "omo-initiative"`, `agent: "omo"`, and `agent_session_path` (`src/herdr/client.ts:160-166`). Herdr's handler always returns OK after constructing the event (`herdr-omo/src/app/api/panes.rs:1560-1587`), but `session_ref_from_report` first requires an official `(source, agent)` pair and otherwise returns `None` (`herdr-omo/src/agent_resume.rs:53-69`). `is_official_agent_source` has no OMO pair (`src/agent_resume.rs:245-265`), and paths are accepted only for `pi` or `omp` (`:63-66`). The resulting `None` is discarded immediately by `set_agent_session_ref_for_session_start` (`src/terminal/state.rs:1390-1399`). This explains the absent `agent_session`; it neither sets nor repairs process identity and is not the cause of `agent: null`.

The Initiative extension did execute its intended TUI path: it reports only after `mode === "tui"`, a real session file, and successful binding lookup (`omo-initiative/src/extension/runtime.ts:140-149`). Preserving `HERDR_PANE_ID` therefore fixes routing but cannot bypass Herdr's session-source/ref policy.

## Smallest appropriate integration fix

1. In patched Herdr, extend `agent_name_from_known_package_path` to recognize the exact Senpi suffix `node_modules/@code-yeongyu/senpi/dist/bundle/cli.js` (analogous to the already-supported Pi bundled path at `src/detect/mod.rs:636-650`). Add a process-identification regression using the beta.82 Bun argv. This is the minimal fix for `agent`/`agent_status`; no manifest change and no attached client are needed.
2. If OMO Initiative requires Herdr `agent_session` correlation, define an official OMO identity contract rather than relying on an acknowledged custom report: use one agreed source (prefer the existing `herdr:<agent>` convention, e.g. `herdr:omo`) on both sides, allow `(source, "omo")` in `is_official_agent_source`, and allow OMO's absolute JSONL path in `session_ref_from_report` (plus snapshot handling if restart persistence is intended). This is distinct from automatic conversation restore, which `docs/local-omo.md:60` explicitly excludes.

## Uncertainty

The isolated QA server/process had exited before this read-only investigation; the only live Herdr processes observed were stock 0.9.1 and were not touched. Thus I could not run `pane process-info` against that exact named server. The supplied QA argv, the installed beta.82 argv shape, the prior beta.53 report, and the deterministic source-path mismatch all agree on the cause. No source, process, session, or global configuration was modified.
