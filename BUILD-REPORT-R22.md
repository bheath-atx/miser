# BUILD REPORT R22

## Option

Took Option B.

Reason: F2 was caused by reconstructing `__weekly` from lossy daily keys. This change restores daily keys to UTC and makes event-recorded weekly buckets authoritative. Reconcile now only backfills legacy daily-only files and marks those inferred buckets non-authoritative.

## Source Changes

- `src/stats.js`
  - Restored daily keys to UTC via `date.toISOString().slice(0, 10)`.
  - `recordAnthropicUsage()`, `recordBudgetBlock()`, and `recordPolicyEvent()` now all use UTC daily keys and event-instant subscription week keys.
  - `reconcileWeeklyFromDaily()` returns immediately when a valid recorded weekly bucket already exists, so it cannot overwrite recorded weekly data.
  - Legacy daily-only backfill is marked with `__meta: { authoritative: false, reason: "inferred_from_legacy_daily" }`.
  - `getStats()` no longer applies daily-coverage degradation to stored weekly buckets; stored weekly non-authoritative metadata is still honored.

## F2 Closure Evidence

- Usage writer:
  - `usage before Sunday reset keeps the same subscription week after flush and reload` asserts both `2026-07-26T01:00:00.000Z` CDT and `2026-01-04T07:00:00.000Z` CST write UTC daily keys while preserving the prior subscription week through flush/reload/getStats.

- Budget guardrail writer:
  - `budget and policy events before Sunday reset keep event-time subscription week after reload` asserts `recordBudgetBlock()` writes UTC daily keys and records the event-time subscription week at both CDT and CST pre-reset instants.

- Policy guardrail writer:
  - Same boundary test asserts `recordPolicyEvent()` writes UTC daily keys and records the event-time subscription week at both CDT and CST pre-reset instants.

- Budget-cap enforcement:
  - `budget cap sees boundary usage recorded under the same UTC day key` proves `checkBudget()` sees spend recorded at `2026-07-26T01:00:00.000Z` under `2026-07-26` and blocks at the configured cap.

## Legacy Data

Legacy daily-only data is still readable, but any weekly bucket inferred from daily keys is marked non-authoritative with reason `inferred_from_legacy_daily`. The boundary legacy fixture verifies a UTC daily-only file at `2026-07-26T01:00:00.000Z` is not silently exposed as authoritative weekly data.

Recorded `__weekly` data is preserved as authoritative unless it already carries explicit non-authoritative metadata. This means stored weekly-only buckets are no longer dropped or rewritten from daily keys.

Daily rollup and the out-of-repo dashboard remain correct under Option B because daily keys are UTC again. I did not edit `~/bin/miser-dashboard`.

## Mutation Verification

- Mutated `dayKeyFromDate()` back to subscription-day semantics.
  - Command: `node --require ./test/live-file-guard.js --test --test-name-pattern 'usage before Sunday reset|budget cap sees boundary usage' test/stats-weekly.test.js test/budgets.test.js`
  - Result: failed 2/2 as expected.

- Mutated `reconcileWeeklyFromDaily()` to ignore recorded weekly buckets and rebuild from daily.
  - Command: `node --require ./test/live-file-guard.js --test --test-name-pattern 'usage before Sunday reset|budget and policy events before Sunday reset|weekly reconciliation preserves recorded weekly counters' test/stats-weekly.test.js`
  - Result: failed 3/3 as expected.

- Mutated legacy backfill to omit the non-authoritative marker.
  - Command: `node --require ./test/live-file-guard.js --test --test-name-pattern 'legacy daily-only|legacy UTC daily-only boundary usage' test/stats-weekly.test.js`
  - Result: failed 3/3 as expected.

## Full Suite

Command: `npm test`

Verbatim summary:

```text
ℹ tests 487
ℹ suites 0
ℹ pass 487
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1091.938063
```
