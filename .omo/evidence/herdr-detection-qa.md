# Herdr OMO detection real-surface QA

## Stock 0.9.1 baseline (RED)

```sh
QA_HERDR_BINARY=/home/jun/.local/bin/herdr bun .omo/evidence/qa-herdr-detection.ts
```

The valid baseline in `mon_SJSD5WQ948RHF0Q1` launched a real OMO supervisor
in an isolated named stock Herdr server, then failed its actual agent lookup:

```text
agent_not_found: agent target w2:p1 not found
CLEANUP: QA worktrees, workspaces, Herdr server, OMO host and fixture removed
```

No fixed sleep or repeated status polling was used. The stock binary's SHA-256
was `2a02fed16beb651ef006e1d43f048f652ca4dc58ad053cd2d44450563d5c54b7`.
The default user server and workspaces were left running.

## QA corrections

The first probe (`mon_Q4QPTG9D6BGPP7GQ`) subscribed only generic pane events;
its timeout alone was insufficient evidence of a detection failure. A later
probe subscribed the status channel but confused native `agent_end` with
terminal repaint completion and missed an already-started working transition.
Neither probe is used as passing evidence.

The final probe uses Herdr's own atomic `agent prompt --wait --until working`
after `agent wait` has observed screen idle/done, then waits for idle/done again.
It reads the actual bottom buffer and detection explanation, checks process
identity, and exercises the existing reporter against the real socket.

## Final candidate (GREEN)

Monitor `mon_66R7H5724221WYZM` completed exit 0 with:

```text
INITIAL_AGENT: agent=omo, agent_status=idle
DETECTION_WORKING: agent=omo, agent_status=working, state_change_seq=2
DETECTION_SETTLED: agent=omo, agent_status=done, state_change_seq=3
HERDR_DETECTION_QA_PASS: real bundled OMO became working then idle/done
REPORTER_WORKING: agent=omo, agent_status=working
DETACHED_REPORTER_QA_PASS: real reporter event and release accepted
CLEANUP: QA worktrees, workspaces, Herdr server, OMO host and fixture removed
```

The lead read the captured working screen. Its actual editor header was:

```text
── • Working (0s • esc to interrupt) ───────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
```

`agent explain` reported bundled manifest `2026.09.05.2`, rule
`interrupt_suffix_working`, region `senpi_current_status`, state `working`,
`visible_working: true`, and no override, skip, fallback or warning.
Process inspection showed Bun running Senpi 2026.9.22-4's `dist/bundle/cli.js`
through OMO beta.84 with `chatgpt-subscription/gpt-6-astra`, `high`.
The exact QA pane was `w2:p1` in `qa-world-NzSKVN`.

The reporter check invokes the installed `createReporter` with the real
`senpi-codemode` event shape and real socket transport. It proves report/release
integration, not the model's generation of a detached eval. Focus remained on
the isolated anchor; the world was removed.

## Diagnostic limitation

The evidence script ran successfully. Its separate strict TypeScript check
exited 2 solely on the unchanged external reporter:

```text
../../.omo/agent/extensions/herdr-senpi-agent-state.ts(153,26):
TS2559: Type 'ProcessEnv' has no properties in common with type 'Environment'.
```

The corresponding LSP query timed out after 3000 ms. This pre-existing default
parameter typing issue is outside the orchestrator's source and was not
suppressed or patched in the user's installed extension. The normal project
typecheck passed; the reporter's actual wire behavior and 12 asset tests passed.
