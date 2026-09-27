# PR #10 comment 4: reports view

RED: reports-red.log reproduces manager sending records leaking into default CLI
inbox results. GREEN: reports-green.log and targeted-green.log. Default reports
now selects only posted, null-recipient user records. Explicit --all adds
manager-addressed reports in all states while retaining their receipt/state.
Notice detail commands and manager guidance use reports --all; both READMEs,
operations and roles reference document the distinction. The prior manager
payload assertion now opts into the explicit view; coverage was not removed.

Final combined candidate: full-test.log 604 pass / 0 fail (single run), typecheck,
lint, build exit 0. qa-manager-entry.json PASS with complete isolated cleanup.
Changed source/test LSP diagnostics clean. No push or GitHub comment posting.
