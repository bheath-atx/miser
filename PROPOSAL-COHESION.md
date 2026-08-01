# PROPOSAL — miser COHESION architecture

**Author:** Fable-5 architect panel · **Date:** 2026-07-29 · **R2:** 2026-08-01, folds
`CODEX-IQA-COHESION-R1.md` (REVISE, 7 findings); all cited sources re-read at current tips.
**Status:** R2 for Codex INVERSION-QA → Grok final review. Design only — no code in this sprint.
**Briefing:** `BRIEFING-FABLE5-ARCHITECTURE.md` + `IN-FLIGHT-CONTEXT.md` (same directory).
**Base assumption (per IN-FLIGHT-CONTEXT.md §sequencing):** this design targets **main + E3
(PR #11, `4eb5656`) + G7 (`sprint/miser-E`, `e5fc8fd`) already merged**, not current main. E2/B1
(C1 auto-tune advisor) is gate-approved, deliberately unstarted, and is *placed* by this design
(§4.4).

---

## 0. Summary

Brad's scope statement: *"miser [is] the entire package intended to reduce token usage… a cohesive
system, not disjointed parts."* The system exists to act on exactly two facts, and today four+
components each privately re-derive them and disagree:

1. **How full is a panel?** — drives rotation, where 93% of fleet spend lives
   (ROTATION-STRATEGY-SPEC.md §0, measured from 14 days of `~/.miser-stats.json`).
2. **What did it cost?** — drives routing and model policy.

The design: **one authoritative *interpreter* per fact, publishing one versioned machine-readable
artifact per fact, with every other component demoted to a consumer of that artifact — and every
consumer required to fail loudly on staleness or schema mismatch.** Fullness authority = the
existing watchdog timer backed by a new single shared measurement library. Cost authority = miser's
`pricing.js`/`stats.js`, with its silent unknown-model fallback made loud. Zero new daemons; the
producers are the existing `orch-token-watchdog.timer` (5 min) and the freshness net is the existing
`stack-health.timer` (30 min) — both confirmed live via `systemctl --user list-timers` 2026-07-29.

Two components get **delete** verdicts, not integration (§4.5). One piece of the briefing's framing
gets argued against rather than designed around (§2). The held E2/B1 advisor is placed as the
system's optimisation layer, consuming only the published cost fact (§4.4).

**New live evidence found while writing this** (watchdog log `~/.termdeck/orch-token-watchdog.log`,
2026-07-29 00:30Z run): the partial fix's empirical ceiling is failing in the *opposite* direction
right now — NACHO-ORCH reads `wm347K/217K (160%)` and termdeck-updates-ORCH `wm221K/204K (108%)`.
Both panels are alive and past their "observed ceiling" without compacting, which proves those
ceilings are stale lower bounds, and the watchdog is paging "PRIMARY PAST HARD 199K" on a healthy
panel. A ceiling learned once and never revised is just a slower way to be wrong. The design makes
ceilings a *maintained, self-correcting* fact (§4.2.3), not a one-shot observation.

---

## 1. Fact base — every number, with its source

All verified directly on this host 2026-07-29 unless noted. No number below is derived from policy.

| # | Fact | Source |
|---|---|---|
| F1 | Three fullness answers for one panel: 183K (TermDeck), 22% of 1M (watchdog, pre-fix), ~100% of a 217K observed ceiling (transcript) | Briefing §evidence, verified on-host 2026-07-28 by NACHO-ORCH |
| F2 | Fleet compaction points measured: **217K, 284K, 401K** — no single effective window | Briefing §evidence; `orch-token-watchdog.py:76-78` comment block (Brad-approved 2026-07-28) |
| F3 | A fabricated cap (`claude-opus-5: 444_000` = 400K/0.90 back-derived from our own rotate target) once shipped and was trusted as spec | `orch-token-watchdog.py:33-35`; `orch-token-gauge.py:36-39` |
| F4 | Watchdog now derives per-panel ceilings from compaction history and clamps triggers (`observed_ceiling()` `:93-133`, `rotation_targets()` `:136-161`, `CEILING_FRAC=0.92`, `COMPACTION_DROP_FRAC=0.6`, `MIN_CEILING=120_000` `:88-90`) | `~/bin/orch-token-watchdog.py` |
| F5 | **The gauge got none of that fix.** `orch-token-gauge.py` still carries its own private `MODEL_WINDOWS` table (`:40-53`), its own thresholds (`:54-68`), and reports % against the *model cap* (`:266`) — the exact bug the watchdog just fixed. It reports S360-ORCH style panels as `wm182K/1000K (18%)` today | `~/bin/orch-token-gauge.py`; contrast watchdog log line format |
| F6 | Live stale-ceiling failure: `NACHO-ORCH: wm347K/217K (160%)` and `termdeck-updates-ORCH: wm221K/204K (108%)`, both alive, no compaction — false "PAST HARD" page firing | `~/.termdeck/orch-token-watchdog.log` 2026-07-29T00:30Z |
| F7 | TermDeck `context-meter.js`: reads 256KB transcript tail for last main-thread `usage` (`computeContextK`, `:52-106`), never throws, returns null on failure; `classifyContext(contextK, warnK, overK)` bands **only** on `warnK`/`overK` (`:115-121`); enforcement is a separate pure state machine `evaluateEnforcement` (`:153`) keyed on `maxContextK`, default action `notify` (`normalizeAction`, `:123-127`) | `/home/nacho/.npm-global/lib/node_modules/@jhizzard/termdeck/packages/server/src/context-meter.js` (re-read 2026-08-01) |
| F8 | TermDeck threshold wiring, two distinct channels: **banding** — header `contextLevel = classifyContext(contextK, cfg.warnK, cfg.overK)` (`index.js:576`) where `warnK`/`overK` come from **global** `config.context` only, defaults **350/400** (`resolveContextConfig`, `index.js:516-527`; also projected to clients at `:3511-3514`; absent in `~/.termdeck/config.yaml` today). **Enforcement** — `meta.maxContextK` and `meta.contextAction` are the only per-session meta overrides; they feed `enforceContext` (`index.js:583`) → `evaluateEnforcement`, NOT the band. **There is no per-session override for `warnK`/`overK`** — a per-panel header band is impossible without a TermDeck change | termdeck `packages/server/src/index.js:516-527,576,583,3511-3514` (re-read 2026-08-01); `~/.termdeck/config.yaml` |
| F9 | The watchdog already PATCHes TermDeck session meta every run: `contextK, cumulativeK, windowK, contextPct` | `orch-token-watchdog.py:1216` |
| F10 | miser pricing table knows `claude-sonnet-4-6`, `claude-opus-4-8`, `claude-haiku-4-5(-20251001)` + `*` fallback at 3/15; header pins source: Anthropic pricing docs, pinned 2026-07-22, re-verified 2026-07-23 | `/home/nacho/miser/src/pricing.js:3-38` |
| F11 | Unknown models fall through to `*` with only a `console.warn` (`priceForModel`, `:100-105`) — invisible unless someone reads the journal | `pricing.js:100-105` |
| F12 | `claude-opus-5` is priced only via systemd env override at 5/25/0.5/6.25/10 — values **assumed equal to opus-4-8**, not taken from docs ("opus-5 priced as opus-4-8", corrects a 35.6% under-count) | `~/.config/systemd/user/miser.service.d/zz-miser-switches.conf`; ROTATION-STRATEGY-SPEC.md §5.1 |
| F13 | `claude-sonnet-5` and `claude-fable-5` are in live traffic and mis-costed via `*` | Briefing §evidence |
| F14 | Fable builders and Codex bypass miser entirely (no `ANTHROPIC_BASE_URL`); the only provider leg miser has ever recorded is `anthropic`. Some cwds also pool into `default` ($49.71) | ROTATION-STRATEGY-SPEC.md §6 |
| F15 | Panel attribution (B4) is live via `/p/<project>--<panel>` path parsing, but rolled out on 1 of 6 cwds; per-panel stats on current main are **in-memory and reset on miser restart** (E3 makes them durable once merged — F25) | `miser/src/routing.js:47-67`; `proxy.js:280-282` (`note: 'in-memory; resets on restart'`); ROTATION-SPEC §4; live `curl /api/miser/stats/panels` 2026-07-29 |
| F16 | Cost split: cacheWrite1h 60.5% + cacheRead 31.3% = **93% of spend is cache mechanics**; sparse turns on big context is the driver (20 turns bursted $4.00 vs hourly $42.00) | ROTATION-STRATEGY-SPEC.md §0 |
| F17 | Rotation ladder 350K plan / 400K soft / 700K hard is **policy**, Brad-approved 2026-07-27, written against an assumed 1M window; CLAUDE.md now carries a ceiling-relative warning (2026-07-28) but still states the absolute ladder | `~/.claude/CLAUDE.md` token-rotation section; ROTATION-SPEC §2-3 |
| F18 | `nacho-orch-monitor.sh` had hardcoded `THRESHOLD_WARN=300 / THRESHOLD_HARD=380` ("for Sonnet") and a regex parser of the watchdog's human log; retired 2026-07-28 (unscheduled — no crontab/systemd reference found 2026-07-29), file still present in `~/bin` | `~/bin/nacho-orch-monitor.sh:6-7,14-17`; crontab + systemd search 2026-07-29 |
| F19 | `orch-context-monitor.py` parses the watchdog log with regex expecting `"<LABEL>: NNK ctx"`; current log format is `"<LABEL>: wmNNNK/NNNK (NN%)"` (`disp`, watchdog `:1213`). Its output CSV last wrote **2026-07-07**, and it has **zero runtime consumers** — no scheduler (crontab + systemd searched 2026-07-29) and no script reads its CSV (grep of `~/bin`, `~/sprints`, `/home/nacho/*.sh`: only hits are old codex logs). It does, however, have a live **documentation consumer**: `ORCH-LANES.md` still assigns it the "fleet rollup" role under NACHO-ORCH (`ORCH-LANES.md:79`, drift note `:86`) — an operator following that doc today would be directed to a broken tool | `~/bin/orch-context-monitor.py:22-40`; `ls -la ~/.termdeck/working-memory-trends.csv`; `~/sprints/ORCH-LANES.md:79,86` (re-read 2026-08-01) |
| F20 | Session archive is append-only, alarms only to **its own log file** (`archive.log`), unbounded by design; the 30-day pruner silently deleted May+June before it existed | `~/bin/claude-session-archive.sh` (entire file, esp. `:45-49`) |
| F21 | `stack-health.py` (30-min timer) already checks termdeck/mnestra/miser/gemma/CPU-lane and posts alerts | `~/bin/stack-health.py:52-140`; `systemctl --user list-timers` |
| F22 | miser B6 policy watchdog is alert-only, per-project `maxContextTokens` = 400,000 for all six projects | `zz-miser-switches.conf` (`MISER_POLICY`); `miser/src/policy-watchdog.js:7-11` |
| F23 | miser hard constraint: live API path for every panel; availability outranks everything; infra frozen — **any miser restart needs Brad's explicit go** | Briefing §constraints; `/home/nacho/sprints/CLAUDE.md` INFRA FROZEN |
| F24 | Panel identity keys for attribution must be **stable role labels**, never session UUIDs. The 2026-07-27 incident, as ROTATION-SPEC itself corrected it: panel `23b815ac` is **not dead** — a predecessor **and** its replacement both billed to the same `termdeck-updates--23b815ac…` key between 14:14Z and 14:20Z, because the UUID was pinned in a cwd file both processes read. **Two distinct panels, one identity, inseparable in the data** — that aliasing, not resurrection of a dead id, is why UUID keys are banned | `ROTATION-STRATEGY-SPEC.md:97-101` (re-read 2026-08-01); live curl 2026-07-29 |
| F25 | **E3** (PR #11 draft, CI green, tip `4eb5656` — one commit past v1's cited `e8c059b`, an injectable-clock fix with no interface change): durable per-panel history + weekly buckets; an **authority contract** already shipped on `/api/miser/stats`, `/stats/panels`, `/trend` — `authoritative`/`degraded`/`persistence`/`recordRejections` fields, authority gauges on `/metrics`, counted dropped mutations; `ok` now means *healthy AND durable* (HTTP 200 + `ok:false` is a valid, documented state). Its 13-round redesign adopted: **presence of a daily key IS the observation; empty `{}` = observed-and-quiet; missing key = not observed; never infer a fact into an absence** | `IN-FLIGHT-CONTEXT.md` §E3; re-verified at `4eb5656` 2026-08-01: authority fields live in `stats.js:813,1310-1323`, usage recorded on response completion `router.js:334` |
| F26 | **G7** (`sprint/miser-E`, `e5fc8fd`, 439 pass, awaiting re-audit): composition seam `buildServerDeps(config, guardDeps)` (`src/bootstrap.js:16`), entry `startProduction(config, runtimeDeps, testSeams)` (`src/bootstrap.js:35`); plus a **live-state test guard** — tests fail loudly if any path resolves to its `$HOME` default | `IN-FLIGHT-CONTEXT.md` §G7; re-verified at `e5fc8fd` 2026-08-01 (tip unchanged, seam names confirmed at the cited lines) |
| F27 | **E2/B1**: C1 auto-tune advisor — analyses `applied_edits` + post-clear cache-write costs per project, RECOMMENDS `trigger`/`clearAtLeast`. Brad-gated contract: advisory only, structurally impossible to mutate live config. Gate-approved, NOT started, held for this design | `IN-FLIGHT-CONTEXT.md` §E2/B1 |

---

## 2. Where the briefing's framing is wrong — argued, not designed around

**2.1 "One source of truth per fact" cannot literally hold for fullness — and pretending it can
would recreate the drift.** There are irreducibly *two* raw readers of panel context on this host:
TermDeck's `context-meter.js` (Josh's product, F7 — we do not control it, per the briefing's own
hard constraint) and ours. Any design that claims a single reader is quietly ignoring the one it
can't delete. The honest formulation this proposal implements: **one authoritative *interpretation*
(published facts artifact), exactly two raw readers, reconciled automatically every cycle, with
divergence treated as an alarm instead of a coexisting private opinion** (§4.2.5). Disagreement
becomes a detection mechanism instead of a failure mode.

**2.2 TermDeck's 183K was not a wrong measurement — it was an un-interpreted one.** The meter's raw
count (F7) is computed the same way ours is (input + cache_read + cache_creation of the last
main-thread assistant turn). What was wrong on 2026-07-28 was the *banding*: 183K displayed against
default warnK=350/overK=400 (F8) reads as "fine" when the panel's real ceiling is 217K. The fix is
therefore thresholds-per-panel, not a rival reader. **But TermDeck's per-session seam covers only
half of that** (F8): `meta.maxContextK` overrides the *enforcement* line per panel; the *header
band* is computed exclusively from global `warnK`/`overK`, for which no per-session override
exists. So without a Josh change we can make TermDeck **announce** breach of a panel's true line
(notify-only enforcement at `hard_at`, §4.2.4) but not **display** the band correctly against it —
per-panel header correctness requires a TermDeck feature (the FR in §4.2.4). The design is correct
and complete without that FR; the FR only moves per-panel truth from the facts file/gauge/meta into
the header pixel itself.

**2.3 miser cannot be the fullness authority, despite seeing "every request".** Tempting — the proxy
observes usage in-band with no transcript parsing. But: (a) Fable and Codex builders bypass it
entirely (F14), so it is blind to part of the fleet; (b) panel attribution is rolled out on 1 of 6
cwds and resets on restart (F15); (c) the hard constraint (F23) says availability outranks
everything — putting the fleet's rotation-critical measurement inside the fleet's availability-
critical path couples the two things we most need decoupled. So: **fullness authority = watchdog
(transcript-based, out-of-band); cost authority = miser (in-band).** Two facts, two authorities, one
published artifact each.

**2.4 E3's principle is adopted design-wide, and it caught a defect in this proposal's own first
draft.** *"Stop reconstructing observation. Record it"* (F25) is exactly the disease in the briefing's
evidence: a window reconstructed from a model table, a price reconstructed from a `*` fallback, a
"quiet day" reconstructed from a log hole. This proposal therefore commits to E3's semantics
everywhere (P7, §3): observations are recorded with their observation event; absence means
not-observed, never a value; anything that is *not* an observation (a model-cap, a fleet-derived
prior, an assumed price) is carried in a separate, explicitly-labeled field and taints everything
computed from it as `degraded`. The first draft of §4.2.3 had a fresh panel silently *inheriting* an
effective ceiling from other panels' compactions — that is inferring a fact into a hole, the same
shape E3's review rejected after ten rounds, and it is corrected below: a prior may inform a
*trigger*, but it is never presented as the panel's ceiling, and every consumer can see which it got.
Likewise this design does not invent a new authority vocabulary: the facts artifact reuses E3's
(`authoritative` / `degraded` + reasons), so a human or tool reads one contract across the whole
system rather than two dialects.

**2.5 The partial fix is currently wrong in production and the briefing doesn't know it yet** (F6).
`observed_ceiling()` learns a lower bound once and never revises it upward, so a panel that gets the
1M-beta serving path (or whose one observed compaction was anomalous) is clamped forever and pages
falsely. The briefing frames the empirical ceiling as "fixed the watchdog's numbers" — true on
2026-07-28, already false by 2026-07-29 00:30Z. Ceilings must be maintained facts with an
invalidation rule (§4.2.3), or we have just replaced "trusted fabricated cap" with "trusted stale
observation" — the same failure class, F3, wearing empirical clothes.

---

## 3. Design principles — the seam rules

These are the rules that make drift *structurally hard*, not aspirational. Each is enforced by an AC
in §6.

- **P1 — One implementation per measurement.** Exactly one importable library computes context size,
  compaction detection, ceilings, and rotation targets. No other file on the host may contain a model
  window table or a rotation threshold constant. (Grep-enforceable; AC-1.)
- **P2 — Facts travel as versioned JSON artifacts, never as parsed logs.** Both dead monitors died
  the same way: regex against a human-readable log whose format changed (F18, F19). Log-scraping is
  banned as an integration mechanism. Artifacts carry `schema` and `generated_at`; consumers hard-fail
  on unknown schema and go loud on staleness. (AC-4, AC-5.)
- **P3 — Policy documents point at the artifact; they do not copy numbers.** A number copied into
  CLAUDE.md is a number that drifts (F17 happened exactly this way). (AC-15.)
- **P4 — Every failure announces itself.** Silence was the common factor in every incident in the
  evidence: silent pruning, silent parser death, silent `*`-fallback pricing, silent clamp staleness.
  Each component below has a named detection path and a named announcement channel (§5).
- **P5 — Nothing new in the request path; zero new daemons.** Producers are existing timers (F21,
  watchdog timer). miser gains no synchronous I/O and no new failure modes on the hot path. (AC-12.)
- **P6 — Fail-safe direction is inaction plus a page.** Consistent with the watchdog's arming gate
  and the S360 lesson (`orch-token-watchdog.py:166-173`): when a fact is stale, unavailable, or
  self-contradictory, components must *stop acting and say so*, never act on the bad number.
- **P7 — Record observation; never reconstruct it (adopted from E3, F25).** An observed value is
  stored with the event that observed it. Absence is recorded as absence, never filled with an
  inference. Non-observations (caps from docs, fleet priors, assumed prices) live in separate,
  named fields, and any derived value that rests on one is marked `degraded` with reasons — using
  E3's existing authority vocabulary, not a new one. (AC-3, AC-8.)

---

## 4. The architecture

### 4.1 Overview — who measures, who publishes, who consumes

```
                     ┌────────────────────────────────────────────────┐
   transcripts       │  orch_context_core.py  (LIBRARY, the only      │
 ~/.claude/projects/ │  implementation: reading, compaction detect,   │
        │            │  ceiling ledger, rotation targets)             │
        ▼            └───────────────┬────────────────────────────────┘
  orch-token-watchdog.timer (5 min, EXISTING) — the PRODUCER
        │ writes atomically                        │ PATCHes (existing, F9)
        ▼                                          ▼
  ~/.termdeck/context-facts.json            TermDeck session meta
  ~/.termdeck/context-ceilings.json         (contextPct, windowK, + maxContextK)
        │                                          │
        ├─ orch-token-gauge.py (CLI, consumer)     ├─ TermDeck header/FleetView (Josh's display;
        ├─ gauge-check-report.sh (consumer)        │   bands via GLOBAL warnK/overK — F8; notify
        │                                          │   armed per-panel at meta.maxContextK)
        ├─ orch self-checks / R15 poll turns       └─ context-meter raw reading fed BACK
        ├─ CLAUDE.md rotation policy (by pointer)      into facts as cross-check reader
        └─ stack-health.py (freshness net, 30 min, EXISTING)

  API traffic ──► miser proxy (:20128) ── pricing.js (THE cost authority)
                        │                     └─ unknown-model counter → LOUD (stats + alert)
                        └─ stats.js → /api/miser/stats|trend|panels|/metrics  (cost artifact)
```

### 4.2 Fact A — panel fullness

**4.2.1 The library: `orch_context_core.py`.** New importable module in `~/bin` (plain file import,
same pattern as today's scripts; no packaging infrastructure). Contents are a *move*, not a rewrite —
the watchdog's current, battle-hardened logic becomes the shared implementation:

- `read_context(transcript_path)` → last main-thread assistant `usage` sum (input + cache_read +
  cache_creation), sidechain-filtered — semantics identical to watchdog `:348-410` and TermDeck's
  meter (F7), so the two readers stay commensurable.
- `resolve_transcript(session_meta, cwd)` → transcript path, precedence: explicit path from TermDeck
  session meta if present → newest-by-internal-timestamp cwd glob (today's method) as fallback,
  **with the chosen path and method recorded in the fact** so misattribution is diagnosable. (The
  `panel_ctx_impossible` class — watchdog `:1218-1238` — is caused by cwd-glob guessing across 20-112
  transcripts; meta-first resolution attacks the root. Whether TermDeck publishes the path is a
  Phase-0 verification item, §7 V1 — the watchdog already *probes* for four meta key names at
  `:413-420`, but their presence is unverified.)
- `detect_compactions(path)` / ceiling-ledger read+write (§4.2.3).
- `targets(window, ceiling)` → (nudge, rotate, hard) — the current `rotation_targets()` logic (F4),
  single copy.

**4.2.2 The artifact: `~/.termdeck/context-facts.json`.** Written atomically (tmp+rename, the
watchdog's existing `atomic_write_json` `:242-254`) by the watchdog at the end of every 5-min scan:

```json
{ "schema": 1, "generated_at": "<iso8601>", "producer": "orch-token-watchdog",
  "panels": { "<session-id>": {
      "label": "...", "cwd": "...", "model": "claude-opus-5",

      "context_tokens": 347000, "measured_at": "<iso8601>",          // OBSERVED (transcript usage)
      "transcript_path": "...", "resolution": "meta|cwd-glob",       // meta=observed identity;
                                                                     // cwd-glob=inferred identity
      "observed_ceiling": null,                                      // OBSERVED compaction peak for
      "ceiling_observed_at": null,                                   // THIS panel, or null = not
                                                                     // observed (never a guess)
      "observed_floor": 347000,                                      // OBSERVED: panel provably
                                                                     // alive at this size (F6 case)
      "prior_ceiling": 217000, "prior_source": "fleet-min|model-cap",// NON-observation, labeled
      "model_cap": 1000000,                                          // from docs table (named src)

      "nudge_at": 350000, "rotate_at": 400000, "hard_at": 700000,    // DERIVED triggers
      "pct": 35, "pct_basis": "observed|prior|model-cap",            // DERIVED; basis always named

      "termdeck_context_k": 183, "divergence_pct": 4.2,              // second reader, recorded

      "authoritative": false,                                        // E3 vocabulary (F25):
      "degraded_reasons": ["ceiling-is-prior", "identity-inferred"]  // true only when context is
  } } }                                                              // observed, identity observed,
                                                                     // and ceiling basis observed
```

The observed/prior split is P7 in schema form: `observed_ceiling` is null unless *this panel* was
seen compacting — the hole stays a hole. Triggers may be *derived* from a prior (that is what
triggers are for — acting safely under uncertainty), but the artifact always says which basis
produced them, and a panel whose numbers rest on any non-observation is `authoritative: false` with
machine-readable reasons. Consumers MUST check `schema == 1` (hard-fail otherwise) and
`generated_at` within 15 min (3 missed ticks ⇒ loud STALE + nonzero exit). Panels the watchdog
cannot measure appear with an explicit `"error"` field rather than being silently absent — absence
must always mean "panel does not exist."

**4.2.3 The ceiling ledger: `~/.termdeck/context-ceilings.json`** — the fix for both directions of
ceiling wrongness (F2 down, F6 up), built strictly on P7: the ledger stores **only observation
events**, never conclusions.

- **Two observation types, both recorded with their event:**
  - *compaction*: `{type:"compaction", model, panel_label, session, peak, ts}` — panel seen
    compacting at `peak` (detection = today's `COMPACTION_DROP_FRAC` logic, F4).
  - *survival*: `{type:"survival", model, panel_label, session, tokens, ts}` — panel seen alive and
    working at `tokens` (recorded when a reading exceeds all previously known bounds; this is the
    F6 evidence made durable: "NACHO-ORCH observably ran at 347K" is an observation, not an
    inference).
- **Derivation happens at read time, in the core library, and is labeled.** A panel's
  `observed_ceiling` = its own most recent compaction peak not contradicted by a later survival
  observation above it (a survival at `> peak×1.05` marks that compaction bound *superseded* — the
  serving config demonstrably changed; announced via the watchdog's batched pkachu report,
  `pkachu_report` machinery `:1089-1125`, and the panel drops back to prior-based triggers,
  `authoritative: false`). No panel ever inherits another panel's observation *as its own ceiling*.
- **Priors are separate and named.** For a panel with no compaction observation, the trigger
  derivation may use `prior_ceiling` = min recent (30d) compaction peak across the fleet *for that
  model*, labeled `prior_source: "fleet-min"`, else the docs model cap labeled `"model-cap"`.
  Conservative-low by design (the fabrication lesson, F3, says never guess high) — but it is
  presented as a prior everywhere, taints `authoritative`, and vanishes the moment a real
  observation exists. This closes the gap CLAUDE.md flags ("a panel with no observed compaction yet
  has no measured ceiling") *without* filling the hole with a fake fact.
- **Priors are superseded the same way.** A panel running past a prior-derived bound is not an
  anomaly (priors are deliberately conservative-low) — it is a survival observation: record it, and
  never derive any trigger below the panel's own `observed_floor`. Only a reading above the *docs
  model cap* remains genuinely impossible and keeps today's misattribution alarm (D6).
- The 5% supersession margin exists so ordinary jitter near a bound doesn't thrash; it is a design
  parameter for the builder to keep, not re-derive.
- **Serving-mode honesty:** the transcript exposes no serving-config signal, so model id is the only
  available prior key. The ledger's header comment records this limitation; supersession-by-survival
  is the mechanism that re-learns when serving config changes — never a table edit.

**4.2.4 TermDeck seam — what publishing `maxContextK` actually buys, and what it doesn't.**
*(Rewritten in R2: v1 claimed setting `meta.maxContextK = hard_at/1000` "turns the header band
correct." That was false — per F8, the band is computed only from global `warnK`/`overK`
(`index.js:576`; `classifyContext`, `context-meter.js:115`), while `maxContextK` feeds the separate
enforcement state machine (`index.js:583`; `evaluateEnforcement`, `context-meter.js:153`).)*

The watchdog (already PATCHing meta, F9) additionally publishes `meta.maxContextK = hard_at/1000`
per panel. What that verifiably does: arms TermDeck's own **notify-only enforcement at the panel's
true hard line** — `contextAction` is left unset so it resolves to `notify` (F7/F8), meaning
TermDeck itself announces breach of the panel's real ceiling-derived line instead of staying silent
until a fabricated global 400K. Nothing destructive is armed: enforcement was previously disabled
globally (`maxContextK` undefined ⇒ `evaluateEnforcement` returns `none`), and we enable only the
notify action per-session. What it does NOT do: change the header band. Per-panel header correctness
has exactly three channels, stated honestly:
  1. **Today, without Josh:** the facts file, the gauge, and the watchdog's PATCHed `contextPct`
     meta (F9) carry the per-panel truth; the header band stays global-thresholded (350/400) and is
     documented as such in the CLAUDE.md rewrite (§4.2.6) so nobody reads it as per-panel.
  2. **The notify at `hard_at`** (this section) — TermDeck announces the line even though it doesn't
     draw it.
  3. **A Josh feature request — filed unconditionally, not as a fallback** (via
     termdeck-updates-ORCH's liaison lane, per its charter in `/home/nacho/CLAUDE.md`; it extends
     the existing FR-5/6/7 native-monitoring series, `ORCH-LANES.md:81`): per-session `warnK`/`overK`
     meta overrides, so the band can be driven from the published facts. This is the only path to a
     per-panel-correct header pixel, so it is the FR's job — the design does not pretend `maxContextK`
     does it.
  - **Fallback if the PATCH doesn't persist or `notify` misbehaves (Phase-0 V2 fails):** publish
    nothing to TermDeck beyond today's F9 fields; channels 1 and 3 stand unchanged. The system is
    correct without TermDeck cooperation; TermDeck cooperation only makes it *visible in the header*.

**4.2.5 Reconciliation — two readers, one alarm.** TermDeck's meter writes `meta.contextK` each tick
(termdeck index.js:575). The watchdog reads it back and records it in the fact (`termdeck_context_k`,
`divergence_pct`). Divergence >20% on two consecutive runs ⇒ line in the batched pkachu report. This
converts the briefing's core complaint — independent readers disagreeing silently — into an automatic
detector: the only way the two readers can disagree is *out loud*. (20% not 5%: the readers sample at
different instants within a turn cycle; Phase-1 fixture work calibrates, builder may tighten.)

**4.2.6 Policy layer.** `~/.claude/CLAUDE.md` rotation section is rewritten to state: the ladder's
*shape* (plan → soft boundary-seeking → hard enforce; finish-within-5-turns economics, all per F16/
F17 — unchanged, Brad-approved), while stating that the *numbers* for any given panel are the
published `nudge_at/rotate_at/hard_at` in the facts file / the watchdog's `wmXK/YK` line, and that
the canonical constants live in `orch_context_core.py` only. The 2026-07-28 ceiling-relative warning
paragraph is subsumed and deleted. Orch per-turn self-checks (`--self`) read the facts file — one
small JSON read instead of re-scanning multi-MB transcripts every turn, which also serves R15
(cheap-poll discipline).

### 4.3 Fact B — cost

**4.3.1 Authority.** `miser/src/pricing.js` + `stats.js` remain the *only* place cost is computed;
`/api/miser/stats`, `/trend`, `/panels`, `/metrics` remain the only interfaces. Any document or tool
citing spend must cite these endpoints/stats-file, never re-price raw tokens itself. (ROTATION-SPEC
§0 did its own re-pricing because opus-5 wasn't in the table — fix the table, and that necessity
disappears.) **The authority contract for these endpoints is E3's, already shipped (F25):**
`authoritative`/`degraded`/`persistence`/`recordRejections`, with `ok` meaning healthy-AND-durable.
This design adds nothing to that contract's semantics and invents no parallel one — the additions
below surface *through* it. Durable per-panel history and weekly buckets are E3's, delivered; this
design consumes them (notably in §4.5) rather than re-solving them.

**4.3.2 Close the model gap — without inventing numbers.** Add `claude-opus-5`, `claude-sonnet-5`,
`claude-fable-5` to `DEFAULT_PRICING`, values taken by the builder from the Anthropic pricing docs
(the file's own pinned-source convention, F10) at build time, with URL + pin date in the header. Two
honesty rules:
  - If the docs do not list a model, it does **not** get a made-up entry (F3's lesson). It stays
    unlisted and is caught loudly by 4.3.3. The existing opus-5 env override (F12) is explicitly an
    *assumption* (opus-4-8 rates); it stays until docs values exist, and the override comment must
    say "ASSUMED = opus-4-8, not from docs" so it can never be laundered into a spec.
  - Historical data is NOT silently re-priced. Raw token counts in `~/.miser-stats.json` are correct;
    only their dollarization was wrong. Since `computeCost` prices at read time from the current
    table (`pricing.js:107-122`), fixing the table retroactively corrects displayed history — this
    is a feature, and the proposal notes it so nobody "corrects" stored data by hand.

**4.3.3 Make the fallback loud — the structural fix.** Today an unknown model warns to the journal
and silently bills at `*` (F11). Change: pricing an unknown model **records the observation** (P7:
"model X was seen and billed at fallback" is a fact, counted per model per day following E3's
recorded-day pattern, not a transient in-memory tally that a restart erases).

**The accounting seam, stated explicitly (R2 — v1 left it open): the observation is recorded on the
response path, never at read time.** Today usage is recorded on response completion
(`router.js:334`, `recordAnthropicUsage`) while dollars are computed later, on stats/trend reads
(`stats.js:1269`, `:1458`, via the `*` fallback in `priceForModel`, `pricing.js:100-104`). The
unpriced-model check happens at the record site: at usage-record time the recorder does a **pure
in-memory membership test** against the pricing table ("would `priceForModel(model)` fall through
to `*`?"), and if so persists `unpriced_models[<model>][<day-key>] += 1` through the same E3
stats-write path the usage record itself rides — an explicit seam in `stats.js`, injected like its
peers via `buildServerDeps`. No new I/O and no read-path change to the hot path: the test is a
table lookup and persistence piggybacks the existing record. Read paths (`/api/miser/stats`,
`/metrics`, rollups) **never mutate the counter** — a read that encounters fallback-priced spend
only *flags* the window; the counter moves only when a response is recorded. Chosen because
read-time mutation would double-count on every repeated stats/metrics/rollup read, and because
"model X appeared in traffic" is an event that happens on the response path — recording it anywhere
else would be reconstructing an observation (P7). Dollars themselves stay read-time-computed
(§4.3.2's self-correcting-history property depends on that).

Exposure: `unpriced_models` on `/api/miser/stats` and a `miser_unpriced_requests_7d` gauge on
`/metrics`; and — because fallback-priced spend is reconstructed, not observed — any window
containing fallback pricing is flagged through E3's existing `degraded` mechanism with an
`unpriced-models` reason. The
existing daily-rollup alert path (`daily-rollup.js sendAlert`, already imported by
policy-watchdog.js) fires when any counter is nonzero. Wiring goes through **G7's composition seam**
(F26): the counter/alert dependencies are injected via `buildServerDeps`, not required ad-hoc, and
all touched paths are injectable so the tests pass G7's live-state guard (no `$HOME`-default writes
from tests). Result: a new model appearing in traffic is a *paged event within 24h* and a visibly
degraded stats window, not a six-week silent mis-costing. We don't promise the table is always
current; we guarantee we *hear about it* when it isn't.

**4.3.4 Coverage honesty.** Per F14, miser's numbers are "all traffic routed through miser," not
"all spend." Fable builder spawns gain `ANTHROPIC_BASE_URL` pointing at `:20128/p/<project>--<role>`
as a **migration item** (spawn-template change in the orch-topology runbook lane — takes effect per
panel at next natural spawn; role labels not UUIDs, per F24). Codex/OpenAI-side capture is
deliberately out of scope (§8). Until rollout completes, `/api/miser/stats` responses should carry a
static `note` field naming the known blind spots — one honest sentence beats an implied totality.

### 4.4 Placing E2/B1 — the C1 auto-tune advisor (held for this design, F27)

The advisor is **kept, and it is the system's optimisation layer**: nothing else in this
architecture tunes anything — everything above measures, publishes, and alerts. It is not made
redundant by this design; it is made *placeable* by it. Binding decisions (changing these later is
the expensive path Brad's addendum warns about):

1. **What it consumes — the published cost fact plus a read-only knob snapshot, nothing rawer.**
   *(R2: v1 said "cost facts only, no config reference," but the recommendation record in item 4
   must carry current knob values, and those live in config/env parsing — `trigger`/`clearAtLeast`
   are validated and wired into `context_management` by `parseContextEditProjects` /
   `buildContextManagement`, `context-management.js:70,98-104`. As written, AC-18 was
   unimplementable. Resolved: the advisor gets a **read-only config snapshot**, not a config
   dependency.)* Two inputs, exactly:
   - E3's durable per-project/per-panel history and weekly buckets (`applied_edits` records +
     post-clear cache-write costs) read through the stats interfaces under the E3 authority
     contract — never a private parse of `~/.miser-stats.json`, never its own accumulation. That
     makes it the first full consumer of the cost artifact and a proof of the seam.
   - A **frozen knob-values snapshot**: at compose time, `buildServerDeps` captures the
     already-parsed per-project knobs (`trigger`, `clearAtLeast`, `keep`, `excludeTools` — the
     output of `parseContextEditProjects`, `context-management.js:70`) into a deep-frozen plain
     object and injects that *data* into the advisor. Knobs change only via env override + restart
     (F23's gate), so a process-lifetime snapshot is exact for the process's lifetime, and the
     advisor holds values, not a handle — it structurally cannot reach the live config object.
   It does **not** consume `context-facts.json`: C1 knobs are a cache-mechanics question that
   E3's cost history fully determines; coupling the advisor to the fullness artifact would widen
   its input surface for no recommendation it could not already make. If a future advisor wants
   rotation-aware tuning, that is a new proposal against the facts file — not scope creep into
   this one.
2. **Authority gates recommendations (P7 applied to the optimiser).** A recommendation computed
   from a `degraded` or incomplete window (E3 semantics: any expected day key missing, persistence
   unhealthy, or — per §4.3.3 — fallback-priced spend in window) is **withheld**, and the advisor
   says so: `{"recommendation": null, "reason": "input-degraded", "degraded_reasons": [...]}` is a
   recorded, published outcome. An optimiser that tunes live knobs from reconstructed data is the
   briefing's failure mode with a steering wheel.
3. **Where it runs and how "advisory-only" becomes structural.** Inside miser as a timer-driven
   module (off the request path, P5; no new daemon), composed via G7's `buildServerDeps` — and its
   injected dependency surface contains exactly three things: **read-only** stats access, the
   **frozen knob snapshot** (plain data, per item 1), and a recommendations sink. No live-config
   reference, no env access, no file-write capability beyond the sink. "Structurally impossible to
   mutate live config" (Brad's gate, F27) is then a property of the wiring visible in one file,
   enforceable by a test that enumerates the dependency object and asserts the snapshot is frozen
   — not a code-review promise.
4. **What it emits — a recorded artifact, same rules as every other fact.** Recommendations are
   appended durably (E3 persistence pattern) with full provenance: input window, authority state of
   that window, current knob values (copied from the injected snapshot, item 1), recommended
   values, and the price-table pin date in force.
   Exposed read-only (e.g. `/api/miser/advisor/recommendations`). A human applies a recommendation
   via the existing env-override + restart mechanism (`miser-switches-{on,off}.sh` pattern,
   ROTATION-SPEC §5.1 — proven byte-identical revert), which keeps every applied change
   Brad-gated, reversible, and attributable to the recommendation that motivated it.
5. **Sequencing:** E2/B1 builds after this design's Phase 3 (it needs the pricing fixes — tuning
   cache economics with fable-5/sonnet-5 mis-priced would optimise against wrong dollars) and after
   E3 has accumulated at least one fully-authoritative week per target project (its own model's
   definition of a trustworthy input).

### 4.5 Component verdicts

| Component | Verdict | Rationale / change |
|---|---|---|
| `miser` proxy | **Keep — cost authority.** | Changes limited to pricing entries + unpriced-model loudness (restart-bearing; Brad's go required, F23). Explicitly NOT the fullness authority (§2.3). Never manages panel lifecycle (ROTATION-SPEC §4). |
| `orch-token-watchdog.py` | **Keep — becomes the fullness producer.** | Its measurement/ceiling logic *moves* into `orch_context_core.py`; the script keeps enforcement/rotation and gains facts-file publication + reconciliation + ledger maintenance. |
| `orch-token-gauge.py` | **Keep the CLI; delete its brain.** | Private `MODEL_WINDOWS`/threshold tables (F5) deleted; becomes a **pure reader of facts, with no fallback path of any kind** *(R2: v1 allowed a direct core-library fallback on stale facts; that contradicted §4.2.2/AC-5 and P6 — resolved in favour of hard-fail)*. On stale/mismatched facts the gauge prints `STALE`/schema error and exits nonzero, full stop; a stale gauge IS the loud signal that the producer is down (D1/D2 catch it within one stack-health tick). Diagnosing while the producer is down is a human act against `orch_context_core.py` directly, not a gauge mode. It is Brad-facing 4×/day via gauge-check-report and is wrong today; this is the highest-visibility payoff. |
| TermDeck `context-meter.js` | **Keep untouched (Josh's).** | Defined role: raw reader + display. Gains a notify at each panel's true hard line via `meta.maxContextK` publication (§4.2.4 — enforcement seam, NOT the header band; band correctness awaits the Josh FR); made safe via reconciliation (§4.2.5). |
| Rotation policy in CLAUDE.md | **Keep shape, delete copied numbers.** | Rewritten per §4.2.6 to point at the artifact. |
| Session archive | **Keep byte-for-byte.** | Correct by design (F20). Gains external detection only: stack-health freshness check on `archive.log` (§5), because its ALARM lines currently go to a log nobody reads — the same silence it was built to fight. Also: it is what makes ledger history survivable. |
| `nacho-orch-monitor.sh` | **DELETE** (finish the retirement). | Already unscheduled (F18); remove from `~/bin` (`.bak` retained). Its two jobs are covered: thresholds by the facts file, alerting by the watchdog's pkachu path. |
| `orch-context-monitor.py` | **DELETE — script AND its doc role, in the same change.** | Broken since ~2026-07-07 by log-format drift, zero *runtime* consumers of its CSV (F19) — the same disease as F18, caught by this sprint's audit rather than by any alarm, which is itself evidence for P2. But it has a live *documentation* consumer: `ORCH-LANES.md:79` still assigns it the fleet-rollup role (F19), so deleting only the file would leave the ops doc directing an operator at a ghost. The deletion therefore includes, in the same change: re-pointing the `ORCH-LANES.md:79` fleet-rollup entry at the facts file (`context-facts.json`, read via the gauge/`jq`) and updating the drift note at `:86`. AC-14 verifies both. `.bak` retained. |
| `gauge-check-report.sh` | **Keep.** | Pure consumer; becomes correct when the gauge does. Note: no scheduler found for it on 2026-07-29 (crontab + systemd searched) — builder must confirm intended cadence with NACHO-ORCH and re-schedule or retire; a report script that never runs is one more silent monitor. |
| miser B6 `maxContextTokens=400K` (F22) | **Keep as-is, demoted in role.** | Alert-only, independent code path, zero cost. Documented honestly: for panels with ceilings below 400K it never fires and is NOT their safety net. Not wired to the facts file in this sprint — coupling the hot-path service to an external file for marginal alert precision fails the P5 smell test. Revisit only if evidence demands. |
| `builder-status-monitor.sh` | **Out of scope.** | Sprint-progress monitor, not part of the token program. Flagged to NACHO-ORCH separately: it also has no scheduler today. |
| E2/B1 advisor (unstarted) | **Keep — build per §4.4, after Phase 3.** | The optimisation layer. Consumes only E3's cost artifact under its authority contract; advisory-only made structural via the G7 dependency surface; bound by AC-18. |

---

## 5. How it fails, and how failure is detected

Design rule (P4): every row must name a *detection* and an *announcement channel*. "Logged" alone is
not an announcement — that convention is what buried F19 and the archive alarms.

| # | Failure | Detected by | Announced via |
|---|---|---|---|
| D1 | Watchdog stops running / crashes → facts file goes stale | `stack-health.py` (existing 30-min timer, F21) gains a check: `context-facts.json` `generated_at` older than 15 min ⇒ alarm | stack-health's existing alert post path |
| D2 | Facts file stale but a consumer runs anyway | Every consumer checks `generated_at` itself (P2) | Consumer prints `STALE`, exits nonzero; gauge-check relays that text to the alerts chat |
| D3 | Schema drift (producer upgraded, consumer not) | `schema` field mismatch ⇒ consumer hard-fails with explicit message — never best-effort parse (the F18/F19 disease) | Same as D2 |
| D4 | Ceiling stale-low (F6, live today) | Ledger invalidation rule: reading > effective_ceiling×1.05 without compaction | Watchdog batched pkachu report (existing channel + 30-min dedup) |
| D5 | Ceiling missing (fresh panel) | `ceiling_source` field is explicit (`ledger`/`model-cap`); never silently pretends to be measured | Visible in facts + gauge output; F17's "unverified ladder" case is now a labeled state, not a footnote |
| D6 | Transcript misattribution | Meta-first resolution shrinks the class; surviving cases still hit the existing `panel_ctx_impossible` guard + page (watchdog `:1218-1238`, kept) | Existing impossible-reading page |
| D7 | Two readers diverge (TermDeck vs core) | Reconciliation field `divergence_pct` >20% twice consecutively | Watchdog batched pkachu report |
| D8 | New model mis-costed via `*` | `unpriced_models` counter (§4.3.3) | Daily-rollup alert + `/metrics` gauge + visible in `/api/miser/stats` |
| D9 | Pricing table wrong (vs docs) | Cannot be machine-detected (docs aren't an API). Mitigation: pinned-source header convention + this sprint's rule that every entry cites URL+date; drift review folds into the existing `stack-upgrade` runbook window | Human review; explicitly a known residual risk |
| D10 | Archive silently failing | stack-health check: last `ok` line in `archive.log` older than 2h (timer is hourly) | stack-health alert post |
| D11 | Facts producer writes garbage (partial JSON) | Atomic write makes torn files impossible; consumers additionally treat unparseable JSON identically to D3 | Same as D2/D3 |
| D12 | miser down entirely | Already covered: `stack-health.check_miser` (F21) + systemd `Restart=on-failure` | Existing |

---

## 6. Acceptance criteria — numbered, each with its oracle

Format: **AC — criterion. *Oracle:* how an auditor proves it.** All tests live beside the code they
test (watchdog tests already exist: `~/bin/test_watchdog_guards.py` — same convention). Anything
needing a running miser uses a **dev instance on a non-live port**; nothing tests against `:20128`
(F23).

**AC-1 (P1, single implementation).** After the build, exactly one file under `~/bin` and zero files
elsewhere in our tree define a model-window table or rotation-threshold constants.
*Oracle:* `grep -rln 'MODEL_WINDOWS\|NUDGE_TARGET\|ROTATE_TARGET_OPUS\|HARD_ROTATE\|OPUS_WINDOW_FLOOR' ~/bin/*.py` → only `orch_context_core.py` (backup `.bak-*` files excluded); the same grep over
`~/.claude/CLAUDE.md` finds only the pointer sentence, no standalone ladder table with token values
(see AC-15).

**AC-2 (identical readings).** Watchdog and gauge, run against the same fixture transcript set,
report identical `context_tokens`, ceiling fields (`observed_ceiling`/`prior_ceiling`/basis), and
all three targets, for ≥3 fixtures
including: (a) a real archived transcript containing the 217K compaction (source: session archive,
F20), (b) a sidechain-heavy transcript, (c) a fresh no-compaction transcript.
*Oracle:* pytest comparing both code paths' structured output field-by-field; fixture (a)'s expected
peak asserted against the value independently computable by `observed_ceiling()` from the raw file.

**AC-3 (facts published).** With the timer running, `context-facts.json` exists, `schema==1`,
`generated_at` ≤ 10 min old, and contains one entry per TermDeck session whose label contains
`ORCH`, each with all fields of §4.2.2 present (including `error` entries for unmeasurable panels).
*Oracle:* live `jq` inspection after two timer ticks; field checklist scripted in the test suite.

**AC-4 (schema hard-fail).** A consumer handed a facts file with `schema: 2` refuses to emit any
panel numbers, prints an explicit schema-mismatch error, exits nonzero.
*Oracle:* unit test with a doctored fixture file.

**AC-5 (staleness loud).** A consumer handed a facts file with `generated_at` 20 min old emits
`STALE` (exact token in output) and exits nonzero; gauge in this state must NOT print percentage
values as if current.
*Oracle:* unit test with a doctored fixture file.

**AC-6 (gauge is a consumer — with no fallback path).** A gauge run opens zero `*.jsonl`
transcripts in **every** state — fresh facts, stale facts (AC-5's doctored fixture), and missing
facts file — because no direct-read fallback exists (§4.5, R2 resolution of the P6 contradiction).
With fresh facts, its printed pct/thresholds match the facts file exactly.
*Oracle:* `strace -f -e openat python3 ~/bin/orch-token-gauge.py` filtered for `.jsonl` → empty,
run once per state; diff of printed values vs `jq` of the facts file.

**AC-7 (ledger learns).** Processing fixture (a) from AC-2 appends a ledger entry `{model, peak, ts}`
whose peak equals the fixture's known pre-compaction peak; a second run does not duplicate it.
*Oracle:* pytest; idempotency asserted by entry count.

**AC-8 (priors are labeled, never impersonate observations — P7).** A fresh-panel fixture (no
compaction of its own) with fleet ledger entries for its model yields: `observed_ceiling: null`,
`prior_ceiling` = min recent fleet peak, `prior_source: "fleet-min"`, triggers derived from the
prior, `pct_basis: "prior"`, `authoritative: false` with reason `ceiling-is-prior`. At no point does
any output field present the fleet value as this panel's observed ceiling.
*Oracle:* pytest asserting every listed field, including the null.

**AC-9 (supersession-by-survival — the F6 case).** A fixture whose live reading exceeds its own
compaction-derived ceiling ×1.05 with no compaction drop: (a) appends a *survival* observation to
the ledger, (b) marks the compaction bound superseded, (c) drops the panel to prior-based triggers
with `authoritative: false`, and (d) emits an announcement line destined for the batched report.
*Oracle:* pytest replaying the actual F6 sequence (NACHO-ORCH 217K observed ceiling, 347K live
reading, taken from the real archived transcript); assert no `PAST HARD` page is generated for the
replayed state, and assert the survival event is present and durable across a second run.

**AC-10 (reconciliation).** Given mocked session meta where `contextK` diverges >20% from the core
reading on two consecutive scans, the facts entry carries `divergence_pct` and the batched report
gains one line; at ≤20% or a single occurrence, it does not.
*Oracle:* pytest with mocked TermDeck client (pattern already used by `test_watchdog_guards.py`).

**AC-11 (pricing entries, docs-conditional).** *(R2 rewrite: v1 simultaneously required
non-fallback entries unconditionally AND accepted absence-plus-AC-12 — contradictory. One rule
now, branched on recorded evidence.)* For each of `claude-opus-5`, `claude-sonnet-5`,
`claude-fable-5`, the build must match **Phase-0 V3's recorded docs finding** (URL + check date +
per-model listed/absent — a required build-sprint artifact):
  - **(a) V3 recorded the model listed on the pinned docs page** ⇒ `priceForModel(<model>)` returns
    a non-fallback entry whose values equal the docs values, with URL + pin date cited in the
    `DEFAULT_PRICING` header.
  - **(b) V3 recorded it absent** ⇒ NO `DEFAULT_PRICING` entry exists for it — no invented numbers
    (F3) — and the model is covered by AC-12 loudness instead. (Exception already designed in
    §4.3.2: a model carrying the documented `ASSUMED` env override — today only opus-5, F12 —
    keeps that override, stays priced-as-assumed, and is not counted unpriced; the override
    comment must carry the ASSUMED label.)
  In both branches: **no entry's values may be traceable to our own policy numbers** (F3's oracle:
  the file must contain no value derived from 400K or any rotation constant).
*Oracle:* unit test reads the V3 record and asserts branch (a) models return non-fallback with no
`console.warn` and branch (b) models are absent from the table; human gate: Codex INVERSION-QA
checks the V3 record itself against the named docs page.

**AC-12 (unknown model is loud; hot path untouched; guard-clean).** On a dev miser instance (built
on the E3+G7 base): one request with model `claude-test-unknown` → `/api/miser/stats` shows
`unpriced_models` counting it **exactly once** under the observed day key, the affected window
carries E3's `degraded` flag with reason `unpriced-models`, `/metrics` exposes the gauge, and the
rollup alert fires on the next rollup tick. **Read idempotency (the §4.3.3 seam choice made
testable): repeated reads of `/api/miser/stats`, `/metrics`, and the rollup do not change the
count — only a recorded response does.** The request itself still succeeds (fail-open, F23). No new
synchronous file I/O appears in the request path. All new dependencies enter via `buildServerDeps`
(F26), and the whole miser test suite — including these additions — passes under G7's live-state
guard (no test path resolving to a `$HOME` default).
*Oracle:* scripted curl sequence against the dev port; code-review checklist item for the I/O and
seam claims; `node --test` green with the guard active.

**AC-13 (TermDeck untouched + seam armed safely + claims honest).** *(R2 rewrite: v1's AC never
tested the claimed visibility effect; the claim itself was wrong — §4.2.4. The AC now verifies what
the redesigned section actually claims.)* (a) `sha256sum` manifest of `@jhizzard/termdeck` tree
identical before/after the build sprint. (b) If Phase-0 V2 passes: live sessions show
`meta.maxContextK` equal to their published `hard_at/1000` and `contextAction` absent/`notify`;
TermDeck logs contain zero kill-action events attributable to it; and **the notify demonstrably
fires at the published line** — a controlled test session with a deliberately low published
`maxContextK` (below its current reading) produces TermDeck's notify, proving enforcement is
evaluated against the per-session value. (c) **No artifact produced by this system claims the
TermDeck header band is per-panel-correct**: the CLAUDE.md rewrite (AC-15 scope) states the band
remains global-350/400 pending the Josh FR. (d) The Josh FR for per-session `warnK`/`overK` meta
overrides exists **unconditionally** (filed in the termdeck-updates lane regardless of V2's
outcome). (e) If V2 fails: no `meta.maxContextK` is published anywhere.
*Oracle:* (a) checksum diff; (b) `curl /api/sessions | jq` + TermDeck log grep over 48h + the
controlled-notify test transcript; (c) doc grep for band-correctness claims; (d) FR artifact in the
termdeck-updates lane; (e) `jq` over live session meta.

**AC-14 (deletions — runtime AND doc consumers).** *(R2: extended per IQA finding 6 — v1 checked
only `ls`/crontab/systemd and missed that `ORCH-LANES.md:79` still assigns `orch-context-monitor.py`
the fleet-rollup role, F19.)* (a) `nacho-orch-monitor.sh` and `orch-context-monitor.py` are absent
from `~/bin` (timestamped `.bak` retained); no crontab or systemd unit references either. (b) No
operational document still directs an operator to either script: `~/sprints/ORCH-LANES.md`,
`~/.claude/CLAUDE.md`, `/home/nacho/CLAUDE.md`, and `~/.claude/runbooks/` contain zero references
to them outside explicitly historical context (changelogs/audit records), and the `ORCH-LANES.md:79`
fleet-rollup entry names the facts file (`context-facts.json`) in their place, with the drift note
at `:86` updated in the same change.
*Oracle:* `ls` + `crontab -l | grep` + `grep -r ~/.config/systemd/user/` + `grep -rn` over the four
doc locations with each hit classified live-instruction vs historical; the ORCH-LANES diff is part
of the build sprint's reviewed change.

**AC-15 (policy points, doesn't copy).** The CLAUDE.md rotation section (and
`/home/nacho/CLAUDE.md`'s self-monitoring section) instructs reading per-panel numbers from the
watchdog line / facts file, names `orch_context_core.py` as the constants' home, and contains no
free-standing threshold table with token values; the 2026-07-28 ceiling-warning paragraph is
subsumed.
*Oracle:* doc grep per AC-1 + Codex reads the diff for semantic equivalence with the Brad-approved
ladder (shape preserved, numbers referenced).

**AC-16 (freshness nets live).** `stack-health.py` gains the two checks (facts-file age, archive-log
age) and both demonstrably fire: doctor each input in a controlled way (backdate a copy in a test
invocation — never touch the live archive) and observe the alarm text.
*Oracle:* unit-level invocation of the two check functions with doctored paths; presence of both
checks in the live 30-min run's output.

**AC-17 (no fullness regression during migration).** For every panel measurable today, the new
pipeline's `context_tokens` differs from the pre-migration watchdog's reading by 0 (same algorithm,
moved not rewritten), demonstrated by a side-by-side run on the same live transcripts before the old
path is removed.
*Oracle:* one-shot comparison script output attached to the build sprint's STATUS.md; any nonzero
diff is a blocking finding.

**AC-18 (E2/B1 contract — binds the advisor's build sprint, stated here because placement is this
design's deliverable).** (a) The advisor's injected dependency object contains exactly: read-only
stats access, the frozen knob-values snapshot (plain data — `Object.isFrozen` true, deep; mutation
attempts fail), and the recommendations sink — and **no reference to live config objects, no env
access, no write capability other than the sink** — asserted by a test that enumerates the
dependency surface and one that verifies the snapshot's values equal the composed config's knobs at
build time (`parseContextEditProjects` output, `context-management.js:70`) while sharing no object
identity with it. (b) Given a fixture window that E3 marks `degraded` (or containing unpriced-model
spend per AC-12), the advisor publishes a withheld-recommendation record with reasons, and no
recommended values. (c) Every published recommendation record carries input-window identifiers,
that window's authority state, current knob values copied from the injected snapshot, recommended
values, and the pricing pin date.
*Oracle:* pytest/node-test in the E2/B1 sprint; the Codex gate for that sprint must check this AC
against this document.

---

## 7. Migration — the system is live

Ordered so every phase is independently shippable and reversible; the only restart-bearing step is
isolated and gated on Brad.

**Phase 0 — verification spikes (read-only, no changes).**
- **V1:** Does TermDeck session meta expose the panel's transcript path (which of the four key names
  probed at watchdog `:413-420` actually exists)? → determines `resolve_transcript` precedence.
- **V2:** Does a PATCHed `meta.maxContextK` persist across meter ticks, and does it produce
  **notify-only enforcement and nothing else** — no kill path armed with `contextAction` unset, no
  effect on the header band (per F8 it feeds `evaluateEnforcement`, not `classifyContext` — confirm
  observed behaviour matches the read of the code)? (Watchdog PATCHes other keys durably, F9, so
  persistence expectation is yes — verify, don't assume.)
- **V3:** Anthropic pricing docs checked for opus-5/sonnet-5/fable-5 entries; findings recorded
  per-model (listed/absent) with URL + date as a build-sprint artifact — this record is the branch
  condition AC-11 tests against.

**Phase 1 — core library + facts publication (additive only).** Extract logic into
`orch_context_core.py`; watchdog imports it and additionally writes the facts file + ledger +
reconciliation fields. Old gauge untouched. *Wrong-during-transition:* gauge still reports its
current wrong numbers — no worse than today. *Rollback:* restore watchdog from timestamped `.bak`
(the existing convention — nine such baks exist for this file already); delete the two JSON
artifacts; nothing consumed them yet.

**Phase 2 — consumers cut over.** Gauge rewritten as reader (AC-5/6); gauge-check-report rescheduled
or retired per its owner's call; stack-health checks added; CLAUDE.md rewritten (AC-15); TermDeck
meta publication enabled iff V2 passed. *Wrong-during-transition:* a stale-facts window makes the
gauge say STALE rather than a number — loud beats wrong, per P6. *Rollback:* per-file `.bak`
restore; each consumer is independent.

**Phase 3 — miser pricing (the only restart, Brad-gated per F23; sequenced behind E3+G7).** This
phase branches from the E3+G7 base (IN-FLIGHT-CONTEXT.md §sequencing) — if either has not merged
when Phase 3 is ready, Phase 3 **waits**; it must not create a third in-flight branch racing them.
Pricing entries + unpriced-model loudness land wired through `buildServerDeps` (F26) and surfaced
through E3's authority contract (F25), tested on a dev-port instance under the live-state guard,
then one systemd restart with Brad's explicit go (drops in-flight requests for all panels —
ROTATION-SPEC §5 documents the blast radius; schedule at an idle window; natural bundling candidate:
the same restart that ships E3+G7 to the live service, so the fleet eats one interruption, not
three — Brad's call). *Wrong-during-transition:* until restart, sonnet-5/fable-5 stay mis-costed
exactly as today. *Rollback:* revert commit + one more restart; the switches-off script pattern
(`~/td-updates/ops/miser-switches-off.sh`, byte-identical revert proven per ROTATION-SPEC §5.1) is
the model.

**Phase 5 — E2/B1 advisor build (its own sprint, after Phase 3).** Per §4.4.5: needs corrected
pricing and ≥1 fully-authoritative E3 week per target project before its recommendations mean
anything. Bound by AC-18.

**Phase 4 — coverage rollout (piggybacks on natural panel lifecycle, no forced respawns).** Builder
spawn templates gain `ANTHROPIC_BASE_URL` with `--<role>` suffixes (F24); remaining bare-project
cwds gain `/p/<project>` segments. Lands per panel at its next natural spawn — consistent with the
model/effort launch-binding rule in CLAUDE.md.

**Deletions (any time after Phase 1):** the two monitor scripts, per AC-14.

---

## 8. Deliberately NOT doing

1. **`stats.js` sync-load-at-import / file-size-guard / unbounded-growth** — tracked for its own
   sprint per the briefing (E3 delivered durability and per-panel history, F25, which supersedes the
   first draft's assumption that panel-stats persistence was still open; the load/growth guards
   remain the deferred item). This design doesn't worsen it: the facts/ledger artifacts live outside
   miser, and §4.3.3's counters follow E3's existing recording pattern rather than adding a new
   store.
2. **Codex / OpenAI-side cost capture** (F14). Real blind spot, honestly labeled in the stats note
   (§4.3.4) instead of half-solved here. MODEL-LEDGER.md's file-derived proxies remain the interim
   answer for the Claude:Codex split.
3. **Changing TermDeck code.** Hard constraint; the design is complete without it (§4.2.4 — the
   only capability that genuinely needs a TermDeck change, a per-panel-correct header band, is
   handed to the unconditional Josh FR, not designed around).
4. **miser-driven rotation or any lifecycle control from the proxy.** ROTATION-SPEC §4's rule stands:
   the proxy measures and alerts; the watchdog acts; the orch judges.
5. **Real-time (<5 min) fullness.** The money is in rotation decisions at task boundaries (F16), a
   minutes-scale phenomenon; TermDeck's meter already covers the seconds-scale display. A faster
   producer buys nothing and adds a daemon (violates P5).
6. **Hand re-pricing historical dollar figures.** Read-time pricing self-corrects history (§4.3.2);
   any manual rewrite of `~/.miser-stats.json` is prohibited — it's the cost fact's ground truth.
7. **Unifying the B6 400K policy alert with the facts file** — considered and rejected this round
   (§4.4, coupling the hot-path service to an external artifact for marginal precision). Re-open only
   with evidence that its coarseness caused a miss that the watchdog layer also missed.
8. **Multi-host generality.** Everything here is R730-local by construction; making it portable is
   speculative work with no current consumer.

---

## 9. Open items for the gate

- **For Codex INVERSION-QA:** AC-11's docs-check is a human-gate item — the auditor should attack
  it hardest; it is the one AC whose oracle cannot be fully automated (D9). Also attack §4.2.2/4.2.3
  for any spot where a prior can still masquerade as an observation (P7 is the design's load-bearing
  claim), and §4.4 for whether the advisor's input surface is genuinely sufficient without the
  fullness artifact.
- **Branch-drift caveat:** E3 (`4eb5656`) and G7 (`e5fc8fd`) are cited at their HEADs as of
  2026-08-01 (R2 re-verification; v1 cited E3 at `e8c059b` — one commit of drift, injectable-clock
  fix, no interface change; seam names and authority fields confirmed at the new tip, F25/F26);
  both are pre-merge. If either changes shape before the build sprint (G7 is awaiting re-audit),
  the build sprint re-verifies the seam names (`buildServerDeps`, authority field names) against
  what actually merged — this document's *decisions* survive a rename; its identifiers might not.
- **For Brad (with the build sprint's AWAITING-APPROVAL, not now):** the Phase-3 restart window; and
  confirmation that `gauge-check-report.sh`'s 4×-daily cadence is still wanted (§4.4).
- **For termdeck-updates-ORCH (its lane, not ours):** the Josh feature request for per-session
  `warnK`/`overK` meta overrides — filed unconditionally (§4.2.4, AC-13d).

*Numbers cited in this document trace to: the named source files at the quoted line ranges (read
2026-07-29; every citation re-read 2026-08-01 for R2, with drifted line numbers corrected),
`ROTATION-STRATEGY-SPEC.md` (Brad-approved 2026-07-27), the briefing's on-host
2026-07-28 evidence, live `curl`/`jq`/log observations timestamped 2026-07-29, and the Anthropic
pricing docs as pinned in `pricing.js:3-4`. No window, price, or threshold in this proposal was
back-derived from policy.*
