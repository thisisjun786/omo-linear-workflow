# Maintained native runtime repairs

OLW pins OMO `5.0.0-0.beta.84` and Senpi `2026.9.22-4`. The runtime repairs
below are carried by pnpm's `patchedDependencies` entry in `package.json`, with
the generated integrity in `pnpm-lock.yaml`. They do not modify the global OMO
installation, reset authentication, erase user caches, or restart a running host.

The active patch is `patches/@code-yeongyu__senpi@2026.9.22-4.patch`. It includes
the earlier optional MCP/OAuth declaration corrections as well as executable
repairs. `patches/senpi-mcp-optional-types.patch` is the superseded declaration-only
artifact; it is no longer selected by the manifest.

## Ownership and behavior

These defects belong to Senpi's native tooling, not OLW's Linear authorization or
role hierarchy. The maintained patch changes the raw runtime modules and both
shipped execution bundles; modifying only the raw JavaScript would leave the
CLI/host bundle behavior unchanged.

| Issue | Native source | Repair |
| --- | --- | --- |
| LINA-143 | `core/extensions/builtin/tool-search/service` | Associate the catalog with the existing provider scope through a weak map. An installer's async continuation cannot serve as session ownership: sibling callbacks otherwise lose the catalog or borrow another session's service. |
| LINA-143 | `core/agent-session`, `_bindExtensionCore` | Give each extension runner its own lazy-activator array. Reload must not retain callbacks whose extension generation has been invalidated. |
| LINA-146 | `core/extensions/builtin/terminal/monitor-registry` | Persistent file watches ignore the ordinary live timeout, while retaining their recorded durability expiry. Ephemeral deadlines, admission bounds, cancellation and native file events remain separate. |

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
supervisor/parent acceptance evidence. Those checks remain distinct in the
real-use repair evidence. Shared-host reload also exposes existing OMO memory
recall/kibitzer stale-generation warnings; the logs retain them
rather than treating a successful MCP call as proof those other callbacks work.

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
