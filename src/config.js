'use strict';

const { parseContextEditProjects } = require('./context-management.js');
const { parseBudgets, parseBudgetGrace } = require('./budgets.js');
const { parsePolicy } = require('./policy-watchdog.js');
const { parseAlertRoutes, parseOpsRoute } = require('./alert-routes.js');
const { parseStopgapWatchdogEnv } = require('./stopgap-watchdog.js');
const { parseEnforcement } = require('./enforcement.js');
const { parseWatchConfig } = require('./watchd.js');

// B4 startup guard: refuse to start if any configured project name contains '--'
// (which collides with the panel routing grammar). Exported for unit tests so
// tests can call it with a fake config object without importing index.js.
function validateStartupConfig(cfg) {
  const maps = [
    ['budgets',             cfg.budgets],
    ['policy',              cfg.policy],
    ['contextEditProjects', cfg.contextEditProjects],
    ['toolAllowlists',      cfg.toolAllowlists],
    ['enforcement',         cfg.enforcement],
    // MISER_ALERT_ROUTES inherits the '--' collision fatal from the shared
    // contract (§1.5) via this row — not re-implemented in alert-routes.js.
    ['alertRoutes',         cfg.alertRoutes && cfg.alertRoutes.entries],
  ];
  for (const [label, map] of maps) {
    if (!map || typeof map !== 'object') continue;
    for (const name of Object.keys(map)) {
      if (label === 'enforcement' && name === '*') continue;
      if (name.includes('--')) {
        throw new Error(
          `[miser] fatal: ${label} config contains project name "${name}" ` +
          `with "--" separator — this collides with the B4 panel routing grammar. ` +
          `Rename the project or remove the config entry.`
        );
      }
    }
  }
  for (const name of (cfg.budgetGrace || [])) {
    if (typeof name === 'string' && name.includes('--')) {
      throw new Error(
        `[miser] fatal: budgetGrace config contains project name "${name}" ` +
        `with "--" separator — this collides with the B4 panel routing grammar. ` +
        `Rename the project or remove the config entry.`
      );
    }
  }
}

const contextEditConfig = parseContextEditProjects(process.env.MISER_CONTEXT_EDIT_PROJECTS || '');

