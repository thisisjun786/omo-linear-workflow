# Pinned OMO routing through opencodex

OLW maps the installed global OMO category and named-agent policy onto models published by opencodex. The default policy is **pinned**: the current user routing is the accepted routing and upstream OMO or catalog changes never rewrite it automatically.

The prerequisite is opencodex's OMO integration (`ocx integration client enable --client omo`). It owns `providers.opencodex` in `~/.omo/agent/models.json`. OLW reads that catalog; it never contacts providers, enables models, or authenticates accounts.

## Policy and ownership

Routing state is stored under `~/.omo/proxy-routing/state.json`. New and migrated installs use `routingPolicy: pinned`. Existing receipts migrate on first run without changing `~/.omo/omo.jsonc`. The former automatic behavior remains available explicitly with `--follow`; follow mode updates non-overridden managed routes as before.

OLW owns only category and named-agent routing fields (`model`, `models`, reasoning fields and fallback models). Prompts, tools, disable flags, main/session models, profiles, retry and compaction settings, vision settings, and OLW role pins remain outside routing synchronization. Manual route edits are still recorded as overrides.

Initial adoption is explicit and backed up:

```sh
bun run proxy:routing check --force
bun run proxy:routing sync --adopt
bun run proxy:routing baseline save
```

A baseline is private mode `0600` at `~/.omo/proxy-routing/baselines/<date>-user-baseline.json`. It records the current routing fields, per-route accepted upstream values, upstream version/digest/path, and the accepted effective opencodex catalog snapshot. Advice compares against the latest baseline, falling back to the last receipt on older installs. An older baseline without a catalog snapshot is never modified by a check; status reports that `proxy:routing baseline save` is needed and uses the receipt's last effective catalog when available.

## Advice instead of automatic changes

In pinned mode, every sync computes the route table OMO would choose but keeps the accepted configuration unchanged. State records pending route advice with:

- route path;
- previously accepted upstream choice;
- new upstream choice;
- current user value;
- `unavailable` when a currently selected catalog model disappeared;
- alternatives from the same route's surviving rungs.

A disappeared model is never silently replaced. The interactive `omo` launcher prints a short advice block and continues with pinned routing. `olw manage` returns `routingAdvice`, and the manager brief contains exactly one `routing_advice:` line. `proxy:routing status` and `olw update check --json` include route-level details. With no finding, status reports `upstream routing unchanged since baseline <date> (omo-ai <version>)`; an ordinary launcher remains quiet.

Review and accept only intended changes:

```sh
bun run proxy:routing status
bun run proxy:routing check --force       # read-only current upstream comparison
bun run proxy:routing apply categories.deep-low agents.explore
bun run proxy:routing apply --all
bun run proxy:routing dismiss categories.deep-low
bun run proxy:routing sync --follow       # optional automatic tracking
```

`apply` is the only normal pinned-mode routing writer besides initial adoption and explicit force. It writes a backup, uses the recovery journal and lock, and advances per-route accepted upstream values for only the selected paths. `dismiss` and `baseline save` use the same routing lock. Dismissal lasts until that route's upstream candidate changes; changing only the current user value does not revive it. A fully dismissed upstream change is not described as unchanged. `check`, `status`, and `olw update check` perform a fresh read-only comparison and do not write routing, baseline, receipt, or catalog files.

## Catalog health review

The routing baseline also snapshots metadata for the accepted opencodex catalog. For models referenced by a route or OLW's role policy, OLW advises when a model:

- disappears (including a possible rename/alias requiring review);
- has a smaller context window or output limit;
- exposes the known `32000` output-limit stand-in;
- loses image input;
- flips its reasoning flag.

Findings name affected routes and OLW roles and suggest review actions: disable the route rung, choose another rung, or add a reviewed `MODEL_CATALOG` override in `src/proxy/model-catalog.ts`. Metadata is evaluated per model: an ID-only row still participates in presence/removal checks, skips only its own capability comparison, and contributes to one `catalog metadata unavailable for N models` limitation finding. Health review never edits the catalog, route, or override table.

## Mapping and safety

The synchronizer parses the installed `omo-task.js`; it does not execute the bundle or infer policy from release notes. Ordered upstream choices and reasoning levels map to exact opencodex IDs. OpenAI IDs are bare; other services use their opencodex namespace. Fast-tier, Kimi, rolling DeepSeek, xAI/Cursor secondary-lane, and exact-host fallback rules live in `src/proxy/routing-plan.ts`. Another model family or version is never substituted.

Configuration and receipt replacement are atomic. A process-wide `flock`, original backups, and `pending.json` recovery journal protect publication. Concurrent manual changes stop publication. An unreadable or unfamiliar upstream policy leaves accepted routing intact. Once routing is adopted, the interactive launcher may continue after a failed preflight using retained all-opencodex routing; before adoption and for OLW role launches, preflight failure remains closed.

## Chain warnings and model scope

`bun run proxy:routing chains` and `olw doctor` report no-working-model, no-fallback, and missing OLW-role-model warnings. Advice is separate: warnings describe current operability, while advice compares accepted routing/catalog policy with current upstream inputs.

The optional model-picker scope remains disabled by default:

```sh
bun run proxy:routing scope referenced
bun run proxy:routing scope
bun run proxy:routing scope all
```

It changes picker visibility only and does not alter accounts, providers, routes, or advice.

## Paths and isolated verification

`check` and `sync` accept `--upstream`, `--config`, `--state-dir`, and `--catalog` for fixture-only verification. `status` accepts `--state-dir`. Upstream discovery excludes the managed wrapper directory and repository `node_modules` entries.

Tests use temporary directories only:

```sh
bun test tests/proxy
bun run typecheck
bun run lint
```
