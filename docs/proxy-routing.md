# OMO upstream routing through opencodex

OLW can follow the **installed global OMO's category and named-agent policy**
while keeping every generated route on `opencodex`.

The prerequisite is opencodex's OMO client integration
(`ocx integration client enable --client omo`). It keeps the `opencodex` provider
block in `~/.omo/agent/models.json` in step with the models enabled in opencodex.
The synchronizer only reads the model IDs published there. It does not contact
opencodex or any native provider, and it never enables or
authenticates a provider. Model availability belongs to opencodex: enable or
disable a model there, not in OLW.

The synchronizer manages the existing `~/.omo/omo.jsonc`. First-time adoption
replaces stock-name routing fields, including any older manual pins there, so
review its diff first. The main model, model profiles, compaction, retry chains,
vision models and OLW role pins are outside its scope. Generated routes use
`opencodex` only; preserved manual overrides are not rewritten or rejected.

## Automatic behavior

The managed `omo` launcher checks routing before starting upstream OMO.
`omon` uses that launcher too. OLW checks it before ensuring its shared host.
If the OMO version, bundle digest, user configuration and published opencodex
model list are unchanged, nothing is rewritten. Enabling or disabling a model in
opencodex changes that list, so the next start re-plans untouched routes without
`--force`. If the catalog is briefly unreadable, an otherwise unchanged start keeps
the last applied routing.
Without adoption state, a normal checked launch fails and requests explicit
`sync --adopt`; it never silently adopts older manual pins.

On change, the synchronizer reads the actual installed `omo-task.js` with a
TypeScript syntax tree. It does not execute the bundle or infer policy from
release notes. It extracts ordered model choices and reasoning levels, then maps
each choice to an opencodex model ID:

- Each upstream choice names the OMO providers that serve it. The choice maps to
  the opencodex service for one of them. ChatGPT/OpenAI models are published
  without a prefix (`gpt-6-sol`); other services use `anthropic/`, `kimi/`,
  `mimo/` (Xiaomi), `xai/`, `google/` and `opencode-go/`.
- OMO itself requests `kimi-k3` from Kimi Code as `k3`, and the route does the
  same. A trailing `[1m]` in an opencodex ID marks its 1M-context variant and is
  kept.
- `…-fast` is Senpi's priority-tier selector. opencodex publishes the same tier as
  `<model>--fast`. Without that row, the choice is skipped rather than served at
  the standard tier.
- DeepSeek's rolling `deepseek-flash` ID currently identifies V4.1 Flash according
  to [the official model table](https://api-docs.deepseek.com/quick_start/pricing),
  so `deepseek-v4.1-flash` is used. Recheck this if the rolling ID changes.
- If none of the named services publishes the model, the exact same ID from
  another opencodex host is used, with hosts tried in alphabetical order (for
  example `ollama-cloud/deepseek-v4.1-flash`). Another version, a Flash or lite
  sibling, or another model family is never substituted.

Unserved choices are recorded under `skipped`. Repeated provider lanes for the
same model and reasoning level collapse. Reasoning levels are copied unchanged.
opencodex publishes no reasoning controls for some hosted models, such as those on
Ollama Cloud, so a configured level is not guaranteed there.

Native review/QA agents that inherit categories retain that upstream behavior:
their old migration-generated model overrides are removed, rather than freezing
the inherited category list into another model table.

## Ownership and version policy

- The global OMO found outside the managed wrapper and `node_modules` is the
  policy authority. Its version and exact bundle digest are recorded.
- The OLW-pinned OMO package is not upgraded or allowed to write a competing
  global policy. Its task routes use the same user configuration as before.
- OLW role pins in `src/core/policy.ts`, existing binding identities, the main
  model, model profiles, compaction, retry settings, and `models.json` are outside
  this synchronizer's ownership.
- Initial `sync --adopt` adopts stock category/agent routing fields. It backs up
  the configuration first.
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
bun run proxy:routing check --force   # Read-only diff against the current opencodex catalog
bun run proxy:routing sync --force    # Re-plan now instead of at the next start
```

## Optional local model-picker scope (disabled)

The active OMO scope is `all`. Availability is managed in opencodex, and the
commands below remain an optional local feature, not the current policy.
Do not automatically enable `referenced` scope.

```sh
bun run proxy:routing scope referenced  # Narrow managed omo/omon model pickers
bun run proxy:routing scope             # Inspect the mode and referenced IDs
bun run proxy:routing scope all         # Restore ordinary, unrestricted launch scope
```

This does not delete accounts, provider models, or routes. The launcher passes
OMO's native `--models` option using current global categories, agents, profiles,
main model, retry chains, compaction, vision, explicit favorites and OLW role
defaults. Thinking-level history is not a live reference. There are no age-based
guesses and no exception for newly added models.

The list is recalculated after routing preflight on each managed launch, so newly
referenced upstream choices appear automatically, not every newly available
model. A failed reference read blocks the checked launch rather than
silently expanding its scope. An explicit user `--models` takes
precedence; an explicitly selected `--model` remains accessible. Original
`settings.json` and its `enabledModels` value are not rewritten. Existing
sessions and clients that bypass the managed launcher are not changed.

In OMO's own `enabledModels`, write the opencodex pattern as `opencodex/**`.
A single `*` stops at `/`, so `opencodex/*` drops namespaced IDs such as
`opencodex/anthropic/claude-opus-5-5` from the scope, and a saved default among
them is then ignored at startup.

The preference is `~/.omo/proxy-routing/model-scope.json`; every mode change saves
the previous preference under `~/.omo/proxy-routing/backups/model-scope-*.json`.
Those files contain a `mode` value that can be reapplied with the scope command.
Restoration to `all`
works even if routing configuration is temporarily unreadable. Inside `/model`,
Tab switches between `narrowed` and `all` without changing this saved preference.
`--list-models` still shows every callable model; this feature limits the default
picker/cycling scope, not API availability.

## First-time activation

First enable opencodex's OMO integration, then run:

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
`--state-dir` and `--catalog` paths for isolated verification.
`status` accepts `--state-dir`. opencodex refreshes the catalog itself; there is
no background polling service and no running-session restart.
`--version`, `--help` and maintenance commands remain usable without a routing
check. Active sessions may retain their already-loaded policy until restarted.

## Failure and recovery

State, original configuration backups and a recovery journal live in
`~/.omo/proxy-routing/`, with private file permissions.
Configuration and receipt replacement are atomic per file; the journal repairs
an interrupted publication before the next sync. A detected concurrent manual
edit is not overwritten.

An unknown upstream layout, an unusable complete model chain, or a missing or
disabled opencodex catalog during an update leaves the last valid configuration
intact and fails the preflight with an actionable error. It does not enable native
providers or substitute an arbitrary model. Fix the reported problem and run
`sync --force`.
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

`bun test tests/proxy` covers extraction, order/reasoning, opencodex service
mapping, protected edits, unavailable routes, catalog changes, concurrent CLI
starts and interrupted publication.
`bun scripts/qa-routing.ts` uses live accounts to launch a quick-category child
and a named explore child through the managed launcher. Both must resolve to
`opencodex`, read an unseen random file value and deliver a real runtime
completion; the parent merely repeating a requested string is not sufficient.
The live probe cleans up its owned temporary directory after both children finish.