module.exports = {
  port: parseInt(process.env.MISER_PORT || '20128', 10),
  // compress() v2 is LOSSLESS: no size/token ceiling gates the primary forward
  // path. The old blind 32K turn-truncation ceiling is GONE — no config key
  // remains that could reintroduce an arbitrary primary-path token ceiling.
  ollamaUrl: process.env.MISER_OLLAMA_URL || 'http://127.0.0.1:11435',
  fallbackModels: (process.env.MISER_FALLBACK_MODELS || 'qwen2.5-coder:14b,qwen2.5:7b,qwen2.5:3b').split(','),
  // Anthropic upstream base URL. Authoritative field (router parses host/path
  // from it) — enables the AC10 loopback-echo canary + offline testability.
  anthropicUrl: process.env.MISER_ANTHROPIC_URL || 'https://api.anthropic.com',
  // v3: always-on system-only cache breakpoint (AC5). Explicit false-ish env
  // values remain an emergency override.
  cacheHint: !/^(0|false|off|no)$/i.test(process.env.MISER_CACHE_HINT || ''),
  // Per-project tool allowlists for Tier-A tool pruning (v3).
  // Format: JSON map { "<project>": ["tool1", "tool2", ...] }
  // Loaded from MISER_TOOL_ALLOWLISTS env var (JSON string) or empty.
  // If missing/unparseable -> empty map -> pruning is NO-OP for all projects.
  toolAllowlists: (() => {
    try {
      const raw = process.env.MISER_TOOL_ALLOWLISTS || '{}';
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      return {};
    } catch (_) { return {}; }
  })(),
  // Tier B opt-in flags (default OFF; no behavior is wired in v3).
  tierB: {
    toolSchemaCompress: /^(1|true|on|yes)$/i.test(process.env.MISER_TIER_B_SCHEMA_COMPRESS || ''),
    toolOutputTrim: /^(1|true|on|yes)$/i.test(process.env.MISER_TIER_B_OUTPUT_TRIM || ''),
  },
  compactHintUrgentFraction: parseFloat(process.env.COMPACT_HINT_URGENT_FRACTION ?? '0.70'),
  compactHintRecommendFraction: parseFloat(process.env.COMPACT_HINT_RECOMMEND_FRACTION ?? '0.40'),
  contextEditProjects: contextEditConfig.projects,
  // Sprint B guardrails (fail-closed-to-OFF: null ↔ feature fully OFF).
  // G3 per-project daily USD budget caps + grace list; B6 policy watchdog.
  // Parsers warn at startup only when the relevant env var is actually set.
  budgets: parseBudgets(process.env.MISER_BUDGETS || ''),
  budgetGrace: parseBudgetGrace(process.env.MISER_BUDGET_GRACE || ''),
  policy: parsePolicy(process.env.MISER_POLICY || ''),
  enforcement: parseEnforcement(process.env.MISER_ENFORCEMENT || ''),
  weightedTokenWeights: {
    input: parseFloat(process.env.MISER_WEIGHT_INPUT ?? '1.0'),
    cacheRead: parseFloat(process.env.MISER_WEIGHT_CACHE_READ ?? '0.1'),
    cacheWrite5m: parseFloat(process.env.MISER_WEIGHT_CACHE_WRITE_5M ?? '1.25'),
    cacheWrite1h: parseFloat(process.env.MISER_WEIGHT_CACHE_WRITE_1H ?? '2.0'),
    output: parseFloat(process.env.MISER_WEIGHT_OUTPUT ?? '5.0'),
  },
  // Per-exact-model-ID context windows (mirrors the fleet's independently
  // maintained truth table in ~/bin/orch-token-gauge.py / orch-token-watchdog.py).
  // Window size varies WITHIN the sonnet/opus prefix families by generation —
  // a broad 'claude-sonnet'/'claude-opus' prefix silently mislabels newer
  // releases, e.g. sonnet-5 is a 1M-context model but a bare 'claude-sonnet'
  // prefix would cap it at 200K. Matched by modelWindow() via startsWith(), so
  // entries whose id is a prefix of another entry's id MUST be listed after
  // the more specific (longer) one — see 'claude-haiku-4-5-20251001' vs
  // 'claude-haiku-4-5' below. Unmatched models fall through to the
  // modelWindow() default (200_000, matching the fleet scripts' default —
  // the safe/conservative assumption for a genuinely unknown model ID).
  modelWindows: {
    'claude-haiku-4-5-20251001': 200_000,
    'claude-haiku-4-5': 200_000,
    'claude-opus-4-8': 1_000_000,
    'claude-opus-4-7': 1_000_000,
    'claude-opus-4-6': 1_000_000,
    'claude-opus-4-5': 200_000,
    'claude-opus-5': 1_000_000,
    'claude-sonnet-4-6': 1_000_000,
    'claude-sonnet-4-5': 200_000,
    'claude-sonnet-5': 1_000_000,
    'claude-fable-5': 1_000_000,
    'claude-3-7-sonnet': 200_000,
    'gpt': 128_000,
  },
  // Hard cap (rough tokens) applied to the Ollama fallback leg so a
  // double-fallback (Anthropic 429 → Codex fail → Ollama) can never ship an
  // over-context payload to the local model. This gates ONLY the degraded
  // failover leg (out of scope for the compress redesign), never the primary
  // Anthropic/OpenAI forward path.
  ollamaHardCap: parseInt(process.env.MISER_OLLAMA_HARD_CAP || '32000', 10),
  // Max generation tokens (num_predict) the Ollama fallback may request. A
  // passed-through Anthropic max_tokens can be huge; the local model's context
  // is shared between prompt and output, so the fallback clamps generation too.
  ollamaMaxPredict: parseInt(process.env.MISER_OLLAMA_MAX_PREDICT || '4096', 10),
  // Codex subscription failover endpoint for the Anthropic-429 fallover.
  // Brad-chosen (2026-07-11): the ChatGPT Codex backend `responses` API, which
  // is where the subscription OAuth token actually authenticates. Offline tests
  // mock this transport entirely; no live cutover happens without approval.
  codexUrl: process.env.MISER_CODEX_URL || 'https://chatgpt.com/backend-api/codex/responses',
  // Wire format for the Codex leg: 'responses' (Codex backend, OAuth) or 'chat'
  // (OpenAI chat/completions, needs an API key). Default 'responses'.
  codexFormat: process.env.MISER_CODEX_FORMAT || 'responses',
  // Codex client-identity headers. PINNED from a live capture of the real codex
  // 0.144 HTTPS request to /backend-api/codex/responses (2026-07-11): the real
  // request sends authorization + chatgpt-account-id + accept:text/event-stream
  // + content-type:application/json + originator + user-agent + version. It does
  // NOT send an `openai-beta` header (my earlier assumption — removed). The
  // x-codex-* / session-id / thread-id headers are per-codex-session bookkeeping
  // that miser has no equivalent for and omits; whether the backend REQUIRES
  // them is the one thing a minimal-request live probe still needs to confirm
  // before cutover.
  codexOriginator: process.env.MISER_CODEX_ORIGINATOR || 'codex_cli_rs',
  codexUserAgent: process.env.MISER_CODEX_USER_AGENT || 'codex_cli_rs/0.144.1 (miser failover)',
  codexClientVersion: process.env.MISER_CODEX_VERSION || '0.144.1',
  // G4 pre-stream retry with jittered backoff
  retryMaxAttempts: parseInt(process.env.MISER_RETRY_MAX_ATTEMPTS || '3', 10),
  retryBaseMs:      parseInt(process.env.MISER_RETRY_BASE_MS      || '200', 10),
  // G4 per-upstream circuit breakers
  breakerThreshold: parseInt(process.env.MISER_BREAKER_THRESHOLD || '5', 10),
  breakerResetMs:   parseInt(process.env.MISER_BREAKER_RESET_MS  || '30000', 10),
  // B3 Codex subscription-cap intelligence (0 = feature OFF)
  codex5hCap:    parseInt(process.env.MISER_CODEX_5H_CAP    || '0', 10),
  codexWeeklyCap: parseInt(process.env.MISER_CODEX_WEEKLY_CAP || '0', 10),
  // B2 cache-thrash detector knobs (0 = feature OFF)
  cacheThrashSpikeRatio:      parseFloat(process.env.MISER_CACHE_THRASH_SPIKE_RATIO      ?? '3.0'),
  cacheThrashInputSpikeRatio: parseFloat(process.env.MISER_CACHE_THRASH_INPUT_SPIKE_RATIO ?? '2.0'),
  cacheThrashMinRequests:     parseInt(process.env.MISER_CACHE_THRASH_MIN_REQUESTS        || '10', 10),
  cacheThrashRingSize:        parseInt(process.env.MISER_CACHE_THRASH_RING_SIZE            || '50', 10),
  // Stopgap stuck-panel watchdog. OFF unless explicitly enabled because it can
  // inject into TermDeck panels.
  stopgapWatchdog: parseStopgapWatchdogEnv(process.env),
  // Zero-LLM watcher artifact writer. The proxy never schedules probes; the
  // sidecar CLI owns periodic execution, while the proxy exposes explicit
  // refresh for future redirect integration.
  watch: parseWatchConfig(process.env),
  // Alert routing (PROPOSAL §2.2-§2.5). null is the exclusive OFF signal.
  // parseAlertRoutes is PURE: it reads only the env object handed to it, which
  // is what lets defaultConfigured participate in the degraded decision (§2.3
  // cause 2) without a new env read. Malformed/unsafe entries are startup-fatal
  // (axis C); a merely MISSING entry is degraded, never fatal (axis D).
  alertRoutes: parseAlertRoutes(process.env, {
    budgets: parseBudgets(process.env.MISER_BUDGETS || ''),
    policy: parsePolicy(process.env.MISER_POLICY || ''),
    // pollRewriteProjects does not exist on main; it becomes live when E rebases
    // (§3.5) with zero further edits here.
    pollRewriteProjects: undefined,
    alertRoutesStrict: /^(1|true|on|yes)$/i.test(process.env.MISER_ALERT_ROUTES_STRICT || ''),
  }),
  // Fatal when SET and malformed/unsafe EVEN WHEN MISER_ALERT_ROUTES IS OFF
  // (§2.5) — see the operator warning there: this is the one fatal that fires
  // on a variable an operator may believe is inactive. Recovery: unset it.
  // Second arg is the failure-policy config (§2.3): parseOpsRoute asks the
  // table rather than hard-coding its own fatality, so malformed_ops is a real
  // table row and not a claim about one.
  alertRoutesOps: parseOpsRoute(process.env, {
    alertRoutesStrict: /^(1|true|on|yes)$/i.test(process.env.MISER_ALERT_ROUTES_STRICT || ''),
  }),
  alertRoutesStrict: /^(1|true|on|yes)$/i.test(process.env.MISER_ALERT_ROUTES_STRICT || ''),
  alertRoutesUnrouted: process.env.MISER_ALERT_ROUTES_UNROUTED || 'withhold',
  alertRoutesUnroutedMax: parseInt(process.env.MISER_ALERT_ROUTES_UNROUTED_MAX || '32', 10),
};

module.exports.validateStartupConfig = validateStartupConfig;
