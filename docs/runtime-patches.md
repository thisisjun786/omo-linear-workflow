# Maintained runtime repairs

OLW pins OMO `5.0.0` and Senpi `2026.9.26`. The runtime repairs below are
carried by pnpm's `patchedDependencies` entry in `package.json`, with the
generated integrity in `pnpm-lock.yaml`. They do not modify the global OMO
installation, reset authentication, erase user caches, or restart a running host.

The Senpi patch is `patches/@code-yeongyu__senpi@2026.9.26.patch`. The
persistent-monitor timeout repair is fixed upstream in 2026.9.26. The earlier
MCP/OAuth and gaxios exact-optional declaration corrections remain patched.
The declaration-only `patches/senpi-mcp-optional-types.patch` remains a
superseded, unselected artifact.

## Ownership and behavior

These defects belong to Senpi's native tooling, not OLW's Linear authorization or
role hierarchy. The maintained patch changes the raw runtime modules, the shipped
CLI/host and worker bundles, and their shared settings chunk where needed.
Modifying only the raw JavaScript would leave bundled execution unchanged.

| Issue | Native source | Repair |
| --- | --- | --- |
| LINA-143 | `core/extensions/builtin/tool-search/service` | Associate the catalog with the existing provider scope through a weak map. An installer's async continuation cannot serve as session ownership: sibling callbacks otherwise lose the catalog or borrow another session's service. |
| LINA-143 | `core/agent-session`, `_bindExtensionCore` | Give each extension runner its own lazy-activator array. Reload must not retain callbacks whose extension generation has been invalidated. |
| LINA-146 | `core/extensions/builtin/terminal/monitor-registry` | Partly fixed upstream in Senpi 2026.9.26: persistent watches no longer use the ordinary five-minute live timeout, but upstream also omits the timer for their recorded `expiresAt`. The retained raw and bundled hunk restores only durability expiry; ephemeral timeout, cancellation and native file events remain separate. |
| Optional declarations | MCP `client/auth.d.ts`, gaxios `gaxios.d.ts` | Still needed in Senpi 2026.9.26: under exact optional types, `clientMetadataUrl?: string` does not admit an explicit `undefined`, and gaxios still declares `FetchCompliance.fetch` as `typeof fetch`. Both declaration-only corrections are ported. |

Tool search discovers names and parameter schemas; it deliberately does not
activate them. A permitted first by-name invocation performs lazy activation.
This patch does not activate all MCP tools or bypass the registered tool's
activation policy. Existing role guidance and approved Linear scope still apply.

## Reproduce and check

```sh
pnpm install --frozen-lockfile
bun test tests/runtime
bun scripts/qa-monitor.ts
bun scripts/qa-linear.ts discovery
bun scripts/qa-linear.ts discovery-reload
bun scripts/qa-linear.ts discovery-host
bun scripts/qa-linear.ts discovery-host-reload
```

The MCP QA uses a local HTTP MCP fixture and the pinned executable. The shared
host scenario verifies discovery by name, description and source; real first-use
calls; reload; and a second session's first MCP call through the actual eval
kernel. It checks native command disposition so `/mcp status` cannot silently
become a primary model prompt. Eval success comes from its structured tool-call
receipt, not an echoed input. Each run removes its agent directory, private
caches, server and RPC process.

The monitor regressions invoke the real file-monitor implementation with a
virtual clock, actual filesystem create/modify events, cancellation and restored
registry state. `qa-monitor.ts` additionally closes and restarts the actual pinned
RPC process using the same durable session file. It verifies retained monitor
IDs, no false arrival on an unchanged restart, one notification per create/modify,
and cancellation distinct from arrival or timeout. A local offline provider handles
notification wakes; no user credentials or cloud model are used. Its raw receipts,
manifests and cleanup record are written to
`.omo/evidence/real-use-repairs/lina-146-native/native-run.json`.
No fixed sleep or polling delay determines these results.

These fixture checks are not live Linear OAuth, authorized-write, or OLW
supervisor/parent acceptance evidence. A separate `qa-live-linear.ts` run created
real OLW supervisor/parent fixtures and verified name/description/source search,
first-use invocation through direct native tools and eval, sibling isolation,
authenticated project/document/issue readback, and reload. It reused existing
OAuth. After separate explicit user approval, a managed parent created one
temporary issue, updated it, independently read it back, and canceled it. A
Markdown normalization mismatch in the first QA attempt was recovered using the
confirmed original UUID rather than creating another issue. Target references,
raw receipts and both attempts are under
`.omo/evidence/real-use-repairs/lina-143-live*`. MCP catalog refresh may reset active tools,
so that QA observes activation at the native tool-call hook rather than assuming
all previously invoked tools remain active indefinitely. Shared-host reload also
exposes existing OMO memory recall/kibitzer stale-generation warnings; the logs
retain them rather than treating a successful MCP call as proof those other callbacks work.

