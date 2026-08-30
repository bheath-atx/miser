# Build Briefing: ORCH Chatter Enforcement

## Task

Implement the approved Miser-side runtime enforcement from:

- `/home/nacho/miser/PROPOSAL-ORCH-CHATTER-ENFORCEMENT.md`
- `/home/nacho/miser/CODEX-AUDIT-ORCH-CHATTER-ENFORCEMENT-R2.md`

Worktree: `/home/nacho/miser-orch-chatter-build`

Branch: `feat/orch-chatter-enforcement`

## Scope

Implement Miser runtime code and tests only in this worktree.

Expected files:

- `src/enforcement.js`
- `test/enforcement.test.js`
- `src/config.js` only if parser/config plumbing truly requires it
- docs only if needed to document operator config

Do not edit the live service, systemd units, `/home/nacho/bin/spawn-lane.sh`, TermDeck code, or any file outside this worktree. If the approved design requires spawn-lane/TermDeck atomic boot support, write a follow-up artifact in this worktree named `FOLLOWUP-SPAWN-LANE-ATOMIC-BOOT.md` with the exact out-of-repo requirement.

## Must Implement

1. Replace NACHO-only live enforcement:
   - Remove hardcoded live-block applicability to only `project === 'nacho-orch'`.
   - Make ORCH/architect enforcement policy-driven through `MISER_ENFORCEMENT`.
   - Coverage must be config/role/panel driven for `pkachu`, `aetheria`, `miser`, `termdeck-updates`, and `nacho-orch`; do not hardcode that fleet list in source logic.

2. Assignment-scoped reset semantics:
   - Protected ORCH/architect counters must not reset on arbitrary non-control text.
   - Reset only on new assignment id, explicit Brad approval/override marker, durable completion marker, handoff/rotation marker, or existing override mechanism.
   - Keep ordinary non-control work from being blocked solely because context is large.

3. Strict protected-panel budgets:
   - Warn at 2 management/control turns per assignment.
   - Block after 3 management/control turns per assignment unless approved/reset by an explicit marker.
   - Preserve bounded terminal handoff and inbound Brad reply allowances, but do not let generic panel lifecycle churn qualify as terminal handoff.

4. Architect/revision cap:
   - Max two automatic proposal/revision cycles per assignment.
   - Block revision cycle 3 unless Brad approved continuation.
   - Use request-visible markers/config; do not pretend Miser can infer hidden intent.

5. Dispatch escape:
   - Implement only the Miser-visible one-shot fallback if feasible: a marked final dispatch request such as `DISPATCH_FINALIZE` with assignment id and child/session marker can pass once after warning/block edge and must not reset the assignment budget.
   - If true spawn-before-inject prevention requires spawn-lane/TermDeck atomic boot support, document that in `FOLLOWUP-SPAWN-LANE-ATOMIC-BOOT.md`.

## Required Tests

Add focused tests for:

- Non-`nacho-orch` configured project blocks repeated likely control polling.
- All five named projects can be covered by config without source hardcoding.
- `orchControl.enabled: false` does not block.
- Protected counters do not reset on arbitrary non-control work-looking text.
- Protected counters reset only on new assignment id, approval marker/header, durable completion marker, handoff marker, or override.
- Assignment management warns at 2 and blocks after 3.
- Generic `panel_lifecycle` without explicit handoff marker does not qualify as terminal handoff.
- Bounded inbound Brad reply behavior is explicit.
- `repo_status`/`audit_monitor` can count against control budget without `pollClass: likely`.
- Management-like unclassified text counts when enabled.
- One marked `DISPATCH_FINALIZE` with assignment id and child/session markers is allowed once and does not reset budget.
- Architect/proposal revision cycle 3 blocks without approval.
- Parser/merge tests cover every new `orchControl` field.
- Raw assistant-turn count and large context alone still do not block real work.

## Verification

Run the relevant Miser test suite. At minimum:

```bash
npm test -- test/enforcement.test.js
```

If the repo uses a different test command, inspect `package.json` and use the local convention.

## Stop Condition

When complete:

1. Leave source changes in the worktree only.
2. Write `BUILD-REPORT-ORCH-CHATTER-ENFORCEMENT.md` in the worktree with:
   - files changed,
   - tests run,
   - any follow-up required for spawn-lane/TermDeck atomic boot,
   - whether this is ready for Codex builder audit.
3. Stop. Do not open PR, restart Miser, merge, or deploy.
