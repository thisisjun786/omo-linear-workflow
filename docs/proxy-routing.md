# OMO upstream routing through CLIProxyAPI

OLW can follow the **installed global OMO's category and named-agent policy**
while keeping every generated route on `cliproxyapi`.

Prerequisites are the existing proxy-only setup described in
[the proxy extension guide](../README.md#프록시-모델-확장): native connections are
already disabled, and the client and management credential files are present
under `~/.config/cliproxyapi/`. This feature does not perform that migration.
It manages the existing `~/.omo/omo.jsonc`; first-time adoption should be reviewed
because it replaces stock-name routing fields, including any older manual pins
there. Main-model and OLW-role pins remain outside its scope.
Generated routes are proxy-only; preserved manual overrides are not rewritten
or rejected by this synchronizer. Native-provider disablement remains a separate
prerequisite, not a side effect of reading native model metadata.

## Automatic behavior

The managed `omo` launcher checks routing before starting upstream OMO.
`omon` uses that launcher too. OLW checks it before ensuring its shared host.
An unchanged version, bundle digest and user configuration require no proxy
connection and do not rewrite configuration.
Without adoption state, a normal checked launch fails and requests explicit
`sync --adopt`; it never silently adopts older manual pins.

On change, the synchronizer reads the actual installed `omo-task.js` with a
TypeScript syntax tree. It does not execute the bundle or infer policy from
release notes. It extracts ordered model choices and reasoning levels, keeps
available exact model IDs or explicitly verified same-model IDs, and maps them
to the proxy provider. An advertised exact ID takes precedence over a mapping.
Repeated provider lanes for the same model and reasoning level collapse.
Unserved candidates are recorded under `skipped`; another model family is
never invented as a replacement.

Native review/QA agents that inherit categories retain that upstream behavior:
their old migration-generated model overrides are removed, rather than freezing
the inherited category list into another model table.

`gpt-…-fast` is a client-side priority selector. The proxy extension exposes it
for Responses GPT models and sends the advertised base model ID together with
`service_tier: "priority"`. This is not a claim that the proxy advertises an
independent fast model, nor a latency or billing guarantee.

Kimi's `kimi-for-coding-highspeed` product ID maps to the proxy's advertised
`kimi-k2.7-code-highspeed`. [Kimi's model documentation](https://www.kimi.com/code/docs/en/kimi-code/models.html)
identifies the product ID as K2.7 Code HighSpeed. This mapping does not replace it
with K3, nor rewrite the upstream reasoning level. On the current deployment, an
actual request with `reasoning_effort: "none"` succeeded but returned reasoning
tokens. A configured `off` therefore must not be described as guaranteed
non-thinking execution through this service.

DeepSeek's rolling `deepseek-flash` ID currently identifies V4.1 Flash according
to [the official model table](https://api-docs.deepseek.com/quick_start/pricing).
The verified mapping uses an advertised `deepseek-v4.1-flash` when the exact
rolling ID is absent, preserving each route's reasoning level. Recheck that
identity if the upstream rolling alias changes; older V4 Flash is not substituted.

For configured OpenAI-compatible providers such as MiMo Token Plan, the proxy
may publish context/input fields but omit the output-token limit. The standalone
synchronizer now loads the policy authority's public SDK model catalog lazily
when compatible providers are configured. Like the running extension, it matches
both the configured upstream model ID and base URL to obtain missing metadata.
It neither guesses limits nor enables/authenticates native providers. Missing
metadata still causes omission with a diagnostic. Run `sync --force` after adding
a provider to reconsider the available upstream routes.

For the exact Ollama Cloud endpoint `https://ollama.com/v1`, which does not
advertise output-token limits, the extension uses a 16,384-token client output
budget, matching Senpi's Ollama default. This is not a server-maximum claim.
Context, modalities and thinking levels remain the proxy's manual model metadata;
`none` in its thinking levels maps explicit off to `reasoning_effort: "none"`.
Requests still go through CLIProxyAPI; OMO never loads the Ollama API key.

## Ownership and version policy

- The global OMO found outside the managed wrapper and `node_modules` is the
  policy authority. Its version and exact bundle digest are recorded.
- The OLW-pinned OMO package is not upgraded or allowed to write a competing
  global policy. Its task routes use the same user configuration as before.
- OLW role pins in `src/core/policy.ts`, existing binding identities, the main
  model, model profiles, compaction, retry settings, and `models.json` overrides
  are outside this synchronizer's ownership.
- Initial `sync --adopt` adopts stock category/agent routing fields from the
  earlier proxy migration. It backs up the configuration first.
- Thereafter, a routing field changed by the user is marked `overrides` and left
  alone. Other route properties, such as prompts, tools and disable flags, keep
  their values. Unrelated top-level JSONC text is preserved; the two routing
  sections are serialized again, so their original comments live in the backup.
- To resume automatic tracking for a manually changed route, restore its
  routing fields to the last values in `state.json`'s `managed` entry, then sync.
  Do not delete the state file just to update one route.

## Commands

Run these from the OLW repository:

```sh
bun run proxy:routing status          # Last applied policy, overrides and omissions
bun run proxy:routing check --force   # Read-only diff against fresh proxy metadata
bun run proxy:routing sync --force    # Recheck after accounts/models change
```

## Optional local model-picker scope (disabled)

The user now manages availability with CLIProxyAPI **OAuth Model Disablement**.
The active OMO scope is `all`; manual registration and UI choices take priority.
See [manual-first model policy](proxy-model-policy.md) for the authoritative
configuration, provider limitations and recovery. Do not automatically enable
`referenced` scope or regenerate proxy exclusions from routing preferences.
The commands below remain an optional local feature, not the current policy.

```sh
bun run proxy:routing scope referenced  # Narrow managed omo/omon model pickers
bun run proxy:routing scope             # Inspect the mode and referenced IDs
bun run proxy:routing scope all         # Restore ordinary, unrestricted launch scope
```

This does not delete accounts, provider models, or routes. The launcher passes
OMO's native `--models` option using current global categories, agents, profiles,
main model, retry chains, compaction, vision, explicit favorites and OLW role
defaults. Thinking-level history is not a live reference. There are no age-based
guesses and no exception for newly added MiMo models.

The list is recalculated after routing preflight on each managed launch, so newly
referenced upstream choices appear automatically, not every newly available
proxy model. A failed reference read blocks the checked launch rather than
silently expanding its scope. An explicit user `--models` takes
precedence; an explicitly selected `--model` remains accessible. Original
`settings.json` and its `enabledModels` value are not rewritten. Existing
sessions and clients that bypass the managed launcher are not changed.

The preference is `~/.omo/proxy-routing/model-scope.json`; every mode change saves
the previous preference under `~/.omo/proxy-routing/backups/model-scope-*.json`.
Those files contain a `mode` value that can be reapplied with the scope command.
Restoration to `all`
works even if routing configuration is temporarily unreadable. Inside `/model`,
Tab switches between `narrowed` and `all` without changing this saved preference.
The raw proxy catalog and `--list-models` still expose all callable models; this
feature limits the default picker/cycling scope, not API availability.

The unused metadata-warning models `grok-composer-2.5-fast`,
`claude-3-5-haiku-20241022` and `gemini-3.1-flash-image` are separately excluded in
the proxy's OAuth model-exclusion settings for xai, claude and antigravity.
No warnings are globally suppressed. Restoring picker scope does not remove
those explicit exclusions; review their metadata before re-enabling them.
In the private management UI, edit OAuth excluded models for the named provider
and remove only the exact model ID, preserving any other exclusions. This is the
`oauth-excluded-models` map in `~/.config/cliproxyapi/config.yaml`; the management
API applies it to the running service without restarting active sessions.

## First-time activation

First-time activation:

```sh
bun run build
bun run proxy:routing check --force
bun run proxy:routing sync --adopt
```

On this machine, `~/.local/bin/omo` is already installed as a thin executable
wrapper that runs `/home/jun/code/omo-linear-workflow/dist/omo.js`.
It must precede the upstream executable in PATH. Normal OMO updates do not need
another adoption; the next launcher start performs the check.
If the OLW checkout moves, update that wrapper's absolute path.
Calling the upstream executable directly bypasses this startup check.

For another checkout location, create `~/.local/bin/omo` with the following
content after replacing the checkout path, then run `chmod 755 ~/.local/bin/omo`.
Back up an existing launcher instead of overwriting an unrelated one.

```sh
#!/bin/sh
exec bun /absolute/path/to/omo-linear-workflow/dist/omo.js "$@"
```

Upstream discovery chooses the first `omo` in the remaining PATH after excluding
`~/.local/bin` and `node_modules` directories. Thus a repository's pinned binary
does not win merely because `bun run` prepended it. Inspect the selected executable
in `proxy:routing status`'s `upstream` field.

The synchronizer runs on Bun and uses Linux `flock` to serialize concurrent
starts. `check` and `sync` accept explicit `--upstream`, `--config`,
`--state-dir`, `--client` and `--management` paths for isolated verification.
`status` accepts `--state-dir`. Proxy-only account/model changes do not invalidate
the unchanged-startup shortcut: run `sync --force` to reconsider routing after
those changes. The provider's normal catalog refresh still runs independently.
There is no background polling service and no running-session restart.
`--version`, `--help` and maintenance commands remain usable without a routing
check. Active sessions may retain their already-loaded policy until restarted.

## Failure and recovery

State, original configuration backups and a recovery journal live in
`~/.omo/proxy-routing/`, with private file permissions.
Configuration and receipt replacement are atomic per file; the journal repairs
an interrupted publication before the next sync. A detected concurrent manual
edit is not overwritten.

An unknown upstream layout, an unusable complete model chain, or a proxy error
during an update leaves the last valid configuration intact and fails the
preflight with an actionable error. It does not enable native providers or
substitute an arbitrary model. Fix the reported problem and run `sync --force`.
If even one managed route has no surviving model candidate, the entire update
is rejected rather than publishing a partial configuration.
If a pending journal reports a conflicting edit, inspect it and the backup before
choosing which configuration to retain.

To retain the current manually edited configuration, stop starting new OMO
processes briefly, move `pending.json` to a uniquely named saved file in the same
directory, and run `sync --force`. Keep `state.json`: it is what lets the next
sync distinguish manual edits from the last managed routing. Retain the saved
journal and backup until the resulting `overrides` and configuration are reviewed.

For rollback, disable the OLW-managed launcher (not upstream OMO) and stop
starting new OLW roles before restoring an inspected original `.jsonc` backup.
Use the official upstream executable directly during recovery. OLW also invokes
preflight from its own host-preparation path: removing the shell wrapper alone
does not disable that hook. To resume OLW with tracking disabled, roll back that
integration as a reviewed code change first. Existing sessions need not be
terminated. There is currently no single global tracking-disable switch.

## Verification

`bun test tests/proxy` covers extraction, order/reasoning, protected edits,
unavailable routes, actual HTTP payloads, refresh guards, concurrent CLI starts
and interrupted publication. `bun scripts/qa-routing.ts` uses live accounts to
launch a quick-category child and a named explore child through the managed
launcher. Each must read an unseen random file value and deliver a real runtime
completion; the parent merely repeating a requested string is not sufficient.
The live probe cleans up its owned temporary directory after both children finish.