For a separately approved live read check, run
`bun scripts/qa-live-linear.ts /absolute/path/to/targets.json`. The JSON contains
`project: {id, identifier, url, revision}`, `document: {id, url, revision}` and
`issue: {id, identifier}` from current authorized reads. IDs are UUIDs; identifiers
are the returned display identifiers. Keep credentials out of this file. The
script validates it before allocating a world and is read-only by default.

Only after explicit permission for one temporary issue's creation, update and
cancellation, pass an approved write-plan JSON as the third CLI argument. It
names the project/team, unique nonce, create arguments, updated description and
canceled-state ID/name/type. The driver discovers and invokes save_issue only
from the managed parent, journals requests and raw receipts, reads changes back,
and cancels the confirmed owned issue. The exclusive nonce journal blocks a
blind second create. An explicit resumeJournal may reference a confirmed create
receipt to finish the same issue, never allocate another. Preserve uncertain
receipts and inspect the existing result before choosing a recovery operation.
Linear expands issue references in Markdown; creation readback compares the
returned stored body, while update verification uses an exact machine payload
without those references. Cleanup verifies UUID, project, team, title and nonce,
not JSON parsing of a Markdown description.

## Host profiles and cache recovery (LINA-141, LINA-144)

These repairs belong to OLW's host preparation, not a global package patch.
Before allocating a role, the CLI validates the actual shared host profile. A
missing required extension or incompatible runtime cache profile produces
`host_profile_mismatch` with an explicit official-handoff recovery action; OLW
does not silently replace the host or reserve a role that cannot start.

CLI and host caches use separate directories under `.omo/cache/<runtime-key>/`.
The runtime key derives from the resolved SDK entry, so different installations
cannot reuse transformed modules containing another installation's absolute
runtime import. An owned negative control reproduced a fresh host importing a
deleted QA root when the cache was deliberately shared. Official handoff to the
isolated cache then recovered the same failed parent, session file, checkout and
model, without replaying initialization or deleting that shared cache.

A frontend may still hold a native session-path lease after handoff. Exit only
the intended frontend normally before reopening that same session in the new
host; do not steal the lease, delete records or force-restart unrelated work.
`/reload` is not a substitute for adopting another host profile. The recovery
checks use owned fixtures and do not restart production or paused AAS sessions.

```sh
bun scripts/qa-host-recovery.ts
bun scripts/qa-cache-recovery.ts
```

Run real role/host QA scripts serially, and do not rebuild/relink dependencies
while those fixtures are active. Their caches and hosts are isolated, but they
still discover the user's existing extension resources. Concurrent startup has
exposed separate stale-generation failures; an uncertain initial delivery is
never retried blindly to hide that failure.

## Explicit runtime error notices (LINA-145)

OLW observes an actual persisted assistant error entry at `turn_end`, claims one
operational notice and preserves the exact binding, model, error and session
entry. A ready linked owner receives native contact; absent or paused routes
remain local. Replay and reload do not deliver another notice. Idle, cancellation
and extension warnings without an attributable assistant error are not failure
reports. Read outcomes with `notices --project ID --json` without a running host.

The SDK event adapter must not await native tool delivery inside `turn_end`:
`executeTool` preflight waits for that same event queue. Delivery starts as a
caught asynchronous task; its controller retains the full awaited claim/receipt
flow. The live regression first exposed this deadlock, then verified an actual
proxy HTTP 400, one manager wake, no duplicate after reload, a local notice after
manager closure, and same-parent read-tool progress after both failures. It did
not substitute the agent's own completion report for an error observation.

## Fixed role models during errors

A real shared-cache failure showed that frontend `--no-model-fallback` did not
prevent the shared host from selecting another model. The patch adds
`ctx.sessionSettings.setModelFallbackForSession(enabled)`: an instance-owned
SettingsManager override, separate from the existing persistent settings setter.
It survives settings reload and never writes the user's settings file or changes
another SettingsManager instance. Raw modules, declarations, `chunk-WM5FVFAP.js`,
`chunk-QGC46CGK.js`, and `session-worker.js` carry the same contract.

OLW applies the override only after finding the exact durable binding in a native
host session. Unbound sessions, internal workflow workers and frontend contexts
are not given this role policy. This does not edit manual proxy registration,
model visibility or fallback chains. A failed request remains on the role's
fixed model and is reported through operational telemetry.

```sh
bun test tests/runtime/session-model-policy.test.ts tests/events.test.ts
bun scripts/qa-delivery-recovery.ts notice
```

The native test checks settings-file equality, a second unaffected instance and
reload. The live notice scenario must additionally verify an actual model error,
unchanged model tuple, receipt and same-parent continuation; passing the native
settings test alone is not that evidence.

## Native delivery provenance (LINA-142)

