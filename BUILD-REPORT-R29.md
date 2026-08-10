# BUILD REPORT R29

## Scope

Revision round for `/home/nacho/sprints/miser-cohesion-factb/CODEX-BA-R1.md`.

Fixed all three BLOCKERs and the NIT:

- AC-11: `claude-sonnet-5` now uses the documented introductory rate through `2026-08-31`: `$2 input / $2.50 cache write 5m / $4 cache write 1h / $0.20 cache read / $10 output` per million tokens. The source comment names the `2026-09-01` rollover so the static table cannot silently age.
- AC-19(c): estimated caps no longer trust `calibration.cap_est`. The reader accepts `anchor_week_start` and `observed_fraction`; stats derives `cap_est = anchor-week weighted routed numerator / observed_fraction` from miser's own recorded weekly history.
- AC-19(c): estimated caps now fail closed with `anchor-week-unrecorded` or `anchor-week-not-authoritative`, carry derived range values, mark `cap-is-estimated`, retain `mix drift: not evaluated`, and surface `STALE ESTIMATE (...)` when the anchor exceeds the configured staleness window.
- AC-19(b): unit/method mismatch keeps the numerator but suppresses denominator fields (`weeklyCap`, `capUnit`, `capMethodId`, `capRange`) so no mismatched cap value appears in the pace response.
- NIT: replaced the vacuous elapsed-fraction assertion with assertions that `elapsedFrac` is present as an unscoped time fraction while routed fields remain explicitly routed.

## Files Changed

- `src/pricing.js`
- `src/weekly-caps.js`
- `src/stats.js`
- `test/pricing.test.js`
- `test/factb-consumption.test.js`
- `BUILD-REPORT-R29-npm-test.log`
- `BUILD-REPORT-R29-mutation-pricing.log`
- `BUILD-REPORT-R29-mutation-estimated-cap.log`

## Verification

Targeted tests:

```text
node --test test/pricing.test.js test/factb-consumption.test.js
tests 13
pass 13
fail 0
duration_ms 223.714669
```

Full suite:

```text
npm test > BUILD-REPORT-R29-npm-test.log 2>&1
tests 565
pass 565
fail 0
duration_ms 1557.719549
```

Full unabridged `npm test` stdout/stderr is captured in `BUILD-REPORT-R29-npm-test.log` (`787` lines).

## Mutation Verification

Pricing mutation:

```text
Mutation: changed claude-sonnet-5 inputPerMTok from 2 to 3.
Command: node --test test/pricing.test.js > BUILD-REPORT-R29-mutation-pricing.log 2>&1
Exit: 1
Expected failure observed: pricing table assertion reported inputPerMTok actual 3 vs expected 2.
Restored: yes
```

Estimated-cap mutation:

```text
Mutation: changed estimated cap derivation from anchorNumerator / observedFraction to anchorNumerator * observedFraction.
Command: node --test test/factb-consumption.test.js > BUILD-REPORT-R29-mutation-estimated-cap.log 2>&1
Exit: 1
Expected failure observed: estimated cap assertion reported weeklyCap actual 50 vs expected 800.
Restored: yes
```

Mutation logs are committed as:

- `BUILD-REPORT-R29-mutation-pricing.log`
- `BUILD-REPORT-R29-mutation-estimated-cap.log`

## Notes

- No production daemon restart was performed.
- No writes were made to `~/.claude/weekly-caps.json`; tests use redirected temporary cap files.
