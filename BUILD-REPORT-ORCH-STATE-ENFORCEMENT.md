# Build Report: ORCH State Enforcement Follow-up

## Scope

This follow-up fixes live false-positive bricking observed after PR #20 deployed bounded ORCH management enforcement.

Observed live failure modes:

- Fresh replacement ORCH panels inherited stale counters because enforcement state was keyed by `project--panel`, not by conversation/session shape.
- One visible Claude Code prompt could generate duplicate backend requests and spend multiple enforcement counts.
- `pollClass=likely` was enough to trigger poll-budget warning/block for normal ORCH boot/resume/audit-result traffic.
- Broad management keywords combined with the poll heuristic caused first/second-prompt blocks for Aetheria despite an active new panel.
- Aetheria ORCH spent hundreds of Claude-side responses on repo/CI/file/plugin self-work while builders did little actual Claude-side work.

## Code Changes

- Added `orchControl.duplicateDebounceMs` with default `2000`.
- Added `orchControl.newConversationAssistantTurnDrop` with default `4`.
- Added `orchControl.warnSelfWorkTurnsPerAssignment` with default `1`.
- Added `orchControl.maxSelfWorkTurnsPerAssignment` with default `1`.
- Added protected-panel fresh conversation detection:
  - if a prior protected panel had at least the configured assistant-turn depth and the current request drops to `<= 1` assistant turns, clear the protected panel's ORCH counters;
  - also clear on sharp message-count collapse.
- Added duplicate counted-turn fingerprinting so repeated backend requests for the same visible management prompt count once inside the debounce window.
- Added explicit poll-command detection and gated poll-budget enforcement on it:
  - `pollClass=likely` alone no longer warns/blocks;
  - audit-result or handoff text tagged likely by upstream classification is not a poll-budget hit unless it contains explicit polling/status command text;
  - negated instruction lines such as "do not poll" are ignored for poll-command detection.
- Preserved command-loop blocking for explicit polls, health checks, census, `/api/sessions`, `/api/miser`, `watch`, `tail -f`, `gh run`, `gh pr view`, and similar status/poll commands.
- Added ORCH self-work detection for repo/CI/file/plugin work, including `gh run`, `gh pr`, `git status/diff/show/log`, package test/build commands, `Read`/`Write`/`Edit` tool uses, Vercel/Supabase plugin calls, and broad shell inspection commands.
- Pure Brad reply fetches are not counted as self-work.
- Negated instruction lines such as "do not run gh run view" are ignored for self-work detection.
- Dispatch-only commands such as `spawn-lane.sh`, `td-inject.sh`, `spawn-codex-audit.sh`, and `spawn-grok-audit.sh` are not self-work unless mixed with polling, sleeps, repo checks, package commands, or stats/session calls.

## Tests Added Or Updated

- Parser coverage for the four new `orchControl` knobs.
- Explicit polling command canary for configured non-`nacho-orch` projects.
- Fleet config coverage with debounce-aware repeated explicit poll commands.
- Regression that likely audit/result traffic does not poll-budget block without explicit polling command content.
- Regression that duplicate backend requests for one visible prompt count once inside the debounce window.
- Regression that fresh low-turn replacement panels do not inherit stale high-turn protected counters.
- Regression that protected ORCH self-work warns then blocks repo/CI/file/plugin continuations.
- Regression that negated self-work instructions and pure Brad comms do not consume self-work budget.
- Proxy canary updated to use two distinct explicit poll commands so it still verifies warn-before-block behavior without contradicting duplicate replay debounce.

## Verification

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

## Audit Status

Two local Grok audit attempts were started and then stopped because the Grok CLI hung without producing a verdict. This branch is tested but not Grok-approved yet.

## Deployment Note

The fleet override is still active through approximately `2026-08-31T01:38Z`. Do not deploy this branch to live Miser until the adversarial audit has approved it and the PR has merged.
