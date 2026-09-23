# Linear through OMO's native MCP

Linear owns accepted scope and decisions. These skills read Linear through the MCP servers
OMO already has configured, then hand a validated snapshot to the orchestrator CLI. There's no
second Linear client, no bundled OAuth flow and no fixed tool schema copied into this repo.

## Discover, authenticate, then read

1. Run `/mcp` to see the configured servers and their state. `/mcp status` prints the same
   summary as text. A Linear server that shows as needing authentication is not usable yet.
2. Authenticate with `/mcp auth <server>`. Authentication is the user's step. It can't be
   done for them, and the current live OAuth is not authorized in this environment; report
   that plainly instead of substituting a fixture and calling it live data.
3. Once connected, the server's tools appear in the ordinary tool list under that server's
   name. Read each tool's description and input schema before calling it. Tool names differ by
   connector version, so this document names none; discover them each time.
4. If the server publishes MCP resources, the native `mcp_list_resources` and
   `mcp_read_resource` tools are registered and can read them. Those two tools exist only when
   at least one connected server lists resources.

Always read the full canonical text: the initiative body, each project's description, every
issue's full acceptance criteria, and the decision documents they link. A list view or search
summary is a locator, not the criteria. Paginate scoped listings before concluding an item is
absent.

## What a read must pin

For every object you rely on, record three things:

- `id`: the canonical stable object ID returned by Linear, not a display title or issue label.
- `url`: the canonical Linear URL.
- `revision`: the exact updated-at timestamp or version the connector returned for the body
  you read.

Titles, folder names and team keys aren't identifiers. Same-name candidates are resolved by ID
and semantic scope; if that fails, ask rather than pick.

## Scope snapshot for the CLI

`olw-plan` turns the pinned reads into a scope snapshot file. The shape is the orchestrator's
`ScopeSnapshot` contract (validated with Zod by `scope import`):

```json
{
  "version": 1,
  "source": "linear-export",
  "initiative": { "id": "...", "url": "https://linear.app/...", "revision": "2026-09-22T00:00:00.000Z" },
  "projects": [
    {
      "project": { "id": "...", "url": "https://linear.app/...", "revision": "..." },
      "issues": [
        { "id": "...", "url": "https://linear.app/...", "revision": "..." }
      ]
    }
  ],
  "decisionRefs": [
    { "id": "...", "url": "https://linear.app/...", "revision": "..." }
  ]
}
```

The importer validates structure, duplicate IDs and the explicit fixture flag.
The skill must establish provenance and approved membership from its Linear reads;
local validation cannot prove that a supplied export really came from Linear.
Prepare the snapshot accordingly:

- `source` is `linear-export` when every ref came from an authenticated Linear read in this
  session, or `fixture` when it was hand-written for QA. Never mix the two in one file, and a
  fixture import needs the explicit `--fixture` flag.
- Every `revision` is the value the connector actually returned. Don't backfill or guess.
- No issue appears under two projects, and no ID repeats.
- Only projects and issues the approved definition covers are included. Leaving something out
  is a scope decision to state, not a formatting choice.

Then import it:

```sh
bun "$OMO_INITIATIVE_ROOT/dist/cli.js" scope import --file ./scope.json --json
```

A successful import returns the snapshot digest. Exit 2 means the snapshot was rejected;
fix the file from a fresh Linear read rather than editing values until it parses. Import
creates no supervisor and no ownership; see
[Definition is not execution approval](roles.md#definition-is-not-execution-approval).

## Writes

Skills write to Linear only when the request covers the write: define/create/update requests
for the named object, or an already accepted broader write. Advice, draft-only, plan-only,
read-only and status requests write nothing. Read the current state before writing, preserve
unrelated content and history, and read the result back by ID afterwards. After an uncertain
write, look up the existing result before retrying. Deletion, archival, closing issues and
messaging other people need authorization that names that action.

QA never mutates real Linear objects or approves OAuth on the user's behalf.
