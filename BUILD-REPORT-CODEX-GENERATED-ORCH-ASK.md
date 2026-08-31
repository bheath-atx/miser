# Build Report: Codex-Generated ORCH Ask

Branch: `codex-generated-orch-ask`

## Summary

Added `orch-ask.sh`, a low-friction operator wrapper that accepts rough text from argv or stdin,
performs bounded enrichment for PR-shaped requests, uses Codex CLI to normalize it into compact
ORCH dispatch JSON, then calls `orch-dispatch.sh` to generate and inject the bounded prompt into
the intended ORCH.

## Changes

- Added `bin/orch-ask.sh`.
- Exposed `orch-ask.sh` through `package.json`.
- Added `test/orch-ask.test.js`.
- Documented argv/stdin usage in `README.md`.
- Enrichment detects PR numbers in rough text, runs one bounded `gh pr view`, one bounded
  `gh run list`, and a capped local `ORCH-RESULT.md`/`SUMMARY.md` artifact search under the
  project lane root.

## Verification

- `bash -n bin/orch-ask.sh` passed.
- `node --check test/orch-ask.test.js` passed.
- `node --test test/orch-ask.test.js` passed: 5 tests.
- `bash -n bin/orch-ask.sh bin/orch-dispatch.sh` passed.
- `node --check test/orch-ask.test.js test/orch-dispatch.test.js test/lane-prompt.test.js bin/make-lane-prompt.js` passed.
- `node --test test/orch-ask.test.js test/orch-dispatch.test.js test/lane-prompt.test.js` passed: 13 tests.
- `git diff --check` passed.
- `npm test` passed: 683 tests.
