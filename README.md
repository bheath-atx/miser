# miser

> Local token compression + provider routing for Claude Code and the TermDeck stack.

**Owner:** Brad Heath / nacho-money  
**Status:** Specification — implementation in progress  
**Stack role:** 4th service alongside termdeck, mnestra, rumen

---

## What it does

`miser` is a transparent proxy that sits between Claude Code panels and the Anthropic API. It runs entirely on your local server — no third-party providers, no data leaving the machine.

```
Claude Code / orch panel
    │  ANTHROPIC_BASE_URL=http://127.0.0.1:20128
    ▼
┌──────────────────────────────────┐
│              miser               │
│                                  │
│  1. Compression (turn-truncation)│  ← CPU socket-2 only
│     - Threshold: >32K tokens     │
│     - Drops/summarizes old turns │
│     - Target: 30-40% reduction   │
│                                  │
│  2. Provider routing             │
│     Primary:  Anthropic API      │
│     Fallback: CPU Ollama :11435  │
│               qwen2.5-coder:14b  │
│               → qwen2.5:7b       │
│               → qwen2.5:3b       │
│                                  │
│  3. Quota tracking               │
│     - Per-panel token spend      │
│     - Integrates with TermDeck   │
│       FR-5 contextK session meta │
└──────────────────────────────────┘
    │
    ▼
  Anthropic API  /  CPU Ollama :11435
```

---

## Hardware

Built for the R730 dual-Xeon setup with dedicated CPU LLM lane:

| Lane | Endpoint | Use |
|---|---|---|
| GPU Ollama | :11434 | Primary inference — not touched by miser |
| CPU-lane Ollama | :11435 | socket-2 only, NUMA-isolated — miser fallback |
| CPU-lane proxy | :11436 | Admission-control gateway to :11435 |

**All miser work runs on CPU socket-2. Zero GPU impact.**

Models pre-loaded on CPU lane: `qwen2.5:1.5b`, `qwen2.5:3b`, `qwen2.5:7b`, `phi3:mini`, `mistral:7b`, `llama3.1:8b`, `qwen2.5-coder:14b`

---

## Design decisions

| Question | Decision | Reason |
|---|---|---|
| Proxy language | ✓ Node.js (custom) | ~100 lines, no dep sprawl, matches termdeck/mnestra/rumen stack |
| Compression method | ✓ Turn-truncation | Zero deps, instant, handles 80% of use case; LLMLingua is upgrade path if needed |
| Compression threshold | ✓ 32K tokens, configurable per-panel | Global default in config.yaml; `miser_threshold` in session meta overrides |
| Fallback visibility | ✓ Meta-visible, session-silent | `miserModel` written to TermDeck session meta; Claude session uninterrupted |

*All decisions confirmed by Brad 2026-07-05.*

---

## Behaviors

### Layer 1 — Compression

- Fires only when context exceeds threshold (default: 32K tokens)
- Preserves recent turns verbatim; drops/summarizes oldest turns first
- Compression logged per request (tokens before → after)
- No compression on short contexts (overhead not worth it)

### Layer 2 — Provider routing

- Primary: Anthropic Claude API (Sonnet/Opus per panel config)
- On 429 or configured spend threshold: automatic fallback to CPU Ollama
- Fallback priority: `qwen2.5-coder:14b` → `qwen2.5:7b` → `qwen2.5:3b`
- Hard bypass: set `miser_bypass=true` in panel meta to always hit Anthropic directly

### Layer 3 — Quota tracking

- Tracks token spend per TermDeck `project` tag
- Exposes spend via `GET /api/miser/quota`
- Writes to session meta: `miserModel`, `compressedK`, `rawK`
- TermDeck UI overlay: `[miser: Claude Sonnet | 34% compressed | 18K saved]`
- Flashback toast when fallback activates

---

## TermDeck integration

```yaml
# ~/.termdeck/config.yaml
miser:
  enabled: true
  endpoint: http://127.0.0.1:20128
  fallbackModels:
    - qwen2.5-coder:14b
    - qwen2.5:7b
```

TermDeck injects `ANTHROPIC_BASE_URL=http://127.0.0.1:20128` into panel environments when miser is enabled. Panels that opt out keep their direct Anthropic connection.

---

## Implementation phases

- **Phase 1:** Node.js proxy — OpenAI-compatible endpoint, provider routing, systemd user unit, config.yaml wiring
- **Phase 2:** Compression middleware — turn-truncation at threshold, compression logging
- **Phase 3:** Quota tracking + TermDeck UI — session meta fields, dashboard, Flashback toast on fallback
- **Gate:** Codex INVERSION-QA on spec + BUILDER-AUDIT on shipped code

---

## What's out of scope

- Third-party providers (Kiro, iFlow, etc.) — R730-local only
- Cloud deployment — local by design
- Replacing mnestra/rumen — additive service

---

## Context

Inspired by [9Router](https://github.com/decolua/9router) (19.9K stars) which demonstrated demand for token compression + provider failover in Claude Code. miser implements the same concept locally using hardware already on R730 — no external dependencies, no third-party provider risk, session-aware per TermDeck panel context.

*Finished service files will be shared with Josh (jhizzard/termdeck) as reference for potential native TermDeck stack integration.*
