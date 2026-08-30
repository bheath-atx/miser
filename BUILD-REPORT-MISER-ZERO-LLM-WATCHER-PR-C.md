# BUILD REPORT: MISER-ZERO-LLM-WATCHER PR C

## Summary

Implemented bounded spawn/boot-inject retry behavior for PR C.

This change adds repo-owned helper scripts based on the fleet helpers inspected under `/home/nacho/bin`:

- `spawn-lane.sh` creates a TermDeck child session, preserves the existing lane-spawn JSONL ledger behavior, and delegates optional boot delivery to `boot-inject.sh`.
- `boot-inject.sh` caps boot delivery at 2 attempts by default and clamps configured max attempts to 2.
- If `td-inject.sh` reports POST failures, `boot-inject.sh` makes at most 2 attempts.
- If a boot prompt was posted but activity was not confirmed, `boot-inject.sh` refuses duplicate boot injection, writes a failure artifact, and exits nonzero.
- `td-inject.sh` remains the canonical two-stage paste/submit helper and does not add retry loops.
- `--no-inject` and no-boot spawn flows remain supported.

Failure artifacts are written under `${MISER_SPAWN_FAILURE_DIR:-$HOME/.miser/spawn-failures}` with deterministic names:

- `boot-inject-<child-session-id>.md`

Each artifact includes child session id, label, project, cwd, parent id, boot file path, attempts, last error/status, and an exact manual recovery command.

No alert loop was added. The artifact path is printed to stderr on terminal boot-inject failure.

## Revision: Live Helper Sync Safety

Revised the merged PR C helpers after the Grok helper-sync audit at `/home/nacho/sprints/20260830-miser-zero-llm-watcher-arch/ORCH-RESULT.md`.

- Preserved the live helper's slow-start tolerance by keeping one successful boot injection max, then polling for confirmation for the production default window of `20s + 67 * 1.5s`, about 120s total.
- Kept POST failures bounded to at most 2 attempts.
- Removed blind re-inject recovery guidance after a successful post with unconfirmed activity. The artifact now tells the operator to inspect the panel manually and only run the conditional re-inject command if the input is visibly absent or truncated.
- Added deterministic artifacts for spawn POST failure, child-created-but-boot-unconfirmed, and model-brick-after-landed-boot failures.
- Updated `spawn-lane.sh --boot` failure handling so the child id is printed before the nonzero exit and the delegated `boot-inject.sh` artifact path remains visible.
- Added tests for routing defaults, required parent, model validation, boot contract validation, max one successful boot POST, extended confirmation wait, no duplicate injection during slow-start confirmation, spawn POST failure artifacts, recovery text, and model-brick artifacts.
- Did not sync or mutate `/home/nacho/bin`.

## Files Changed

- `bin/spawn-lane.sh`
- `bin/boot-inject.sh`
- `bin/td-inject.sh`
- `package.json`
- `test/spawn-boot-inject.test.js`
- `BUILD-REPORT-MISER-ZERO-LLM-WATCHER-PR-C.md`

## Tests Run

- `bash -n bin/spawn-lane.sh`
- `bash -n bin/boot-inject.sh`
- `bash -n bin/td-inject.sh`
- `node --check test/spawn-boot-inject.test.js`
- `node --test test/spawn-boot-inject.test.js`
- `git diff --check`
- `npm test`

Results:

- Spawn/boot-inject targeted tests: 14 passed
- Full suite: 654 passed

## Intentionally Deferred

- PR D CLAUDE.md/runbook updates
- Miser redirect warn/enforce mode changes
- Watcher artifact consumption by enforcement
- Ollama/Qwen/Gemma summarization
- Codex fallback
- New probes
- Live fleet polling loops

## Compatibility Risks

- The helper scripts are now package-owned under `bin/`; live fleet scripts under `/home/nacho/bin` were inspected but not mutated by this PR.
- Boot prompts that post successfully but never produce a `thinking` status now fail closed instead of being injected repeatedly. Manual recovery is documented in the failure artifact.
- The default boot confirmation behavior still waits before attempting delivery in production; tests override wait/poll durations with environment variables.

Final pushed commit SHA is reported in the PR handoff.
