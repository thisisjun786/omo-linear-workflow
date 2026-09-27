# PR #10 comment 3: retained owned workspace

RED: workspace-red.log shows that a move loses the owned workspace identity.
GREEN: workspace-green.log; moving an owned manager to a user pane persists
ownedWorkspaceId under the same token-fenced update, alongside the new pane's
workspaceOwned=false. close removes the original exact ID after checking its
cwd and preserves the user's current workspace. Cleanup is deliberately at
close, so failed/interrupted moves retain an inspectable ownership record.

The field is optional for backward compatibility; existing owned bindings
acquire it when first moved. No workspace name guessing or user-workspace
adoption was added. The additive real-SQLite test creates, moves, closes and
asserts the original workspace is gone while the user workspace remains.

Final combined candidate: 604 tests pass, zero failures; typecheck/lint/build
exit 0 and isolated official entry QA PASS, with cleanup receipts. Source and
changed tests have clean LSP diagnostics. No user server was accessed.
