'use strict';

const { parseContextEditProjects } = require('./context-management.js');
const { parseBudgets, parseBudgetGrace } = require('./budgets.js');
const { parsePolicy } = require('./policy-watchdog.js');

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
  weightedTokenWeights: {
    input: parseFloat(process.env.MISER_WEIGHT_INPUT ?? '1.0'),
    cacheRead: parseFloat(process.env.MISER_WEIGHT_CACHE_READ ?? '0.1'),
    cacheWrite5m: parseFloat(process.env.MISER_WEIGHT_CACHE_WRITE_5M ?? '1.25'),
    cacheWrite1h: parseFloat(process.env.MISER_WEIGHT_CACHE_WRITE_1H ?? '2.0'),
    output: parseFloat(process.env.MISER_WEIGHT_OUTPUT ?? '5.0'),
  },
  modelWindows: {
    'claude-opus': 1_000_000,
    'claude-sonnet': 200_000,
    'claude-haiku': 200_000,
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
};
