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
| `GET /api/miser/stats/panels` | Per-project/per-panel attribution counters for `/p/<project>--<panel>/v1/messages` traffic |

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

`GET /api/miser/stats`, `GET /api/miser/stats/trend`, and `GET /api/miser/stats/panels` use `ok` as a data-authority flag, not as a handler-reachability flag. They return HTTP 200 when reachable even if `ok:false`. On `GET /api/miser/stats`, top-level `ok` / `authoritative` cover the rolling-window aggregate and persistence state; they do not cover per-week authority. `GET /api/miser/stats/trend` mirrors the same persistence contract while returning its sparse `entries` payload. Clients must check:

- `authoritative`: true only when the returned counters are durable and not degraded.
- `durable`: true only when there are no pending writes and persistence is healthy.
- `degraded`: true when load/write/persistence state means the counters are not authoritative.
- `persistence`: detailed load, flush, pending, and file state.
- `recordRejections`: dropped/rejected record counters and `byLabel` breakdown. Main stats labels include `usage`, `budget`, `policy`, and `optimizer`; panel stats labels are `<project>--<panel>`.
- `weeklyAuthoritative`: true only when every exposed week is authoritative.
- `nonAuthoritativeWeekCount` / `nonAuthoritativeReasons`: top-level weekly rollup fields, so clients do not have to iterate the weekly array to detect unverified weekly data.

Weekly stats in the `/api/miser/stats` response include `authoritative` / `degraded` at the weekly summary and per-week level. Contract revision: weekly authority is no longer proven by daily-key coverage. A weekly total is authoritative only when persistence is healthy and durable and the persisted `__weekly` bucket carries explicit `recorded_event_instant` provenance from a stats writer. This follows the record-don't-reconstruct rule: subscription weeks are keyed from the event instant, while daily UTC keys are an observation log for rolling windows and legacy recovery. An empty daily object `{}` means the day was observed and quiet; a missing daily key means the day was not observed. Daily coverage can explain degradation for missing unrecorded weeks, but it cannot make reconstructed or unprovenanced weekly data authoritative. The top-level `weeklyAuthoritative` rollup is the response-level signal for weekly authority. A non-authoritative week carries `nonAuthoritativeReason` and, when daily observations are missing, `coverage`. Current reasons:

- `missing_daily_observation`: at least one expected day key for the week is absent.
- `missing_weekly_provenance`: a stored or exposed weekly bucket has no explicit event-instant provenance, including legacy/R20-era stored weekly data and hand-edited snapshots.
- `inferred_from_legacy_daily`: the weekly bucket was rebuilt from legacy daily-only data and is preserved for visibility only.
- `persistence_degraded`: stats persistence is unhealthy or not durable.
- `migration_retention_failed`: weekly migration/retention failed, so preserved weekly data cannot be trusted as authoritative.

`GET /api/miser/health` returns process vitals:

- `ok`
- `uptimeSecs`
- `reqPerMin`
- `perLegErrors`
- `c1DisabledProjects`
- `statsFlushLagMs`
- `pendingWrites`

Health `ok` remains the process health flag. Stats endpoint `ok` values are stricter: HTTP 200 with `ok:false` means “reachable, but not authoritative.”

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

## Lane Prompt Compiler

Use `make-lane-prompt` to generate bounded prompts instead of hand-writing ORCH, builder, architect,
or audit boot text under pressure.

```bash
make-lane-prompt \
  --project aetheria \
  --kind orch-dispatch \
  --task "Sprint19 PR-4 Grok audit dispatch" \
  --pr 351 \
  --facts /tmp/pr351-facts.md \
  --out /tmp/aetheria-pr351-orch-prompt.md
```

Supported `--kind` values: `orch-dispatch`, `codex-builder`, `codex-audit`, `grok-audit`,
`claude-architect`.

