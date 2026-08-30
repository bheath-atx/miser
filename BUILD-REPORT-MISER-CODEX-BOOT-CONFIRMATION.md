# BUILD REPORT: MISER CODEX BOOT CONFIRMATION

## Summary

Implemented focused spawn/boot reliability hardening for Codex builder panels after the PR25 canary failure.

Changes:

- `spawn-lane.sh` now passes the requested command into `boot-inject.sh`, so boot confirmation can distinguish Codex from Claude-style panels.
- `boot-inject.sh` keeps the existing one-successful-POST maximum by default.
- Codex boot injection now sends a single-line sidecar prompt telling Codex to read the supplied boot file, avoiding the known multiline bracketed-paste failure mode.
- Codex boot confirmation no longer depends on `status=thinking`, `requestCount`, or `replyCount`; it requires a fresh `~/.codex/sessions/.../rollout-*.jsonl` for the target `cwd` after injection.
- Claude-style confirmation still accepts `meta.status == thinking`.
- Unconfirmed boots still fail closed and write an artifact instead of reinjecting blindly.
- Failure artifacts now include timestamp, base URL, project, label, cwd, command, boot file, child id, observed TermDeck `/sessions` and `/buffer` signals, Codex transcript path when found, panel lookup instructions, and an exact conditional `td-inject.sh` command with the real child id.
- Spawn POST failure artifacts now include timestamp, base URL, and command.

## Tests Run

- `bash -n bin/spawn-lane.sh bin/boot-inject.sh bin/td-inject.sh` - passed
- `node --test test/spawn-boot-inject.test.js` - 16 passed
- `npm test` - 656 passed
- `git diff --check` - passed

## Failure Mode Addressed

The PR25 canary posted boot text once, then failed because the helper only recognized a Claude-style activity signal. For `command=codex`, this change treats a fresh Codex rollout transcript for the child `cwd` as the success signal. If no transcript appears, the helper refuses duplicate injection and writes a diagnostic artifact with the exact one-shot manual reinject command to run only after visually confirming the panel is empty.
