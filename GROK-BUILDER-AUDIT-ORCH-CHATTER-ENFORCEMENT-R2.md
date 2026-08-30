I'll re-audit the two R1 blockers against the R2 proposal, code, and claimed tests, using repository inspection only.Authority artifacts are loaded. Next I’ll inspect the R2 proposal audit, then the live enforcement and test code against the two R1 blockers.The R2 source already has explicit-assignment and prompt-only reset helpers. I’ll read those paths and the tests that claim to close the two R1 blockers.Fallback ID extraction is gone in source. Next I’ll inspect reset matching, prompt-vs-tool_result split, and the new tests for leftover holes.R1’s two reset bypasses are gone in the current `src/enforcement.js`, and the new tests would fail if either one had shipped.

## R1 blocker 1 — fallback assignment IDs

Closed.

`extractAssignmentId()` is header-or-marker only: `x-miser-assignment-id` / configured `assignmentIdHeader`, then `valueAfterMarker()` on `MISER_ASSIGNMENT=` / configured `assignmentIdMarker`. There is no `fallbackAssignmentId()`, no `(assignment|task|briefing)` line match, and no briefing fingerprint. Ordinary `Task:` / `Briefing:` / `Build briefing` text cannot create or change `currentAssignmentId`.

`recordRequest()` still resets on a **new explicit** assignment id. That is the approved boundary, not the R1 bypass.

The new test `fallback task and briefing text does not change assignment or reset protected counters` encodes the old bug: after two counted turns on `MISER_ASSIGNMENT=A`, a third `Task:` / `Briefing:` / `Build briefing` turn must 429 `orch-assignment-budget` and leave `currentAssignmentId === 'A'`. If fallback IDs still existed, that turn would mint a new id, reset to 1, and return `null`. The provided 21-pass evidence covers this.

[NIT] That test does not spell `Assignment:` as its own heading. The fallback parser is gone, so that heading cannot mint an id, but the case is only proven by inspection.

[NIT] Assignment identity itself is still a first-`indexOf` substring (`valueAfterMarker`), not a control line. Mid-prompt `MISER_ASSIGNMENT=B` can still change scope. That is the explicit marker, not `Task:` / briefing prose.

## R1 blocker 2 — loose markers over `latestUserText()` / `tool_result`

Closed.

Reset checks in `checkEnforcement()` use `classification.latestUserPromptText`, which keeps `text` blocks and drops `tool_result` bodies. Completion / handoff / approval-marker resets also require `hasControlLineMarker()` (start-of-line) **and** `extractAssignmentId()` on that same prompt, except approval/override **headers**.

That kills both R1 shapes:

- A Read of an audit/`ORCH-RESULT.md` lands in `tool_result` and cannot reset.
- Mid-line prose such as `still waiting on ORCH-RESULT` or `please note TASK-COMPLETE MISER_ASSIGNMENT=A ...` is not a control line.
- Own-line `VERDICT=APPROVE` / `TASK-COMPLETE` / `HANDOFF-WRITTEN` without assignment identity does not reset.

Tests encode this:

- `incidental reset markers in tool results or pasted excerpts do not reset protected counters` — tool_result dump of every default marker, then a paste with those markers as own lines and **no** `MISER_ASSIGNMENT=`. The following management turn still 429s and id stays `A`. If `String.includes(latestUserText())` still reset, that next turn would be 1 and would not block.
- `anchored reset markers require explicit assignment syntax` — mid-line `TASK-COMPLETE MISER_ASSIGNMENT=A` still blocks; own-line `TASK-COMPLETE MISER_ASSIGNMENT=A` resets.

`DISPATCH_FINALIZE` is also prompt-only and line-anchored, still requires explicit assignment id plus child/session marker, sets `dispatchFinalizeUsed`, and does not clear `assignmentManagementTurns`. The one-shot test still asserts turns stay at 2 and a retry 429s.

[NIT] Child/session detection for finalize still uses unanchored `hasTextMarker()` (`CHILD_SESSION=` etc.), not a control line. Finalize still needs the anchored `DISPATCH_FINALIZE` line plus assignment identity, so this is not a reset wipe.

[NIT] Negative finalize cases (missing child id, missing assignment id) are still untested.

[NIT] Mixed latest-user shape `{text, tool_result}` is not in the suite. `promptTextFromContent()` skips `tool_result` blocks, so the code path is closed; only the fixture is missing.

## Other R1 items (not relitigated as blockers)

Hardcoded `project === 'nacho-orch'` / `canaryPollThrottleApplies()` are gone; live gates use `orchControlApplies()`. Fleet coverage is config-only. Non-control work still does not reset protected counters. Warn-at-2 / block-after-3 and revision cycle 3 still match the proposal. Poll-edge copy no longer tells agents that generic work resets the poll counter. Spawn-lane atomic boot remains a documented follow-up; this R2 pass made the Miser one-shot **narrower**, not weaker.

[NIT] `textLooksManagementLike()` is still a broad substring list (`proposal`, `handoff`, `orchestrator`) over full latest-user text, including tool results. That can over-count a configured architect whose job is writing a proposal. It does not wipe the budget.

[NIT] `orchControl.enabled: true` with empty `panels` still protects every panel in that project.

[OPEN QUESTION] Finalize is still evaluated only after the poll-budget branch. A `DISPATCH_FINALIZE` request that compact marks `likely` can 429 `poll-budget` and never consume the one-shot. Compact classification was not in this evidence.

[OPEN QUESTION] This pass did not run `git diff` / `git diff main...HEAD` (read-only, no execution). File inspection of `src/enforcement.js`, `test/enforcement.test.js`, and `test/proxy.test.js` is what closed the two blockers. A git status against `main` and `/home/nacho/miser` would still be needed to prove no live-tree or spawn-lane mutation.

The provided `21 passing` / `611 passing` counts match the 21 tests now in `test/enforcement.test.js`, including the three R2 tests that would go red if either R1 blocker were still present. I did not rerun tests.

VERDICT: APPROVE
