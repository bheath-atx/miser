# BUILD REPORT R18

## Changed

- Updated `weeklyKeysSinceRecordingStart()` in `src/stats.js` so it enumerates the retained weekly display window backward from the current subscription week, stopping at `recordingStartedAt` or after current plus `WEEKLY_MAX_WEEKS` retained weeks.
- Added `previousSubscriptionWeekKey()` to step subscription weeks backward using the same week-key derivation path.
- Added a regression in `test/stats-weekly.test.js` with `recordingStartedAt` more than `WEEKLY_MAX_WEEKS + 2` weeks before the simulated current week. It asserts a retained completed week past the old cap is exposed and marked non-authoritative, and that the current missing week is also non-authoritative.

## Option Chosen

I kept a bound, but changed it to the retained output window rather than the full recording-start span. The loop now covers only weeks that `getStats()` can expose: the current week plus up to `WEEKLY_MAX_WEEKS` prior completed weeks. Exhausting the bound means older weeks are outside retention and not displayed; it no longer means retained/current weeks can be silently skipped and reported authoritative.

`makeWeek()` still only skips coverage for missing non-container weeks outside the observation window. The source fix makes the observation window include every retained week since `recordingStartedAt`, so displayed missing retained/current weeks are covered by `coverageMetadataForWeek()` and surface as `authoritative: false` with `nonAuthoritativeReason: "missing_daily_observation"`.

## Mutation Verification

Temporarily restored the old forward walk with `guard < WEEKLY_MAX_WEEKS + 2` and ran:

```text
node --test test/stats-weekly.test.js
```

The new regression failed as intended:

```text
✖ retained weeks after the recording-start cap are exposed non-authoritative
AssertionError [ERR_ASSERTION]: missing retained week after the old iteration cap should be exposed
```

After restoring the fix, `node --test test/stats-weekly.test.js` passed:

```text
ℹ tests 38
ℹ suites 0
ℹ pass 38
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

## Full Suite

Ran the required full suite myself:

```text
npm test
```

Verbatim observed summary:

```text
ℹ tests 480
ℹ suites 0
ℹ pass 480
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1689.504575
```

`~/.miser-panel-stats.json` was confirmed absent after the run.
