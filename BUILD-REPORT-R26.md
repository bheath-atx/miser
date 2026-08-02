# E3 R26 Build Report

## Fixes

### FAIL 1 - provenance/backfill mutations now reach disk

`reconcileWeeklyFromDaily()` now returns `changed=true` when it mutates either load-time reconciliation path:

- Marking an existing stored weekly bucket without `recorded_event_instant` provenance as `missing_weekly_provenance`.
- Adding a missing weekly bucket rebuilt from legacy daily-only data as `inferred_from_legacy_daily`.

Regression coverage:

- `load reconciliation persists missing-provenance classification without an explicit writer`
- `load reconciliation persists legacy daily backfill without an explicit writer`

Both tests load a legacy file, isolate the startup observation seal so it cannot mask the load-reconciliation flush, wait for the scheduled persistence, reload the module, and assert the classification and counters persisted to disk.

### FAIL 2 - legacy inference is per-week with recorded weeks present

The file-wide `hasRecordedWeekly` early return was removed. Reconciliation now evaluates missing daily-only legacy weeks independently while preserving the R24 guard against post-recorded phantom weeks:

- Existing provenanced weeks are never marked or overwritten.
- Older daily-only legacy weeks can still be backfilled.
- Daily-derived weeks at or after the first provenanced week are skipped, so UTC daily observations after R24 do not fabricate weekly buckets.
- The old "do not resurrect older than surviving legacy weekly data" cap now keys off the oldest non-recorded stored weekly bucket, not a newer post-R24 recorded bucket.

Regression coverage:

- `mixed provenanced weekly and older daily-only legacy data backfills only missing older weeks`

### FAIL 3 - changed-assertion inventory completed

The inventory below includes the R24 assertions from `BUILD-REPORT-R24.md`, adds the R25 audit omission for budget/policy boundary provenance checks, and lists all R26 added/changed assertion coverage.

## Changed-Assertion Inventory

### R24

| File/test | Assertion change | Justification against README contract |
|---|---|---|
| `test/stats-weekly.test.js` / inflated stored weekly | Stored unprovenanced week expects `__meta.reason="missing_weekly_provenance"`, `authoritative:false`, `degraded:true`, while preserving stored counters. | Stored counters without recorded-event provenance are not authoritative. |
| `test/stats-weekly.test.js` / partial daily coverage | Stored weekly bucket no longer has undefined metadata; exposed week is non-authoritative with `missing_weekly_provenance`. | Daily coverage cannot prove weekly authority under R24. |
| `test/stats-weekly.test.js` / mixed stored + daily-only | Stored unprovenanced week expects `missing_weekly_provenance`; missing daily-only week expects `inferred_from_legacy_daily`. | Reconciliation is per-week; absence of provenance is non-authority. |
| `test/stats-weekly.test.js` / degraded persistence | Fixture uses a provenanced week and rollup reason assertion allows `persistence_degraded`. | The test isolates persistence degradation from provenance degradation. |
| `test/stats-weekly.test.js` / first mid-week write | Recorded week expects `recorded_event_instant` metadata. | New weekly buckets must prove event-instant provenance. |
| `test/stats-weekly.test.js` / provenance reload | Added flush/reload/reconcile assertions for recorded metadata and authoritative exposure. | The recorded marker must survive persistence and reconciliation. |
| `test/stats-weekly.test.js` / older records accumulate | Recorded weekly bucket expects provenance metadata. | Existing recorded bucket remains authoritative only because it is provenanced. |
| `test/stats-weekly.test.js` / sparse quiet-day gaps | Stored unprovenanced week expects `missing_weekly_provenance` and non-authority. | Quiet-day coverage does not upgrade unprovenanced weekly data. |
| `test/stats-weekly.test.js` / current unprovenanced stored week | Current week expects `authoritative:false`, `degraded:true`, `missing_weekly_provenance`, and weekly summary non-authoritative. | A current stored bucket also needs recorded-event provenance. |
| `test/stats-weekly.test.js` / surplus stored data | `Object.keys(rawWeek)` includes `__meta`; exposed week is non-authoritative with `missing_weekly_provenance`. | Surplus counters are preserved but not trusted without provenance. |
| `test/stats-weekly.test.js` / stored-only week | Stored-only bucket expects `missing_weekly_provenance` and non-authority. | R20/legacy weekly-only data cannot prove it was event-recorded. |
| `test/stats-weekly.test.js` / budget and policy boundary reload | Added live assertions that `__weekly` contains the event-time week, the week has `recorded_event_instant` metadata, weekly budget count is `2`, and weekly policy counts are `{1,1}`; added reload assertions that daily budget remains `2`, the weekly key remains present, recorded metadata survives, weekly budget count remains `2`, and weekly policy counts survive. | Guardrail writers are stats writers under the README contract; their event-instant weekly buckets must carry recorded provenance through flush/reload and remain authoritative when persistence is durable. |
| `test/proxy.test.js` / weekly rollup | `weeklyAuthoritative:true` -> `false`; count `0` -> `2`; reasons now `["inferred_from_legacy_daily","missing_weekly_provenance"]`; prior week non-authoritative. | Proxy payload must expose the new weekly authority contract without lowering top-level persistence `ok`. |
| `test/stats-async.test.js` / transient write failure | First `flushNow()` expects success, `renameCount=2`, `writeFailures=0`, `dirty=false`. | F5 fixed: final flush retries non-in-flight transient write failures before returning. |
| `test/stats-async.test.js` / writeFailures reset | Retry happens inside `flushNow()`, expecting success and `renameCount=2`. | Same F5 contract. |
| `test/panel-stats-persist.test.js` / unwritable path | Permanent failure `writeFailures` expects `3` not `1`. | Final flush makes three bounded attempts before returning failure. |
| `test/panel-stats-persist.test.js` / transient write failure | One `flushNow()` expects success instead of first failure then second success. | Panel F5 fixed to match stats final-flush behavior. |
| `test/panel-stats-persist.test.js` / chmod failure | Permanent failure `writeFailures` expects `3` not `1`. | Bounded final flush retries permanent failures before returning. |

