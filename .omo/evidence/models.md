# Role model readiness

Observed on 2026-09-22 with the installed OMO CLI.

Common command:

```sh
env HERDR_ENV=0 omo --mode json --print --no-session --no-tools \
  --no-extensions --no-skills --no-context-files --no-model-fallback \
  --no-recommended-models --model "$MODEL" --thinking "$LEVEL" \
  -- "Reply exactly MODEL_READY" < /dev/null
```

| Role | Model | Requested reasoning | Final text | Exit |
| --- | --- | --- | --- | --- |
| Supervisor | openai-codex/gpt-6-astra | high | MODEL_READY | 0 |
| Parent | kimi-coding/k3 | max | MODEL_READY | 0 |
| Child | claude-sdk-oauth/claude-opus-5 | xhigh | MODEL_READY | 0 |

The assistant response metadata identified the requested provider/model in each
case. Model fallback and recommended-model selection were disabled.

This proves provider readiness, not orchestration. Runtime thinking-level
retention is checked separately by `bun scripts/probe-models.ts`.

The first probe attempt lacked stdin EOF under the monitor's pipe fallback and
timed out before any model output. Redirecting stdin from `/dev/null` fixed the
probe. No production changes were made for this.

Cleanup: the three corrected CLI processes exited normally. The three initial
probe processes were ended by monitor timeout or explicit session termination.
No QA OMO session was saved and no Herdr workspace was created.
