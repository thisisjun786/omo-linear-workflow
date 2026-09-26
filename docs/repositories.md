# Repository mirrors

A project in a scope snapshot may identify its target Git repository:

```json
{
  "project": { "id": "project-id", "url": "...", "revision": "..." },
  "repository": {
    "remote": "ssh://git@github.com/owner/repository.git",
    "defaultBranch": "main"
  },
  "issues": []
}
```

The optional mapping is canonical snapshot data, so adding or changing it changes the scope
digest and requires approval. Snapshots created before this field was added remain valid and keep
their original digest.

`olw repo fetch --remote URL` creates or updates one bare, fetch-only mirror under
`<root>/.omo/repos`. `olw repo list` reports mirrors already known locally. Both commands accept
`--json`. `olw doctor` includes the same read-only repository status (path, normalized remote,
last successful fetch time, and last error) and never fetches.

OLW invokes Git directly and relies on the user's existing SSH agent or Git credential helper. It
does not copy or store credentials. URLs containing embedded HTTPS credentials or SSH passwords
are rejected. The repository mapping does not yet affect parent creation; parent creation from a
mapped mirror is tracked separately.
