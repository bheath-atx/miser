# miser — Josh Handoff Superseded

> Superseded by the v4 README and the `FABLE5-AUDIT-REPORT.md` rationale. The prior Josh handoff described proxy-side context truncation and token-reduction targets that are withdrawn.

This file is retained only so old references resolve. Do not use it as an implementation spec.

Current miser responsibilities:

- Failover routing for Claude Code panels.
- Billing observability from routed Anthropic `usage` responses.
- Strict path-prefix project attribution with `/p/<project>/v1/messages`.
- Default-off Anthropic context-management injection for explicitly configured projects.

Current non-goals:

- No primary-path context truncation.
- No summarization, re-encoding, or output trimming.
- No proxy-side savings claim based on raw token estimates.
- No live service rollout or TermDeck settings edits without Brad approval.

For Mac or TermDeck integration work, start from `README.md` and the current source/tests rather than this historical handoff.
