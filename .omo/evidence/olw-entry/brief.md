# Manager brief evidence

Manager guidance is scoped to handling OLW messages. It explains reading reports
and questions, answering by question ID, reviewing evidence within approval and
escalating decisions beyond approval. Ordinary requests remain normal assistant
work. The redundant role line was removed; scope, ask_user_directly, behavior,
identity fields, update_check and routing_advice remain.

This is prompt/prose guidance; no new prose-pinning test was added. The existing
machine-field regression caught removal of two top-level compatibility fields
(brief-fields-red.log: 580 pass / 1 fail). Restoring those fields produced the
final full-test.log: 581 pass / 0 fail. Both official-host QA scenarios also pass
with this brief. LSP diagnostics and typecheck are clean; lint, build and
release:check exit 0. README English/Korean, operations and role references were
updated together. Guidance does not alter child or parent role contracts.
