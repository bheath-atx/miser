I'll audit the implementation against the approved proposal, briefing, and source diffs only — no writes, no live probes, no test reruns. First I'll load the authority artifacts and the actual worktree diff.Authority artifacts are loaded. Next I’ll read the Codex audits and inspect the actual enforcement source and diffs.The worktree is uncommitted on `feat/orch-chatter-enforcement`; I’ll inspect the full enforcement diff and tests next.I have the diffs. Next I’ll read the live enforcement path, parser/merge, and the remaining tests for gaps.I’m checking reset-marker matching, assignment-id fallback, and whether anything outside this worktree was touched.The build removes the hardcoded `nacho-orch` live gate and adds policy-driven `orchControl`, but assignment reset is still too eager. Two concrete bypasses ship: fallback assignment IDs from ordinary `Task:` / briefing text, and substring completion/handoff markers in latest user/tool-result text. Either one wipes the new budget.

`HEAD` equals `main` (`ac584ac`); the implementation is the uncommitted worktree diff in `src/enforcement.js`, `test/enforcement.test.js`, and `test/proxy.test.js`. Reported `608 passing` is the full `npm test` glob (`test/*.test.js`), not 608 enforcement tests. `test/enforcement.test.js` has 18 tests, and those tests never exercise the failing reset paths below.

---

### 1. Fleet gate / `nacho-orch`-only hardcoding

Hardcoded `project === 'nacho-orch'` and `canaryPollThrottleApplies()` are gone. Live poll/control/ratio paths now use `orchControlApplies(panel, policy)` (`enabled` + optional `panels`). A test covers `pkachu`, `aetheria`, `miser`, `termdeck-updates`, and `nacho-orch` via config, with no fleet list in source.

[NIT] Default `orchControl.enabled: false` plus removal of the canary means an existing `nacho-orch: { mode: "throttle" }` policy with no `orchControl.enabled: true` silently stops live-blocking. That is the approved shape, but deploy without a matching `MISER_ENFORCEMENT` update and NACHO protection disappears.

---

### 2–3. Assignment-scoped reset vs work-looking bypass

Protected panels no longer call `resetControlLoop()` on non-control text. The dedicated test (`implement the requested code change now`) is correct for that narrow case.

The replacement reset is still not assignment-stable.

[BLOCKER] Fallback assignment IDs reset the budget on ordinary ORCH/architect text, including the first time an id appears. `extractAssignmentId()` falls through to `fallbackAssignmentId()`:

- a line matching `(?:assignment|task|briefing)\s*[:#]\s*<token>`
- or any message starting a line with `build briefing` / `assignment briefing` / `task briefing`, hashed from the first 1000 characters

`recordRequest()` then does `resetAssignment()` whenever `currentAssignmentId` is null and a new id appears, or when the id changes. That ships this behavior:

- `Task: spawn-architect` then `Task: check-status` are two assignments; counters go back to 0.
- Distinct revision briefings titled `Build briefing: ...` get different fingerprints, so `assignmentRevisionCycles` never reaches 3.
- Two management turns with no id, then a Read of a briefing, wipe the already-counted chatter (`!st.currentAssignmentId && opts.assignmentId`).

This is the R2 should-fix: the fallback must not be a disguised arbitrary reset. The tests only use a stable `MISER_ASSIGNMENT=A` and never send `Task:` / unique briefing titles, so 608 passing does not cover it.

Wrong behavior if unfixed: protected ORCH/architect panels can keep mediating and rewriting revise briefings indefinitely by using normal task/briefing headings.

---

### 4. Warn / block tightness

Defaults match the approved budget: warn at 2, block after 3 (`>` `maxManagementTurnsPerAssignment`), plus tighter hour/session caps (6 / 12). The warn-at-2 / pass-at-3 / block-at-4 sequence matches the proposal’s “block on turn 4”.

[NIT] Poll-edge copy still says “send a real non-poll work command to reset the poll counter.” For protected panels that is false: non-control work no longer clears `likelyPollAt`.

---

