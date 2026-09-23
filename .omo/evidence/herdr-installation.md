# Installed Herdr 0.9.1 OMO patch

- Installed path: `/home/jun/.local/bin/herdr`
- Version: `herdr 0.9.1`
- Source checkout: `/home/jun/code/herdr-omo-0.9.1`, upstream tag `v0.9.1`
  plus the local OMO patch and two current-runtime fixes.
- Installed SHA-256:
  `e259912d271a2c014fcc6ae7f9845409feeb0204191735b2a982952ba6eec88f`
- Original binary backup:
  `/home/jun/backups/herdr-0.9.1-stock-20260923T034357Z/herdr`
- Backup SHA-256:
  `2a02fed16beb651ef006e1d43f048f652ca4dc58ad053cd2d44450563d5c54b7`

The lead verified the candidate's exact hash, backed up the stock binary,
staged the candidate beside the installed path, then atomically renamed it.
Bun's shell rejected the initial `mv -T`; the staged file and original hash were
checked before completing the rename with `/usr/bin/mv -T`.

After installation, `/proc/3634359/exe` still had the original stock hash and
PID 3634359 was still the default server. `herdr session list` returned only
that running default server. No QA worlds or staging binary remained.

The current default server intentionally continues using its old executable.
The new OMO detection becomes active when the user later restarts that server.
No user pane, workspace, branch, integration file or configuration was replaced.
The old `/home/jun/code/herdr-omo` tracked patch was compared before and after
and was unchanged. The new checkout retains its local source changes without
an upstream push.

QA and compiler evidence: [port report](herdr-0.9.1-port.md),
[real detection QA](herdr-detection-qa.md).
