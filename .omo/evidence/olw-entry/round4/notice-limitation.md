# Accepted late manager-notice limitation

The orchestrator explicitly accepted R2-E2-LATE as a residual limitation and
forbade patching omo-ai for it. This change documents that decision in the
manager-notices operations section, at the native delivery site, and under
CHANGELOG Unreleased. The earlier absolute idle-only changelog claim is corrected.

Delivery behavior is unchanged: subscribed event-driven idle admission,
synchronous recheck, native auto, one native key and no accepted/uncertain resend.
The code-site change is only a comment. No prompt/prose-pinning test was added.

Documented limitation: a turn that starts in the instant between the idle check
and native acceptance may receive the one-line notice mid-turn; delivery is
still exactly once. No native idle-only primitive or polling was invented.

Combined candidate validation: full-test.log has 592 pass / 0 fail in one run;
typecheck, lint (267 informational diagnostics retained) and build exit 0.
qa-entry.log and qa-manager-entry.json record PASS with isolated official Herdr,
real TUI/shared host/native delivery, deterministic inference and cleanup.
LSP for the delivery comment has no diagnostics. git diff --check is clean.