Generated ORCH prompts cap pre-dispatch tool use and forbid source/CI/fleet inspection. Generated
builder and audit prompts include compact `SUMMARY`/`ORCH-RESULT`, notify-back, and stop contracts
compatible with `spawn-lane.sh` boot validation.

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
| `MISER_PKACHU_TOKEN` | File path containing the bearer token for the **default route** — daily rollup posts *and* every alert not routed elsewhere |
| `MISER_PKACHU_ENDPOINT` | HTTP(S) endpoint for the **default route**: daily rollup JSON posts, plus the destination for all fleet-scope alerts and for any project without a route of its own |
| `MISER_ALERT_ROUTES` | JSON map of `project -> {endpoint, tokenFile}` (or the string `"@default"`) sending that project's alerts to its own channel. **Unset = OFF**, and OFF is fully inert: every alert goes to the default route exactly as before |
| `MISER_ALERT_ROUTES_OPS` | Destination for miser's *own* routing/config defect alerts. Same value grammar as one route-map entry. Unset falls back to the default route. **See the warning below** |
| `MISER_ALERT_ROUTES_ALLOW_REMOTE` | `1` permits non-loopback alert endpoints. Default off: a remote endpoint is rejected at startup, because an alert route carries a live bearer token |
| `MISER_ALERT_ROUTES_UNROUTED` | `withhold` (default) or `escalate` — whether the ops defect alert for a valid-but-unmapped project **includes** the withheld alert text. `withhold` omits it, so a project's content never reaches a channel that was not configured for it. Text from an *invalid* project name is never included in either mode |
| `MISER_ALERT_ROUTES_UNROUTED_MAX` | Cap on distinct unroutable project names reported per UTC day, default `32`. Beyond it names collapse into a single `@overflow` bucket, so a bad map cannot storm the ops channel |
| `MISER_ALERT_ROUTES_STRICT` | `1` makes an **incomplete** route map fatal at startup instead of degraded. Default off: a configured project missing from the map degrades — proxy keeps serving, `health.ok` goes false, that project's alerts are withheld and reported — rather than stopping miser |

> **⚠ Operator warning — `MISER_ALERT_ROUTES_OPS` is validated even when alert routing is off.**
> A malformed or non-loopback `MISER_ALERT_ROUTES_OPS` **will block miser from starting even when
> `MISER_ALERT_ROUTES` is unset and alert routing is otherwise entirely off.** With
> `Restart=on-failure` / `RestartSec=5` in the unit file, that is a five-second crash loop ending in a
> `failed` unit. This is deliberate, and it is the one fatal that fires on a variable an operator may
> believe is inactive: the alternative is discovering a bad ops route at the exact moment the safety
> path is first needed, with a live bearer token pointed at the wrong host.
>
> **Recovery: `unset MISER_ALERT_ROUTES_OPS` (or remove it from the unit's environment), then restart.**
>
> The asymmetry is intentional — a route you stated *incorrectly* is fatal; a route you merely *omitted*
> is not. Missing a project from `MISER_ALERT_ROUTES` degrades and keeps serving.

### Alert destinations

`sendAlert(text, opts)` has three destination classes. `opts.kind` is a free-form diagnostic label and
**never** affects routing.

| Class | How to express it | Destination |
|---|---|---|
| **project** | `{ project: 'structural360' }` | that project's route from `MISER_ALERT_ROUTES`, else the default route |
| **fleet** | `{ scope: 'fleet' }` — `{}` and `{ project: null }` are equivalent | the default route (`MISER_PKACHU_*`) |
| **ops** | `{ scope: 'ops' }` — must be explicit, never inferred | `MISER_ALERT_ROUTES_OPS`, else the default route |

`opts.project` is a **project name, not a route selector.** Passing a route, an endpoint or a channel
name there is a category error rather than a style preference: the value fails project-name validation,
collapses into the `@invalid` bucket, and the alert is **withheld**. The loss is loud — one ops defect
alert, a counter, a log line and a health field — but the alert does not reach its intended reader. An
explicit `scope` always wins over an inferred one, and a `scope`/`project` conflict logs exactly one
`ALERT-SCOPE-CONFLICT` line before honouring the explicit scope.

---

## Non-Goals

No truncation, summarization, TOON/schema re-encoding, output trimming, or proxy-side compaction. Proxy-side mutation is limited to safe normalization, guarded lossless dedup for non-caching clients, optional legacy cache hint, tool pruning when explicitly configured, and C1 context-management injection for opted-in projects.
