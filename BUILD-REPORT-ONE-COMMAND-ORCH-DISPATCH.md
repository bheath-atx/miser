# Build Report: One-Command ORCH Dispatch

Branch: `one-command-orch-dispatch`

## Summary

Added `orch-dispatch.sh`, an operator wrapper around `make-lane-prompt` and `td-inject.sh`.
It generates a bounded prompt, resolves the intended active ORCH session from TermDeck, and injects
the prompt in one command.

## Changes

- Added `bin/orch-dispatch.sh`.
- Exposed `orch-dispatch.sh` through `package.json`.
- Added `test/orch-dispatch.test.js`.
- Documented one-command usage in `README.md`.

## Verification

- `bash -n bin/orch-dispatch.sh` passed.
- `node --check test/orch-dispatch.test.js` passed.
- `node --test test/orch-dispatch.test.js` passed: 4 tests.
- `node --test test/orch-dispatch.test.js test/lane-prompt.test.js` passed: 9 tests.
- `git diff --check` passed.
- `npm test` passed: 679 tests.
