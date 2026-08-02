# E3 R24 Build Report

## README contract change

`README.md` now states the explicit R24 contract revision: weekly authority is no longer proven by complete UTC daily-key coverage. A weekly total is authoritative only when persistence is healthy/durable and the persisted `__weekly[week].__meta` carries `authoritative:true` plus `provenance:"recorded_event_instant"` from a stats writer.

Rationale: subscription weeks are keyed from event instants. UTC daily buckets remain the rolling-window observation log and a legacy recovery source, but daily coverage cannot prove that a weekly bucket was recorded rather than reconstructed, stale, inflated, or hand-edited.

New documented reasons:

- `missing_weekly_provenance`: stored/exposed weekly data has no event-instant provenance, including legacy/R20-era weekly data.
- `inferred_from_legacy_daily`: weekly data was rebuilt from daily-only legacy data and is preserved for visibility only.

## Provenance mechanism

- Added `WEEKLY_RECORDED_PROVENANCE = "recorded_event_instant"`.
- New weekly buckets created by `recordStats()`, `recordAnthropicUsage()`, `recordBudgetBlock()`, and `recordPolicyEvent()` are marked:

```json
{"__meta":{"authoritative":true,"provenance":"recorded_event_instant"}}
```

- Existing non-authoritative weekly metadata is never upgraded by a later write into the same week. That avoids laundering mixed old/new buckets.
- `getStats()` reports weekly authority only for provenanced weekly buckets, subject to persistence health.
- Provenance is covered through flush -> reload -> reconcile by `recorded weekly provenance survives flush reload and reconcile`.

## Legacy, mixed, and R20-era classification

- Legacy daily-only data: rebuilt per retained week and marked `authoritative:false`, `reason:"inferred_from_legacy_daily"`.
- Mixed legacy files: reconciliation is per-week. Existing stored weeks are preserved and classified, while missing daily-only weeks are backfilled independently.
- R20-era/unprovenanced weekly data: stored counters are preserved but marked `authoritative:false`, `reason:"missing_weekly_provenance"`.
- Post-R24 recorded files: if any valid weekly bucket has recorded-event provenance, daily backfill is skipped for that file so UTC daily keys cannot create phantom subscription weeks.
- Retention: legacy daily inference is bounded by the retained weekly window and by the oldest surviving stored weekly key, so flush cannot resurrect already-pruned weeks.

R20 exposure check: `git branch --contains 9ea6bab --all` returned only `sprint/miser-e3`; `git merge-base --is-ancestor 9ea6bab main` returned exit code `1`, so the R20 commit is not on `main`.

## F5/F6 decision

- F5 fixed in `src/stats.js` and `src/panel-stats.js`: `flushNow()` now retries transient non-in-flight write failures within the existing bounded final-flush limit (`FINAL_FLUSH_MAX_ATTEMPTS` / `FINAL_FLUSH_MAX_MS`). Load-failure refusal still returns immediately to avoid overwriting unreadable persisted data.
- F6 deferred explicitly: import-time sync read/parse and daily pruning are not changed in R24. Fixing them would alter module initialization and retention semantics beyond this provenance contract repair. The README contract still treats daily buckets as the rolling-window observation log, and no daily-pruning contract was added here.

## Changed assertions

