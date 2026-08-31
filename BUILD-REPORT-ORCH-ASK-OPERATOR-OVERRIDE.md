VERDICT: ready
branch: fix/orch-dispatch-unique-assignment
summary: Brad-originated orch-ask/orch-dispatch prompts now get unique ORCH assignment ids and carry the explicit BRAD_APPROVED_CONTINUE boundary marker so stale ORCH control caps do not block the current operator request.

Root cause:
- The failed Aetheria PR351 re-audit prompt reached the ORCH at 2026-08-31T18:41:36Z.
- Miser blocked it before Claude could act with `ORCH control-loop budget exceeded`.
- The generated assignment id was deterministic for the task, so repeated operator dispatches reused an assignment whose one-shot DISPATCH_FINALIZE allowance had already been consumed.
- A second live repro with a unique assignment still blocked because `consumeExplicitOperatorBoundary()` rejected all poll-looking prompts before checking explicit boundary markers. The generated dispatch prompt contained negated poll-control language and CI status facts, so it looked poll-like even though it was an operator dispatch.

Changes:
- `make-lane-prompt` gives ORCH dispatch prompts a timestamped assignment id by default.
- Explicit `--assignment` remains supported for deterministic callers.
- ORCH dispatch prompts include `BRAD_APPROVED_CONTINUE MISER_ASSIGNMENT=...` because TermDeck paste cannot attach Miser override headers to the future Claude request.
- `orch-dispatch` duplicate detection now hashes the stable operator request and facts, not the generated prompt body, so timestamped prompt ids do not defeat duplicate protection.
- `enforcement.js` now honors explicit DISPATCH_FINALIZE/BRAD_APPROVED_CONTINUE/TASK-COMPLETE boundaries before applying the poll-looking text guard.
- Added regression coverage for the stale-control-cap operator dispatch case.

Tests:
- PASS: `node --test test/orch-dispatch.test.js`
- PASS: `node --test test/lane-prompt.test.js`
- PASS: `node --test test/enforcement.test.js --test-name-pattern 'operator-generated|Brad approval|DISPATCH_FINALIZE|control-loop'`
- PASS: `npm test` (693 tests)
- PASS: `bash -n bin/orch-dispatch.sh bin/make-lane-prompt`
- PASS: `node --check bin/make-lane-prompt.js`
- PASS: `git diff --check`
