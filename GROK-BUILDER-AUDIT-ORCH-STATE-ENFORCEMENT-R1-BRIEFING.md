# Grok Builder Audit R1: ORCH State Enforcement Follow-up

You are an independent adversarial Grok BUILDER-AUDIT reviewer. This is a focused audit of the Miser runtime follow-up build in:

`/home/nacho/miser-orch-state-build`

Read-only only. Do not write files, edit files, contact TermDeck, query live sessions, send messages, write Mnestra, or mutate anything. Use repository inspection only. Do not run tests; test outputs below are evidence to audit.

## Background

PR #20, merged as `c86bf6e`, added bounded ORCH management enforcement. It correctly addressed the earlier ORCH/architect chatter problem, but live testing exposed false-positive bricking:

1. Fresh replacement ORCH panels could inherit stale counters because runtime state is keyed by `project--panel`.
2. One visible Claude Code prompt can produce multiple backend requests, and the old counting path could count those duplicates as separate management/poll turns.
3. `pollClass=likely` was treated as sufficient for `poll-budget` warning/block, so boot/resume/audit-result traffic could brick even without an explicit polling command.
4. Broad management keyword matching was still allowed to combine with likely polling classification and first/second-prompt block an ORCH panel.
5. Aetheria ORCH then demonstrated the other side of the failure: it spent hundreds of Claude-side responses doing CI/log/repo/file/plugin work itself, while builder lanes consumed little Claude-side traffic.

The immediate live mitigation was a 12-hour fleet override for `nacho-orch`, `termdeck-updates`, `pkachu`, `aetheria`, `miser`, `provenspec`, and `nacho-money`, expiring around `2026-08-31T01:38Z`.

## Source Artifacts

- Prior merged enforcement commit: `c86bf6e` on `origin/main`
- Current worktree: `/home/nacho/miser-orch-state-build`
- Build report: `/home/nacho/miser-orch-state-build/BUILD-REPORT-ORCH-STATE-ENFORCEMENT.md`
- Actual source diff: run `git diff` and `git diff main...HEAD` from `/home/nacho/miser-orch-state-build`

## Claims To Verify

- Fresh replacement protected panels no longer inherit stale warning/block counters when conversation shape resets.
- Duplicate backend requests for one visible management prompt count once inside the configured debounce window.
- `pollClass=likely` alone cannot cause `poll-budget` warning/block on protected ORCH panels.
- Explicit polling/status commands still warn/block under poll budget after repeated counted management requests.
- Audit-result, handoff, boot, and resume prose that may be classified likely by upstream logic does not become a poll-budget block unless it contains an explicit polling/status command.
- Protected ORCH repo/CI/file/plugin self-work warns then blocks after the configured self-work allowance.
- Pure Brad comms and negated instructions do not consume self-work budget.
- Dispatch-only commands do not consume self-work budget unless combined with polling/sleeps/repo/package/session/status work.
- The change does not weaken assignment management caps, revision caps, dispatch finalize constraints, or hard token/weighted caps from PR #20.

## Verification Evidence Already Produced

Commands run from `/home/nacho/miser-orch-state-build`:

```bash
node --check src/enforcement.js
node --require ./test/live-file-guard.js --test test/enforcement.test.js
npm test -- test/enforcement.test.js
```

Results:

- Syntax check: pass
- Targeted enforcement suite: 26 passing, 0 failing
- Full npm test command: 616 passing, 0 failing

## Audit Focus

Look specifically for concrete wrong behavior that would still brick normal new ORCH panels or let real poll loops escape:

- stale state reset too broad or too narrow;
- duplicate debounce bypasses;
- poll command detector false positives, especially negated instructions;
- explicit polling false negatives;
- any reset that accidentally wipes assignment or revision budgets for an ongoing old conversation;
- any persistence/config compatibility problem with the new policy fields.

Type every finding as `[BLOCKER]`, `[NIT]`, or `[OPEN QUESTION]`.

A `[BLOCKER]` must name concrete wrong behavior that ships if unfixed. Use `VERDICT: REVISE` only if at least one blocker exists. Use `VERDICT: APPROVE` if there are no blockers.

End your response with exactly one final verdict line:

`VERDICT: APPROVE`

or

`VERDICT: REVISE`
