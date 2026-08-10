# BUILD REPORT R31

## Scope

Revision round for `/home/nacho/sprints/miser-cohesion-factb/GROK-FINAL.md`.

Fixed the final BLOCKER and NIT:

- AC-19(c): estimated cap percentages now fail closed unless the estimated cap carries a valid range.
- AC-19(c): daily rollup renders estimated percentages only with an explicit estimate marker and a derived percentage range, e.g. `miser-routed estimated 12.5% of cap (range 10.0%-20.0%)`.
- AC-19(c): Prometheus omits `miser_routed_consumed_frac` and `miser_routed_pace_delta` for estimated denominators because that surface cannot render the required range next to the value.
- NIT: provider limit-event alerts now include the concurrent weekly cap state from the recorded observation, including source and range when present.

## Files Changed

- `src/stats.js`
- `src/daily-rollup.js`
- `src/metrics.js`
- `src/router.js`
- `test/factb-consumption.test.js`
- `test/rollup.test.js`
- `test/metrics.test.js`
- `BUILD-REPORT-R31-npm-test.log`
- `BUILD-REPORT-R31-mutation-rollup-estimated-marker.log`
- `BUILD-REPORT-R31-mutation-metrics-estimated-omit.log`

## Verification

Targeted tests:

```text
node --test test/factb-consumption.test.js test/rollup.test.js test/metrics.test.js
tests 43
pass 43
fail 0
duration_ms 270.863361
```

Full suite:

```text
npm test > BUILD-REPORT-R31-npm-test.log 2>&1
tests 570
pass 570
fail 0
duration_ms 1502.236221
```

Full unabridged `npm test` stdout/stderr is captured in `BUILD-REPORT-R31-npm-test.log` (`793` lines).

## Mutation Verification

Rollup estimate-marker mutation:

```text
Mutation: removed the `estimated` marker from the daily rollup estimated percentage line.
Command: node --test test/rollup.test.js > BUILD-REPORT-R31-mutation-rollup-estimated-marker.log 2>&1
Exit: 1
Expected failure observed: rollup test rejected bare `miser-routed 12.5% of cap (range ...)` and required `miser-routed estimated ...`.
Restored: yes
```

Metrics estimated-omit mutation:

```text
Mutation: allowed Prometheus to emit estimated `miser_routed_consumed_frac` and `miser_routed_pace_delta` again.
Command: node --test test/metrics.test.js > BUILD-REPORT-R31-mutation-metrics-estimated-omit.log 2>&1
Exit: 1
Expected failure observed: metrics test rejected `miser_routed_consumed_frac 0.25` for an estimated cap.
Restored: yes
```

Mutation logs are committed as:

- `BUILD-REPORT-R31-mutation-rollup-estimated-marker.log`
- `BUILD-REPORT-R31-mutation-metrics-estimated-omit.log`

## Notes

- No production daemon restart was performed.
- No writes were made to `~/.claude/weekly-caps.json`; tests use redirected temporary cap files.