`patches/omo-ai@5.0.0.patch` repairs OMO's native mailbox contract. OMO 5.0.0
already retains uncertain idempotency state, but its executable factory still
reports the pre-invocation snapshot race as `turn_conflict` and reports generic
post-invocation steer/start exceptions as `turn_conflict`/`internal_error`.
The retained patch makes the rejected snapshot check emit
`turn_conflict_before_delivery` and both post-invocation paths emit
`idempotency_uncertain`, because acceptance may precede a lost acknowledgment.
An old unqualified `turn_conflict` is never upgraded into proof of non-delivery.

The bundle marker retains normal body-integrity validation. Its source digest
identifies the recorded downstream transformation, not an upstream source build.
`patches/omo-ai-native-delivery.provenance.json` records the exact upstream bundle
hash/marker, ordered edits with offsets, and final-newline normalization. The
regression checks both marker digests and reverses every recorded edit to recover
the upstream hash. No checksum check is disabled.

OLW keeps the immutable logical envelope and a transactional `delivery_attempts`
history. Only a proven pre-invocation rejection permits an ordinary message's
same-ID, same-payload successor after current authorization is checked.
Operational notices do not automatically retry on duplicate events. Native keys distinguish attempts;
late finish/uncertain results cannot update another attempt. Actual native error
receipts remain available even when the outcome is uncertain. Existing rows are
not rewritten on open, and readonly legacy stores need no history-table migration.

```sh
bun test tests/runtime/native-delivery.test.ts tests/delivery-attempts.test.ts tests/events.test.ts tests/cli-delivery.test.ts
```

The native contract tests execute the extracted pinned factory with a controlled
host acceptance/ACK boundary. `bun scripts/qa-delivery-recovery.ts` exercises the
actual supervisor-to-parent CLI route, a held read-tool turn, same-ID recovery and
one target delivery. It also captures an actual accepted native receipt before
losing metadata at the SDK tool-result/OLW consumer boundary. That last fault is
not socket-level ACK injection. Atomic files are subscribed before the trigger;
custom extension events were not received by the pinned multi-session observer.
The `report` mode of the same QA checks the reverse parent-to-manager route,
including its front-end replay guard: a proven pre-delivery report rejection
re-enters the same claimed delivery path, but never migrates to a new recipient.
An unlinked original route is denied rather than rerouted.

## Per-hunk status for the pinned releases

| Hunk / behavior | Status in OMO 5.0.0 / Senpi 2026.9.26 | Upstream evidence |
| --- | --- | --- |
| Tool-search catalog ownership by provider scope | Ported; still needed in raw service, CLI/host chunk and worker bundle. | Senpi still constructs `scopedService = new AsyncLocalStorage()` and calls `enterWith`, so sibling callbacks can lose or borrow the installer's continuation. |
| Per-runner lazy activator generation | Ported; still needed in raw agent session, CLI/host chunk and worker bundle. | Senpi still registers into the long-lived `this._lazyToolActivators`; `_bindExtensionCore` does not reset it on runner replacement. |
| Session-only model fallback | Ported; still needed in raw modules, declarations, CLI/host chunks and worker bundle. | Senpi exposes only persistent `setModelFallbackEnabled`, whose implementation updates global settings and saves them; no `setModelFallbackForSession` is shipped. |
| Persistent file-watch live timeout and durability expiry | Partly upstream; reduced hunk ported. | Senpi derives `persistent`, stores `deadlineMs: null`, and avoids the ordinary timeout, matching its 2026.9.26 changelog. It also leaves `deadline: undefined` when `expiresAt` exists, so the retained hunk schedules only the recorded durability expiry and reports it as timeout. |
| MCP OAuth optional `clientMetadataUrl` declaration | Ported; still needed. | The 2026.9.26 package still declares `clientMetadataUrl?: string`; the patch retains `string | undefined` for explicit undefined under exact optional types. |
| gaxios fetch declaration | Ported; still needed. | The 2026.9.26 package still declares `FetchCompliance.fetch: typeof fetch`; the patch retains its parameter/return projection to avoid the incompatible generic overload. |
| Native pre-invocation conflict provenance | Ported; still needed in the OMO executable bundle. | OMO 5.0.0 still emits `turn_conflict` at the snapshot mismatch and omits `turn_conflict_before_delivery` from its receipt-code set. |
| Native post-invocation uncertainty | Ported; still needed in the OMO executable bundle. | OMO 5.0.0 retains uncertain idempotency rows, but the steer catch and start catch still emit `turn_conflict` and `internal_error`; the patch preserves the acceptance-boundary distinction. |

## Updating the dependency

Use `pnpm patch` and `pnpm patch-commit`, followed by a fresh `pnpm install` to
resolve the manifest and regenerate the lockfile. Do not hand-edit installed
packages or the lockfile. Check all executable copies against the raw source
change, then run the commands above and OLW's normal validation gates.

When adopting an upstream release that includes these fixes, remove only the
superseded hunks and repeat the same failure/reload/activation/lifetime cases.
A version change or a passing typecheck alone does not establish compatibility.
Coordinate an explicit host handoff separately: replacing dependency files does
not replace code already loaded into a running process.
