# BUILD REPORT R30

## Scope

Revision round for `/home/nacho/sprints/miser-cohesion-factb/CODEX-BA-R2.md`.

Fixed the R2 BLOCKER and NIT:

- AC-19(c): project-filtered stats now keep project filtering on the current numerator, but derive estimated weekly caps from an unfiltered shared weekly anchor. `/api/miser/stats?project=alpha` no longer produces an alpha-only estimated cap.
- AC-19(b) NIT: the mismatch response intentionally keeps denominator fields in the JSON object as `null` for stable response shape. A source comment now documents that null means unavailable or incommensurable, never zero.

## Files Changed

- `src/stats.js`
- `test/factb-consumption.test.js`
- `BUILD-REPORT-R30-npm-test.log`
- `BUILD-REPORT-R30-mutation-project-filtered-anchor.log`

## Verification

Targeted tests:

```text
node --test test/factb-consumption.test.js
tests 9
pass 9
fail 0
duration_ms 293.366237
```

Full suite:

```text
npm test > BUILD-REPORT-R30-npm-test.log 2>&1
tests 566
pass 566
fail 0
duration_ms 1618.757883
```

Full unabridged `npm test` stdout/stderr is captured in `BUILD-REPORT-R30-npm-test.log` (`789` lines).

## Mutation Verification

Project-filtered anchor mutation:

```text
Mutation: changed capWeekly back to the already-filtered weekly aggregate.
Command: node --test test/factb-consumption.test.js > BUILD-REPORT-R30-mutation-project-filtered-anchor.log 2>&1
Exit: 1
Expected failure observed: project-filtered estimated cap assertion reported weeklyCap actual 800 vs expected 3200.
Restored: yes
```

Mutation log is committed as:

- `BUILD-REPORT-R30-mutation-project-filtered-anchor.log`

## Notes

- No production daemon restart was performed.
- No writes were made to `~/.claude/weekly-caps.json`; tests use redirected temporary cap files.