### R26

| File/test | Assertion change | Justification against README contract |
|---|---|---|
| `test/stats-weekly.test.js` / load reconciliation persists missing-provenance classification | Added persistence predicate for on-disk `missing_weekly_provenance`, reload assertion for `{authoritative:false, reason:"missing_weekly_provenance"}`, and counter-preservation assertion for stored input `17`. | Load-time classification of unprovenanced weekly data is part of the persisted authority contract, not a runtime-only presentation fix. |
| `test/stats-weekly.test.js` / load reconciliation persists legacy daily backfill | Added persistence predicate for on-disk `inferred_from_legacy_daily`, reload assertion for `{authoritative:false, reason:"inferred_from_legacy_daily"}`, and counter assertions for input `10`, output `4`, requests `2`. | Legacy daily-only counters may be preserved for visibility, but must be durably marked non-authoritative. |
| `test/stats-weekly.test.js` / mixed provenanced weekly and older daily-only legacy data | Added assertions that both inferred older week and recorded newer week exist, recorded metadata is unchanged, recorded counter remains `17`, inferred metadata is `inferred_from_legacy_daily`, inferred counters are `31`/`9`, and exposed authority is false for inferred but true for recorded after flush. | R24 provenance remains authoritative for real recorded weeks, while older legacy daily-only weeks are independently backfilled and marked non-authoritative. |
| `test/stats-weekly.test.js` / trend ignores internal weekly buckets | Existing `ok:true` and daily-shape assertions are unchanged; the fixture now flushes the temp-file reconciliation before asserting durable `ok:true`. | R26 correctly schedules load-time persistence for legacy weekly classification; tests that assert durable authority must wait for that persistence. |
| `test/stats-weekly.test.js` / trend ignores malformed daily keys | Existing `ok:true` and malformed-key exclusion assertions are unchanged; the fixture now flushes the temp-file reconciliation before asserting durable `ok:true`. | Same durable-authority requirement after load-time reconciliation. |
| `test/proxy.test.js` / top-level weekly authority rollup | Existing `ok:true`, `authoritative:true`, and weekly non-authority assertions are unchanged; the fixture now flushes the temp-file reconciliation before the proxy request. | Proxy `ok` is still persistence authority; R26 load reconciliation must be durable before asserting `ok:true`. |
| `test/trend.test.js` / proxy trend ok envelope | Existing envelope and project-filter assertions are unchanged; the helper now flushes temp-file reconciliation before calling the route. | Trend endpoint authority mirrors stats persistence authority, so a pending reconciliation write must be drained before asserting durable `ok:true`. |

## Mutation Verification

All mutation checks used temporary `HOME` directories and targeted tests.

| Mutation | Command | Observed result |
|---|---|---|
| Removed `changed=true` from missing-provenance marking. | `tmp_home=$(mktemp -d /tmp/miser-e3-home-XXXXXX); HOME="$tmp_home" node --require ./test/live-file-guard.js --test --test-name-pattern 'load reconciliation persists missing-provenance classification without an explicit writer' test/stats-weekly.test.js` | Failed: `missing-provenance load reconciliation should schedule persistence; last={"__weekly":{"2026-07-19T11:00:00.000Z":{"alpha":{"usage":{"anthropic":{"model":{"input":17,"requests":1}}}}}}}`. |
| Removed `changed=true` after inferred legacy backfill. | `tmp_home=$(mktemp -d /tmp/miser-e3-home-XXXXXX); HOME="$tmp_home" node --require ./test/live-file-guard.js --test --test-name-pattern 'load reconciliation persists legacy daily backfill without an explicit writer' test/stats-weekly.test.js` | Failed: `legacy daily backfill should schedule persistence; last={"__meta":{"recordingStartedAt":"2026-07-20"},"2026-07-20":{"alpha":{"usage":{"anthropic":{"model":{"input":10,"requests":1}}}}},"2026-07-21":{"alpha":{"usage":{"anthropic":{"model":{"output":4,"requests":1}}}}}}`. |
| Restored the old file-wide `if (hasRecordedWeekly) return changed;` shortcut. | `tmp_home=$(mktemp -d /tmp/miser-e3-home-XXXXXX); HOME="$tmp_home" node --require ./test/live-file-guard.js --test --test-name-pattern 'mixed provenanced weekly and older daily-only legacy data backfills only missing older weeks' test/stats-weekly.test.js` | Failed: expected weekly keys `["2026-07-19T11:00:00.000Z","2026-07-26T11:00:00.000Z"]`, actual only `["2026-07-26T11:00:00.000Z"]`. |

## Verification

Targeted weekly file:

```text
ℹ tests 49
ℹ suites 0
ℹ pass 49
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1251.139685
```

Full suite command:

```bash
tmp_home=$(mktemp -d /tmp/miser-e3-home-XXXXXX); HOME="$tmp_home" npm test
```

Verbatim full-suite summary:

```text
ℹ tests 492
ℹ suites 0
ℹ pass 492
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1370.211944
```

`git diff --check` passed with no output.
