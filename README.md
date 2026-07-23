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

## Guardrails (Sprint B)

Two opt-in guardrails, both consuming the measured usage layer. Both are OFF by default (`null`-as-OFF: unset or malformed env → feature fully off, zero overhead, one startup warning if the env var was set but invalid). Neither ever mutates a forwarded request body or header.

### G3 — per-project daily USD budget caps (the ONLY blocking feature)

```bash
MISER_BUDGETS='{"pkachu":{"dailyUSD":5},"aetheria":{"dailyUSD":10}}'
MISER_BUDGET_GRACE='["aetheria"]'   # at/over cap: alert only, never block
```

- `dailyUSD` must be a finite number in `[0.01, 10000]` and the only key; invalid project entries are ignored with a warning (fail-open per project — miser never blocks on config it does not fully understand).
- State per project per UTC day: `UNDER → WARNED (≥80%, one pkachu warn alert) → CAPPED (one cap alert, then 429 block until UTC midnight)`. Alerts are deduped once per project per type per day via a persisted ledger (`MISER_ALERT_LEDGER_FILE`, default `~/.miser-alert-ledger.json`).
- The block is an exact Anthropic-shaped `rate_limit_error` 429 with `retry-after` (seconds to next UTC midnight) and `x-miser-budget: exhausted`. The request is never forwarded and accrues no stats besides a sparse `budget: { blockedCount, firstBlockedAt }` node in `/api/miser/stats`.
- **Reactive cap:** the check compares already-measured spend against the cap before forwarding; the current request's cost is not estimated or reserved, so one expensive (or concurrent) request can overshoot the cap before the next request blocks.
- **Anthropic spend only:** budgets bound measured Anthropic-leg dollars. Codex/Ollama/OpenAI-format legs accrue $0 — but a capped project is blocked fleet-wide, including its OpenAI-format requests (cross-leg blocking on Anthropic spend).
- **Restart accrual-loss window:** in-memory spend is authoritative; a process crash can lose up to one async-flush window (≤5s) of accrual.
- **Attribution is advisory:** `x-termdeck-project` (or the `/p/<project>/` path) is trusted as an operator-controlled header, not a security boundary. An absent/empty header attributes to `default`.
- **Budgeting `default` is legal but discouraged:** `default` aggregates every unattributed panel, so capping it blocks panels that never opted into attribution.

### B6 — policy watchdog (alert-only, never blocks)

```bash
MISER_POLICY='{"pkachu":{"expectedModel":"claude-sonnet","maxContextTokens":400000}}'
```

- `expectedModel` (prefix match against the request `model`) fires a model-drift alert; `maxContextTokens` fires a context-bloat alert computed from MEASURED usage only (`input + cacheRead + cacheWrite`) — never from char/4 estimates, never on legs without usage capture.
- One pkachu alert per project per check-type per UTC day; every subsequent event still increments the sparse `policy: { modelDriftCount, contextBloatCount }` stats node.
- Budget-blocked requests never produce drift alerts (they never reach a model).

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
