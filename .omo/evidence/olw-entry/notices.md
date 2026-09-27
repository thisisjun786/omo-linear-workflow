# Idle manager notices evidence

RED: notices-red.log: 0 pass / 3 fail. Neither report nor question entered idle
admission, and manager idle rejection was not recorded before delivery.
GREEN: notices-green.log: 3 pass / 0 fail using the real SQLite worker. Covers
report/question waiting, envelope preservation, retrievable payloads, accepted
replay, proven pre-delivery rejection successor and uncertain no-resend.
The question fixture initially used an invalid logical ID; it was corrected to
the existing question:<binding>:<id> protocol rather than loosening validation.

Only manager-addressed reports/questions join answer's event-driven bounded idle
admission. Native follow_up prevents steering if a user races admission with a new
turn. Child and parent delivery remain auto. A compact first-line notice precedes
the original immutable envelope. Reports now includes manager-addressed reports,
not just the posted inbox, preserving states and receipts.

Real surface: qa-manager-entry.json PASS. A deterministic offline provider holds
the manager's real turn on a file-event gate. A parent report becomes sending in
SQLite while the manager is streaming, remains absent from its transcript, then
arrives after release and idle as:
[OLW] A report: completed QA-1 - details: olw reports --project A
The native message includes the complete JSON envelope. This replaces only model
inference; OLW, SQLite, TUI, shared host, native thread_send and Herdr are real.

QA iteration failures are retained in qa-entry-hold-rpc-failure.json and
qa-entry-provider-scope-failure.json. The final gate path is passed explicitly to
the isolated extension because host environment filtering removes arbitrary QA
variables. No production transport change was needed to repair this fixture.

Final verification: full-test.log 581 pass / 0 fail; typecheck, lint, build,
release:check, entry QA and existing manager-reattach QA exit 0. Cleanup receipts
are included in both final QA JSON files. All evidence is also copied to
/home/jun/code/omo-linear-workflow/.omo/evidence/olw-entry/.
