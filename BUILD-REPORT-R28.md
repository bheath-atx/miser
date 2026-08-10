# Fact B R28 Build Report

## Changes

Implemented the Fact B consumption/pricing bundle in one build round:

- Added docs-sourced `claude-opus-5`, `claude-sonnet-5`, and `claude-fable-5` pricing rows. Opus 5 is now sourced from docs, not an `ASSUMED = opus-4-8` override. Sonnet 5 uses the standard 2026-09-01+ docs rate in the static table so the entry does not silently stale after the introductory 2026-08-31 cutoff.
- Added the single weekly-cap reader, `src/weekly-caps.js`, for `~/.claude/weekly-caps.json` via `MISER_WEEKLY_CAPS_FILE` in tests. It derives `capSource`, ignores inert `cap_source`, ignores `_` documentation keys and `thresholds`, refuses unit/method mismatch, and never writes or persists a derived cap.
- Added response-path unpriced-model observation counting and provider limit-event recording in `stats.js`/`router.js`.
- Added `pace`/`coverageNote`/`paceAlerting: "none"` output on stats, routed-scope Prometheus gauges, and the standing rollup deferral line.
- Rewrote daily rollup rows to sort by weighted token consumption. USD remains parenthetical annotation only.
- Added explicit fleet-scope alerts:
  - `sendAlert(text, { scope: 'fleet', kind: 'limit-event' })`
  - `sendAlert(text, { scope: 'fleet', kind: 'unpriced-models' })`
- Extended the live-file guard for `MISER_WEEKLY_CAPS_FILE`; tests isolate it to a temp path.

Phase 4 builder `ANTHROPIC_BASE_URL` rollout: no builder spawn templates exist in this repo beyond README guidance, so no code target was touched. This remains a lifecycle/runbook rollout item.

## Phase-0 V4

Best-effort log capture found many live miser journal entries like:

```text
[miser] Anthropic 429 — trying Codex/OpenAI (subscription OAuth)
```

These confirm status `429` events occurred, but the current live logging does not retain provider response body, headers, or provider error type. The new hook records status, parsed `error.type` when present, and raw body going forward. No live service calls, restarts, or systemd actions were performed.

## AC Status

| AC | Status | Evidence |
|---|---|---|
| AC-11 | Met | `test/pricing.test.js` asserts all three 5-series docs rows and fallback behavior. |
| AC-12 | Met | `test/factb-consumption.test.js` asserts response-path unpriced counting/read idempotency; `test/metrics.test.js` asserts `miser_unpriced_requests_7d`; `test/rollup.test.js` asserts the fleet-scoped unpriced alert. |
| AC-19 | Builder portion met | `test/factb-consumption.test.js` covers configured derived cap, inert file label/threshold ignore, unit mismatch refusal, limit-event record+alert, no cap-source/verdict drift. Full degrade matrix is represented by the reader behavior and tests; no `$HOME` cap file is touched. |
| AC-21 | Met | `test/rollup.test.js` covers weighted-token ordering and USD parenthetical annotation. |
| AC-22 | Met | Stats/metrics/rollup use `routed*` consumption fields and scope text; `test/factb-consumption.test.js` asserts no pace verdict strings or threshold reads in `src/`; `test/rollup.test.js` asserts no unscoped `% weekly`. |
| AC-23 | Builder portion met; merge gate remains external | Stats carries `paceAlerting: "none"` and rollup prints the standing line. Brad's explicit acceptance in `STATUS.md` is not present in this worktree and was not faked; NACHO-ORCH owns that gate. |

## Mutation Verification

Temporarily changed `claude-fable-5.inputPerMTok` from `10` to `9`, then ran:

```bash
node --require ./test/live-file-guard.js --test test/pricing.test.js
```

Observed expected failure:

```text
✖ Anthropic pricing table pins sonnet, opus, haiku, opus-5, sonnet-5, and fable-5 all five axes
AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
+   inputPerMTok: 9,
-   inputPerMTok: 10,
```

Restored the correct docs value and reran the full suite.

## Verification

Full suite command:

```bash
npm test
```

Verbatim summary:

```text
ℹ tests 561
ℹ suites 0
ℹ pass 561
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1520.132744
```

The final guarded `npm test` passed, so the live-file guard observed no live `~/.miser-*` mutation during that run. Earlier guarded focused runs did fail only because the separately running live miser process on `127.0.0.1:20128` updated `~/.miser-stats.json` during the snapshot window; no live restart or systemd action was taken.
