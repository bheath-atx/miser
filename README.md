# miser

> Local failover router, billing observatory, and opt-in Anthropic context-management injector for Claude Code and the TermDeck stack.

**Owner:** Brad Heath / nacho-money  
**Status:** v4 sprint implementation  
**Stack role:** Local proxy beside termdeck, mnestra, and rumen

---

## What it does

`miser` is a transparent local proxy for Claude Code panels. It keeps the working failover chain, records billed-usage truth for routed Anthropic requests, and can opt selected projects into Anthropic server-side context editing.

```
Claude Code / orch panel
    │  ANTHROPIC_BASE_URL=http://127.0.0.1:20128[/p/<project>]
    ▼
┌──────────────────────────────────────────┐
│                  miser                   │
│                                          │
│  1. Failover router                      │
│     Anthropic 429 → Codex/OpenAI OAuth   │
│     Codex unavailable → CPU Ollama       │
│                                          │
│  2. Billing observatory                  │
│     Anthropic usage → day/project/       │
│     provider/model usage stats           │
│                                          │
│  3. Context-management injector          │
│     Default off; per-project opt-in      │
│     delegates reduction to Anthropic     │
└──────────────────────────────────────────┘
```

The old goal of saving billed tokens through proxy-side byte mutation is withdrawn. The audit rationale is in `FABLE5-AUDIT-REPORT.md`: Claude Code already self-caches, so rewriting cached prefixes can be neutral or harmful. In v4, dedup is skipped whenever Anthropic-format requests carry client `cache_control`; `MISER_DEDUP_FORCE=1` exists only as a test/emergency override.

---

## Routes

| Route | Purpose |
|---|---|
| `POST /v1/messages` | Anthropic Messages API proxy, attributed to `x-termdeck-project` or `default` |
| `POST /p/<project>/v1/messages` | Anthropic Messages API proxy with strict path-prefix project attribution |
| `POST /v1/chat/completions` | OpenAI-format passthrough with Ollama fallback on 429 |
| `GET /api/miser/health` | Health/config surface |
| `GET /api/miser/quota` | Legacy request-count quota view |
| `GET /api/miser/stats?days=N&project=X` | Optimizer legacy counters plus sparse measured usage tree and Anthropic estimated dollars |
| `GET /api/miser/stats/trend?days=N&project=X` | Sparse daily measured-usage trend entries, capped at 90 days |

Project path names must match `[A-Za-z0-9._-]{1,80}` after one URL-decode pass. Invalid `/p/...` shapes return 404 and are not forwarded.

---

## Observability

Anthropic 2xx responses are tee-parsed without buffering SSE streams. Stats include:

- Legacy optimizer buckets for backwards compatibility.
- Sparse `usage` buckets keyed by day, project, provider, and model.
- Weighted token equivalents computed at read time.
- `anthropicEstCostUSD`, computed at read time from Anthropic-leg measured tokens only.
- `context_management.applied_edits` aggregates per project.
- A warning if 5-minute cache writes appear, because this fleet is expected to use 1-hour cache TTL.
- Daily pkachu rollups can post one UTC-midnight line per project when configured.

Missing usage means “not measured”; v4 does not zero-fill absent usage nodes.

`GET /api/miser/health` returns process vitals:

- `ok`
- `uptimeSecs`
- `reqPerMin`
- `perLegErrors`
- `c1DisabledProjects`
- `statsFlushLagMs`
- `pendingWrites`

---

## Context Management

Server-side context editing is default off. Enable it per project with:

```bash
MISER_CONTEXT_EDIT_PROJECTS='{"pkachu":true}'
```

Optional flat knobs are validated and mapped to Anthropic’s `context_management.edits` shape:

```bash
MISER_CONTEXT_EDIT_PROJECTS='{"pkachu":{"trigger":70000,"keep":7,"clearAtLeast":30000,"excludeTools":["Read"]}}'
```

Malformed config, unknown keys, invalid project names, and out-of-bounds values fail closed with a startup warning. Client-supplied `context_management` is never overridden.

---

## Failover

Anthropic 429 keeps the existing failover path:

1. Anthropic Messages API
2. Codex/OpenAI through subscription OAuth
3. Local Ollama hard-capped fallback

For C1-injected requests, non-429 upstream errors pass through unchanged and do not write measured usage stats. Three consecutive injected 400s disable context-management for that project for the process lifetime.

---

## Local Operation

```bash
npm test
npm start
```

Zero npm runtime dependencies; Node built-ins only.

Relevant env vars:

| Env var | Purpose |
|---|---|
| `MISER_PORT` | Listener port, default `20128` |
| `MISER_ANTHROPIC_URL` | Anthropic upstream base URL |
| `MISER_OLLAMA_URL` | Ollama fallback endpoint |
| `MISER_FALLBACK_MODELS` | Ordered Ollama fallback models |
| `MISER_CONTEXT_EDIT_PROJECTS` | Per-project C1 opt-in map |
| `MISER_STATS_FILE` | Stats file path, default `~/.miser-stats.json` |
| `MISER_DEDUP_FORCE` | Test/emergency override for the cache-safety dedup gate |
| `MISER_PRICING_JSON` | JSON map of model pricing overrides merged over the built-in Anthropic table |
| `MISER_PKACHU_TOKEN` | File path containing the bearer token for daily rollup posts |
| `MISER_PKACHU_ENDPOINT` | HTTP(S) endpoint for daily rollup JSON posts |

---

## Non-Goals

No truncation, summarization, TOON/schema re-encoding, output trimming, or proxy-side compaction. Proxy-side mutation is limited to safe normalization, guarded lossless dedup for non-caching clients, optional legacy cache hint, tool pruning when explicitly configured, and C1 context-management injection for opted-in projects.
