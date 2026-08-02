# E3 R20 Build Report

Branch: `sprint/miser-e3`

## Pre-fix Reproductions

F1 reproduced before source edits with isolated `/tmp` stats files and clock `2026-07-28T15:00:00.000Z`.

```text
invalid-meta-prior-quiet {"weeklyAuthoritative":true,"currentWeekToDateAuthoritative":true,"currentWeekStart":"2026-07-26T11:00:00.000Z","currentCoverage":null,"totals":{"inputTokensRemoved":0,"estRemovedTokens":0,"cacheBillingDelta":0,"appliedCount":0,"toolsRemovedCount":0,"anthropicEstCostUSD":0}}
empty-state {"weeklyAuthoritative":true,"currentWeekToDateAuthoritative":true,"currentWeekStart":"2026-07-26T11:00:00.000Z","currentCoverage":null,"totals":{"inputTokensRemoved":0,"estRemovedTokens":0,"cacheBillingDelta":0,"appliedCount":0,"toolsRemovedCount":0,"anthropicEstCostUSD":0}}
null-recording-start {"weeklyAuthoritative":true,"currentWeekToDateAuthoritative":true,"currentWeekStart":"2026-07-26T11:00:00.000Z","currentCoverage":null,"totals":{"inputTokensRemoved":0,"estRemovedTokens":0,"cacheBillingDelta":0,"appliedCount":0,"toolsRemovedCount":0,"anthropicEstCostUSD":0}}
```

F2 reproduced before source edits with an isolated `/tmp` stats file.

```json
{
  "event": "2026-07-26T01:00:00.000Z",
  "utcDayKey": "2026-07-26",
  "correctChicagoWeekForInstant": "2026-07-19T11:00:00.000Z",
  "reconcileWeekForUtcDayNoon": "2026-07-26T11:00:00.000Z",
  "flushOk": true,
  "persistedWeeks": [
    "2026-07-26T11:00:00.000Z",
    "2026-08-02T11:00:00.000Z"
  ],
  "persistedUsageByWeek": {
    "2026-07-26T11:00:00.000Z": {
      "requests": 1,
      "input": 10,
      "output": 2
    },
    "2026-08-02T11:00:00.000Z": null
  }
}
```

## Changes

F1: `getStats()` now evaluates coverage for the current week even when no weekly bucket exists and `observationWeekKeys` is empty. The general rule applied: a week exposed by the response must not become authoritative just because coverage was skipped. Existing non-coverage degradation metadata, such as migration failure, still takes precedence.

F2: daily keys now use a subscription-day boundary aligned with the weekly reset: America/Chicago local 06:00, with the existing Sunday 12:00 UTC fallback when timezone data is unavailable. This makes a pre-reset Sunday event persist under the prior subscription day, so live weekly buckets, flush/reconcile, and reload all keep usage in the same subscription week. `cutoffKeyForDays()` now subtracts days in daily-key space so one-day windows do not drift backward through UTC midnight.

Tests added:

- `getStats()` response-level coverage assertions for empty state, `recordingStartedAt: null`, and `recordingStartedAt: "not-a-day"`.
- Boundary round-trip assertions for `2026-07-26T01:00:00.000Z` (CDT) and `2026-01-04T07:00:00.000Z` (CST), checking live bucket, flush output, reload/reconcile, and `getStats()`.

## Mutation Verification

F1 mutation: removed current-week coverage evaluation from `makeWeek()`.

```text
x getStats marks current week non-authoritative for empty state
x getStats marks current week non-authoritative for recordingStartedAt null
x getStats marks current week non-authoritative for recordingStartedAt invalid
actual: true
expected: false
```

F2 mutation: restored raw UTC daily keys.

```text
x usage before Sunday reset keeps the same subscription week after flush and reload
TypeError [Error]: Cannot read properties of undefined (reading 'alpha')
```

After restoring both fixes:

```text
ok usage before Sunday reset keeps the same subscription week after flush and reload
ok getStats marks current week non-authoritative for empty state
ok getStats marks current week non-authoritative for recordingStartedAt null
ok getStats marks current week non-authoritative for recordingStartedAt invalid
tests 4
suites 0
pass 4
fail 0
cancelled 0
skipped 0
todo 0
```

## Full Suite

Final observed `npm test` summary:

```text
ℹ tests 484
ℹ suites 0
ℹ pass 484
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2243.679026
```

Note: the first full-suite run found one daily cutoff regression in `Sprint B 2.3`; `cutoffKeyForDays()` was fixed to operate in subscription daily-key space, and the final suite above passed.

## State Safety

Confirmed after the test run:

```text
/home/nacho/.miser-panel-stats.json absent
```
