# miser - Project Instructions

> **Location:** `/home/nacho/miser/CLAUDE.md`. Merges with `/home/nacho/.claude/CLAUDE.md` (global). Loaded automatically when Claude Code is invoked in this directory.

## Project Identity

`miser` is the local failover router, billing observatory, usage budget/enforcement layer, and Anthropic context-management proxy for Claude Code and the TermDeck stack. Working tree on R730: `/home/nacho/miser`. GitHub: `bheath-atx/miser`.

## Fleet Workflow Protocol

The global fleet protocol applies here:

- **R16 - Codex-first routing:** well-specified, mechanical, token-heavy implementation, test, evidence, and sweep work routes to Codex first. Claude owns architecture, ambiguity resolution, operator judgment, and Brad-facing synthesis.
- **R17 - 3-pass gate:** do not call a Miser PR merge-ready until the required Codex gates are satisfied: PROPOSAL INVERSION-QA, voice-pass when applicable, and BUILDER-AUDIT INVERSION-QA.
- **R20 - Grok cadence:** Codex handles iterative REVISE/fix rounds; Grok is reserved for one narrow final adversarial BUILDER-AUDIT pass unless Brad explicitly approves more.

Detailed mechanics live in `~/.claude/runbooks/codex-gate.md`; read that runbook before dispatching builders, auditors, or merge-readiness review.

## Claude Usage Guardrails

Miser-ORCH is not a lane watcher. Use Claude for policy judgment, architecture, routing, risk calls, and compact Brad-facing synthesis. Do not use Claude as the repeated poller for Codex lanes, GitHub/CI state, TermDeck panels, Miser health/stats, service logs, or its own context/turn count.

For external verification, use scripts/Codex/artifacts:
- Run probes outside Claude where practical.
- Write raw output to a file under the active sprint directory or `/tmp`.
- Return to Claude only a compact PASS/FAIL summary with file paths.
- If more than two status checks are needed for the same lane, stop polling from Claude and use a zero-LLM watcher artifact.

Run `python3 ~/bin/orch-token-gauge.py --self --warn-only` at session start, before/after handoff, and at real task boundaries only. Do not run it every turn. A low-context Miser enforcement/API-limit response is not a rotation trigger; stop the blocked control-loop behavior, answer explicit Brad-directed non-poll input if possible, or park for external review.

Do not delegate verification sweeps, audit monitoring, repo/PR checks, service-status checks, or repeated status work to Claude `Agent`/subagents. That is still Claude traffic. Use Codex or a non-LLM script/artifact; read only the compact result.

This does not ban bounded Claude builder lanes. Claude builders are allowed for judgment-heavy, ambiguous-design, operator-risk, or Claude-specific reasoning tasks when they run in their own builder cwd/panel, have a task-boundary stop condition, write durable artifacts, and are not used as watchers.

## Local Safety Boundaries

This repository contains code for the running Miser service, but editing files here does not imply permission to touch the live service. Do not restart Miser, edit systemd units, alter runtime environment, or change port `20128` unless Brad explicitly approves that operational action. Docs-only edits must remain docs-only.

Any change that can affect request routing, budgets, enforcement, persistence, or panel recovery needs fresh Codex review and a clear rollback plan before merge-ready.
