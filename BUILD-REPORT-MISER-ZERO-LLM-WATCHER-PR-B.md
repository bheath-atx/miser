# BUILD REPORT: MISER-ZERO-LLM-WATCHER PR B

## Summary

Implemented the deterministic watcher artifact writer for PR B.

This change adds a zero-LLM watcher module and sidecar entrypoint that:
- Loads probe registry config from `MISER_WATCH_PROBES`.
- Writes artifacts under `~/.miser/watch` by default.
- Produces JSON artifacts with `generated_at`, `ttl_s`, `status`, `probe_id`, raw path, compact path, exit metadata, duration, and error.
- Produces raw output artifacts and verdict-first compact Markdown artifacts capped at 4KB.
- Uses a per-probe single-flight lock with lease expiry.
- Applies hard command timeouts and writes `timeout` artifacts instead of failing silently.
- Exposes a minimal explicit refresh endpoint at `POST /api/miser/watch/refresh?id=<probe_id>`.

The proxy does not start autonomous watcher loops. Periodic execution is isolated to the `miser-watchd` sidecar when invoked directly.

## Files Changed

- `bin/miser-watchd.js`
- `package.json`
- `src/config.js`
- `src/proxy.js`
- `src/routing.js`
- `src/watchd.js`
- `test/proxy.test.js`
- `test/watchd.test.js`
- `BUILD-REPORT-MISER-ZERO-LLM-WATCHER-PR-B.md`

## Tests Run

- `node --check src/watchd.js`
- `node --check bin/miser-watchd.js`
- `node --check src/config.js`
- `node --check src/routing.js`
- `node --check src/proxy.js`
- `node --check test/watchd.test.js`
- `node --test test/watchd.test.js`
- `node --test test/proxy.test.js`
- `node --test test/routing.test.js test/health.test.js`
- `git diff --check`
- `npm test`

Results:
- Watcher tests: 10 passed
- Proxy tests: 31 passed
- Routing/health tests: 16 passed
- Full suite: 636 passed

## Intentionally Deferred

- Redirect `warn` or `enforce` activation
- Watcher artifact consumption by redirect enforcement
- Spawn-lane or boot-inject retry changes
- CLAUDE.md or runbook documentation
- Ollama/Qwen/Gemma summarization
- Codex fallback
- Anthropic/local LLM calls
- Live TermDeck/session polling outside configured watcher probes

## Compatibility Risks

- Default proxy behavior is unchanged unless the explicit watcher refresh endpoint is called.
- `miser-watchd` executes configured shell commands, so probe registry changes should remain operator-controlled.
- Probe compaction is deterministic head/tail/highlight extraction and may need future tuning for specific artifact shapes.