### 5. Approval / override vs hard-lock

No permanent lock: `assignmentBlocked` is written and never read. After the cap, non-counted real work still passes. Override header/file still fail-opens. Approval marker/header reset the assignment and continue.

That avoids hard-lock. Silent bypass is the marker/fallback resets in findings 2 and 6, not a separate lock bug.

---

### 6. Completion / handoff / artifact markers

[BLOCKER] Reset markers are unanchored `String.includes` on `latestUserText()`, and `latestUserText()` includes tool_result bodies. Defaults include `ORCH-RESULT`, `TASK-COMPLETE`, `VERDICT=APPROVE`, `COMPACT-STATE`, `HANDOFF-WRITTEN`, and `BRAD_APPROVED_CONTINUE`.

Claude Code’s latest user message is often a Read/tool result. Reading the approved proposal, an old `ORCH-RESULT.md`, or any audit containing `VERDICT=APPROVE` fires `isCompletionTurn` / `isHandoffMarkedTurn` / `isApprovalTurn` and `resetAssignment()` wipes `assignmentManagementTurns`. Vague prose such as “still waiting on ORCH-RESULT” does the same.

R2 required tests that incidental `VERDICT=APPROVE` does not reset. Those tests are absent; the reset tests only send a bare `TASK-COMPLETE` / `COMPACT-STATE` user string.

Wrong behavior if unfixed: the common ORCH habit of reading proposal/audit/result artifacts clears the chatter budget.

---

### 7. `DISPATCH_FINALIZE`

One-shot is implemented: requires `DISPATCH_FINALIZE` plus explicit assignment id plus child/session marker; sets `dispatchFinalizeUsed`; does not reset the assignment budget; second attempt blocks. That matches the briefing.

[NIT] Negative cases are untested (missing child id, missing assignment id).

[OPEN QUESTION] Finalize is consulted only in the assignment-budget branch, after poll-budget. A finalize request that compact marks `likely` can 429 on `poll-budget` and never get the one-shot. I did not rerun compact classification, so I cannot prove that is the spawn-before-inject path.

---

### 8. Large context / legitimate work

Raw assistant-turn count and large weighted context do not block a non-management work turn. That test is present and the `assistantFreshOver` path still requires counted control.

[NIT] `textLooksManagementLike()` treats bare substrings `proposal`, `handoff`, and `orchestrator` as management. A configured architect whose real job is writing a proposal is warned at turn 2 and blocked at turn 4 with no polling. That is broader than the proposal’s “proposal/audit mediation” target. The approved 2/3 numeric cap itself is not the defect.

---

### 9. Parser / merge / defaults

There is a parse+merge loop over every `DEFAULT_POLICY.orchControl` key. `enabled: false` is tested. New fields are in `DEFAULT_POLICY`, so `cleanSubobject()` will accept them.

[NIT] No test that a panel omitted from `orchControl.panels` is not gated. No test that a project setting only `panels` without `enabled: true` stays off.

---

### 10. Spawn-before-inject followup

`FOLLOWUP-SPAWN-LANE-ATOMIC-BOOT.md` correctly parks atomic spawn+boot in spawn-lane/TermDeck and describes the Miser-visible one-shot. The briefing allowed that. This runtime build is not required to edit `spawn-lane.sh`.

---

### 11. Out-of-worktree mutation

Worktree `git status` shows only `src/enforcement.js`, `test/enforcement.test.js`, `test/proxy.test.js`, plus untracked briefing/report/followup/audit docs. No spawn-lane, systemd, or live-service files in this tree.

[OPEN QUESTION] This review did not inspect `/home/nacho/miser` (live tree) or `/home/nacho/bin/spawn-lane.sh`. The followup asserts they were not modified; this worktree cannot prove that.

---

### Test evidence

The 608-pass rerun is meaningful as “full suite did not go red.” It is not meaningful as proof of assignment-reset strictness. The new tests lock in the happy path and miss both blockers: fallback ids, incidental markers, and tool_result latest-user shape.

---

VERDICT: REVISE