| File/test | Assertion change | Justification against README contract |
|---|---|---|
| `test/stats-weekly.test.js` / inflated stored weekly | Stored unprovenanced week now expects `__meta.reason="missing_weekly_provenance"`, `authoritative:false`, `degraded:true`. | Stored counters without recorded-event provenance are not authoritative. |
| `test/stats-weekly.test.js` / partial daily coverage | `__meta` is no longer `undefined`; exposed week is non-authoritative with `missing_weekly_provenance`. | Daily coverage cannot prove authority under R24. |
| `test/stats-weekly.test.js` / mixed stored + daily-only | Added assertions that stored unprovenanced week is `missing_weekly_provenance` and missing daily-only week is `inferred_from_legacy_daily`. | Reconciliation must be per-week and absence of provenance is non-authority. |
| `test/stats-weekly.test.js` / degraded persistence | Seeded a provenanced week and loosened rollup reason assertion to include `persistence_degraded`. | The test now isolates persistence degradation from provenance degradation. |
| `test/stats-weekly.test.js` / first mid-week write | Recorded week now expects `recorded_event_instant` metadata instead of no metadata. | New weekly buckets must prove event-instant provenance. |
| `test/stats-weekly.test.js` / provenance reload | Added flush/reload/reconcile assertions for recorded metadata and authority. | The marker must survive persistence and reconciliation. |
| `test/stats-weekly.test.js` / older records accumulate | Recorded weekly bucket now expects provenance metadata. | Existing recorded bucket remains authoritative only because it is provenanced. |
| `test/stats-weekly.test.js` / sparse quiet-day gaps | Stored unprovenanced week now expects `missing_weekly_provenance` and non-authority. | Quiet-day coverage does not upgrade unprovenanced weekly data. |
| `test/stats-weekly.test.js` / current unprovenanced stored week | Current week now expects `authoritative:false`, `degraded:true`, `missing_weekly_provenance`, and weekly summary non-authoritative. | A current stored bucket also needs provenance. |
| `test/stats-weekly.test.js` / surplus stored data | `Object.keys(rawWeek)` includes `__meta`; exposed week is non-authoritative with `missing_weekly_provenance`. | Surplus counters are preserved but not trusted without provenance. |
| `test/stats-weekly.test.js` / stored-only week | Stored-only bucket now expects `missing_weekly_provenance` and non-authority. | R20/legacy weekly-only data cannot prove it was event-recorded. |
| `test/proxy.test.js` / weekly rollup | `weeklyAuthoritative:true` -> `false`; count `0` -> `2`; reasons now `["inferred_from_legacy_daily","missing_weekly_provenance"]`; prior week non-authoritative. | Proxy payload must expose the new weekly authority contract without lowering top-level persistence `ok`. |
| `test/stats-async.test.js` / transient write failure | First `flushNow()` now expects success, `renameCount=2`, `writeFailures=0`, `dirty=false`. | F5 is fixed: final flush retries non-in-flight transient write failures before returning. |
| `test/stats-async.test.js` / writeFailures reset | Retry now happens inside `flushNow()`, expecting success and `renameCount=2`. | Same F5 contract. |
| `test/panel-stats-persist.test.js` / unwritable path | Permanent failure `writeFailures` now expects `3` not `1`. | Final flush makes three bounded attempts before returning failure. |
| `test/panel-stats-persist.test.js` / transient write failure | One `flushNow()` now expects success instead of first failure then second success. | Panel F5 fixed to match stats final-flush behavior. |
| `test/panel-stats-persist.test.js` / chmod failure | Permanent failure `writeFailures` now expects `3` not `1`. | Bounded final flush retries permanent failures before returning. |

## Mutation verification

All mutation checks used temporary `HOME` directories and targeted tests.

| Mutation | Command | Observed result |
|---|---|---|
| Removed provenance marking from measured weekly writer. | `node --require ./test/live-file-guard.js --test --test-name-pattern 'recorded weekly provenance survives flush reload and reconcile' test/stats-weekly.test.js` | Failed: expected `{authoritative:true, provenance:"recorded_event_instant"}` but got `{authoritative:false, reason:"missing_weekly_provenance"}`. |
| Skipped missing-provenance classification. | `node --require ./test/live-file-guard.js --test --test-name-pattern 'valid stored weekly week with no daily backing is preserved but non-authoritative without provenance' test/stats-weekly.test.js` | Failed: expected non-authoritative `missing_weekly_provenance` metadata but got `undefined`. |
| Restored all-or-nothing reconciliation shortcut. | `node --require ./test/live-file-guard.js --test --test-name-pattern 'mixed stored-weekly and daily-only legacy data reconciles missing weeks per week' test/stats-weekly.test.js` | Failed: inferred week `2026-07-26T11:00:00.000Z` was missing. |
| Restored stats `flushNow()` non-in-flight failure return. | `node --require ./test/live-file-guard.js --test --test-name-pattern 'flushNow retries a transient non-in-flight write failure before returning' test/stats-async.test.js` | Failed: `result.ok` was `false`, expected `true`. |
| Restored panel `flushNow()` non-in-flight failure return. | `node --require ./test/live-file-guard.js --test --test-name-pattern 'panel stats final flush retries a transient non-in-flight write failure before returning' test/panel-stats-persist.test.js` | Failed: `result.ok` was `false`, expected `true`. |
| Removed recorded-week backfill guard. | `node --require ./test/live-file-guard.js --test --test-name-pattern 'usage before Sunday reset keeps the same subscription week after flush and reload' test/stats-weekly.test.js` | Failed: extra phantom week `2026-07-26T11:00:00.000Z` appeared. |

## Full suite

Command:

```bash
tmp_home=$(mktemp -d /tmp/miser-e3-home-XXXXXX); HOME="$tmp_home" npm test
```

I used isolated `HOME` because an initial non-isolated targeted run observed `~/.miser-stats.json` mtime changes from outside the test process, which would violate the no-real-state requirement if allowed to continue. No subsequent verification used real home state.

Verbatim summary:

```text
ℹ tests 489
ℹ suites 0
ℹ pass 489
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1283.106653
```
