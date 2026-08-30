# FOLLOWUP-SPAWN-LANE-ATOMIC-BOOT

Miser now implements only the request-visible fallback for final dispatch:

- A protected ORCH/architect request carrying `DISPATCH_FINALIZE`
- A visible assignment id, such as `MISER_ASSIGNMENT=<id>` or `x-miser-assignment-id`
- A visible child/session marker, such as `CHILD_SESSION=<id>`, `SESSION_ID=<id>`, `TERMDECK_SESSION=<id>`, or `x-miser-dispatch-session`

That fallback is one-shot per assignment and does not reset assignment budgets.

True spawn-before-inject prevention still requires out-of-repo atomic boot support in spawn-lane/TermDeck:

1. Add or require an atomic boot mode in `/home/nacho/bin/spawn-lane.sh`, for example `--boot-file <path>` or `--boot-text <text>`.
2. The helper must create the panel and inject/submit the boot text in the same shell operation, before returning control to ORCH.
3. The helper must return compact request-visible metadata: child/session id, project, label, cwd, injection status, and artifact path.
4. ORCH callers should use one Miser-visible dispatch request to create the compact briefing and run atomic spawn+boot, not a second LLM turn after spawn to decide how to inject boot text.

No spawn-lane, TermDeck, systemd, or live-service files were modified in this worktree.
