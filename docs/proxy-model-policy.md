# Manual-first proxy model policy

## Authority

The user's CLIProxyAPI management configuration owns model registration and
availability. Manual account/model registration, enablement and disablement take
precedence over OLW recommendations and the current OMO routing preferences.
OLW must not continuously prune catalogs, regenerate exclusion lists at startup,
restore disabled models to satisfy an upstream chain, or hide newly registered
models behind an OMO allowlist.

The installed management UI labels this policy **OAuth Model Disablement**.
Its durable field is `oauth-excluded-models` in
`~/.config/cliproxyapi/config.yaml`. The supported management endpoint is
`/v0/management/oauth-excluded-models`; GET reads it and PATCH updates one
provider's `models` list. A PATCH replaces that provider's entire list: read
first and preserve every unrelated entry. PUT replaces the entire map and is
reserved for reviewed migrations. Never print management keys or the full config.

This repository stores operating instructions, not a second authoritative copy
of the user's live policy. Management credentials remain outside the repository
in `~/.config/cliproxyapi/management-access.json`.

## How the user manages models

1. Open the existing private CLIProxyAPI management page and choose OAuth Model
   Disablement for the relevant provider.
2. To enable a model, remove its exact ID from that provider's disabled list.
   To disable it, add its exact ID. Save in the management UI.
3. Use `/proxy-refresh` in OMO, or start a new OMO session, to refresh the catalog.
   To reconsider category/agent assignments too, run from this repository:
   `bun run proxy:routing sync --force`.

An enabled model is eligible for discovery, not automatically a new preferred
route. Main/profile/OLW role pins remain explicit. A manually disabled referenced
model is not silently re-enabled: choose another model or adjust the route when
necessary. If metadata is incomplete, registration can still produce a diagnostic
instead of a callable chat model; do not suppress that diagnostic globally.

Do not infer the disablement key from a display label. On the current 7.3.15
installation the working keys are `claude`, `codex`, `xai`, `antigravity`, `devin`
and **`kimi-ai`**. The upstream example's `kimi` key did not affect the live
Kimi catalog here; `kimi-ai` was verified through `/v1/models`.

Use exact IDs for one-time cleanup. Do not use `*` or broad family patterns to
hide future models that the user may register. A newly introduced ID or provider
therefore remains available unless the user explicitly disables it.

## OpenAI-compatible manual providers

The configured MiMo Token Plan and Ollama Cloud providers are OpenAI-compatible,
not OAuth.
OAuth Model Disablement does not manage its individual registered models.
Its registrations live under `openai-compatibility` and are edited in that
provider's model list in the management UI.

Manual registrations take priority: do not delete or rewrite them merely because
OMO currently references only a subset. In this migration all four user-registered
MiMo entries were preserved, including V2.5 and V2.6 Flash. For a later explicit
request to remove an individual compatible model registration, save that entry
first so it can be restored. Do not fabricate OAuth exclusions that have no effect.

### Ollama Cloud DeepSeek registration

The manually registered `ollama-cloud` provider uses `https://ollama.com/v1` and
advertises `deepseek-v4.1-flash`. Its API key is held only by CLIProxyAPI, not OMO
or this repository. Toggle the entire provider with its management-UI disabled
switch, or edit its registered model list; OAuth Model Disablement does not apply.

Ollama `/api/show` supplies 1,048,576 context, text/image input, tools, and
`false`/`low`/`high`/`max` thinking. Its OpenAI-compatible API expresses the
`false` choice as `reasoning_effort: "none"` for this registration. The extension's 16,384
output budget is a client policy, not a published Ollama server maximum. The older
`deepseek-v4-flash:0731` was not registered because its advertised retirement date
was 2026-09-25. No Command Code provider or key was registered.

## OMO and OLW responsibilities

- The previous local picker restriction is disabled:
  `~/.omo/proxy-routing/model-scope.json` has `mode: "all"`.
- Normal `omo`/`omon` launches do not inject a referenced-only `--models` list.
  Do not re-enable `scope referenced` unless explicitly requested again.
- OMO's provider catalog follows the proxy. GPT `-fast` choices are local
  priority selectors and still require their base model to be enabled. For
  example, keep `gpt-6-luna` for `gpt-6-luna-fast`.
- The routing synchronizer reads availability and updates eligible untouched
  category/agent routes. It never writes proxy disablement policy. An unchanged
  startup can use its cached routing receipt; force sync after a policy change
  when the user wants immediate route recalculation.
- Keep custom/manual route overrides, context limits, direct-auth disablement,
  and OLW role pins separate from this availability policy.
- Existing sessions need catalog refresh; no OMO/Herdr restart is required by
  the management policy update itself. An older session may retain its launch
  scope; switching its `/model` view to all or starting a new session removes
  that presentation limitation.

## One-time migration and recovery

On 2026-09-23 a one-time exact-ID cleanup retained the OAuth wire models required
by current main, profile, category, agent, fallback, auxiliary and role references.
Previously disabled IDs stayed disabled. Accounts and credentials were preserved.
There is no background policy writer, startup exclusion generator or repository
policy snapshot that overwrites the management UI.

The migration backup is:

`~/.omo/proxy-routing/backups/proxy-policy-2026-09-23T13-32-22.476Z/before.json`

It contains the previous exclusion map and local picker preference, not secrets.
The adjacent proposed file is a historical proposal, not an active configuration;
its Kimi key was corrected to `kimi-ai` during live verification. Consult the
running management API or config file for current truth.

For selective restoration, remove only the desired IDs from the management UI's
current list. For a whole-policy rollback, compare current manual edits against
`before.json` first, then restore the reviewed map through the management UI/API.
Do not overwrite later manual additions with an old backup. Restoring the old
referenced-only OMO picker is not necessary to restore proxy models.
