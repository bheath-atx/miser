# Build Report: Active Zero-LLM Redirect

## Summary

Implemented active redirect handling for known poll/control command classes in the live proxy request path.

Redirect modes now behave as follows:

- `off`: no redirect behavior; requests pass upstream unchanged.
- `shadow`: records would-synthesize redirect events only; requests pass upstream unchanged.
- `warn`: returns a synthetic text-only warning response for safe redirectable poll/control classes and does not call upstream.
- `enforce`: returns a synthetic text-only response from the watcher compact Markdown artifact and does not call upstream.

The active redirect classes are:

- `POLL_CI`
- `POLL_TERMDECK`
- `POLL_MISER`
- `POLL_HEALTH`
- `SWEEP_REPO`
- `LOOP_SHELL`

`DISPATCH_OK` and `NEUTRAL` are not redirected.

## Implementation Notes

- `src/enforcement.js` now builds active redirect responses after existing enforcement accounting and block checks.
- Redirect responses use the existing `buildSyntheticMessageResponse` helper for normal JSON responses.
- `src/proxy.js` now uses the existing `buildSyntheticSseResponse` helper when a redirected request asked for Anthropic streaming/SSE.
- The proxy threads its existing watcher instance into enforcement so redirect enforcement reads compact watcher artifacts from the configured watch directory, defaulting to `~/.miser/watch`.
- Missing artifacts return a short synthetic no-poll instruction naming the missing artifact path.
- Forced `tool_choice` requests are not redirected, preserving required tool-use semantics.
- Existing poll/ORCH block paths remain in place and continue to short-circuit upstream.

## Tests Run

- `node --test test/proxy.test.js` — pass, 40 tests
- `node --test test/enforcement.test.js` — pass, 33 tests
- `npm test` — pass, 665 tests
- `git diff --check` — pass

## Claude Burn Reduction

When `redirect.mode` is `warn` or `enforce`, the live proxy now returns a zero-usage synthetic Anthropic-compatible response for safe known polling/control turns before `routeRequest()` is called. That means CI/status/health/repo sweep poll turns can be answered from watcher artifacts instead of being forwarded to Anthropic, preventing those turns from consuming Claude context.
