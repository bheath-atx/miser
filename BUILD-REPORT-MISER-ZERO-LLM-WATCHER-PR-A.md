# BUILD REPORT: MISER-ZERO-LLM-WATCHER PR A

## Summary

Implemented deterministic zero-LLM redirect classification and shadow-mode decision plumbing for Miser Messages requests.

PR A adds:
- Command classification for `POLL_CI`, `POLL_TERMDECK`, `POLL_MISER`, `POLL_HEALTH`, `SWEEP_REPO`, `LOOP_SHELL`, `SELF_WORK`, `DISPATCH_OK`, and `NEUTRAL`.
- Conversation fingerprinting based on stable request features: system prompt head and first user message.
- `redirect.mode` policy parsing for `off`, `shadow`, `warn`, and `enforce`, with default `off`.
- Shadow-mode redirect decision records containing `would_synthesize`, command class, role, fingerprint, mode, and terminal shape.
- Synthetic Anthropic Messages response helpers for non-streaming JSON and streaming SSE, text-only, `[MISER-SYNTHETIC]` prefixed, zero usage, no `tool_use`, and model echo.
- Sparse persisted stats aggregation for redirect shadow events.

Shadow mode does not suppress upstream calls and does not alter client response behavior.

## Files Changed

- `src/enforcement.js`
- `src/stats.js`
- `test/enforcement.test.js`
- `test/proxy.test.js`
- `test/stats.test.js`
- `BUILD-REPORT-MISER-ZERO-LLM-WATCHER-PR-A.md`

## Tests Run

- `node --check src/enforcement.js`
- `node --check src/stats.js`
- `node --test test/enforcement.test.js`
- `node --test test/proxy.test.js`
- `node --test test/stats.test.js`
- `npm test`

Results:
- Targeted enforcement tests: 28 passed
- Targeted proxy tests: 30 passed
- Targeted stats tests: 25 passed
- Full suite: 620 passed

## Intentionally Deferred To PR B/C/D/E

- Watcher sidecar / `miser-watchd`
- Watcher artifact format, artifact reads, freshness checks, and refresh endpoint
- Spawn-lane / boot-inject retry changes
- CLAUDE.md and runbook documentation
- Ollama/Qwen/Gemma summarization
- Codex fallback
- Live TermDeck probes
- Live session polling
- Warn/enforce redirect response activation

## Compatibility Risks

- Low runtime risk in default configuration because `redirect.mode` defaults to `off`.
- Low runtime risk in `shadow` because upstream calls and client responses remain pass-through.
- Classifier regexes may need calibration against real fleet traffic before enabling future `warn` or `enforce` modes.
- Role detection is deterministic and conservative, but future PRs should keep unknown roles lenient before live enforcement.

## Merge-Clean Update

- Conflict files: `src/enforcement.js`
- Resolution: preserved PR A redirect shadow metadata and synthetic helpers while keeping main's ORCH self-work budget, duplicate debounce, and new-conversation reset fields.
- Tests run: `npm test`
- Test result: 625 passed
- Final commit SHA: recorded in the merge-resolution commit pushed after this update.
