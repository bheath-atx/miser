'use strict';

module.exports = {
  port: parseInt(process.env.MISER_PORT || '20128', 10),
  compressionThreshold: parseInt(process.env.MISER_COMPRESSION_THRESHOLD || '32000', 10),
  ollamaUrl: process.env.MISER_OLLAMA_URL || 'http://127.0.0.1:11435',
  fallbackModels: (process.env.MISER_FALLBACK_MODELS || 'qwen2.5-coder:14b,qwen2.5:7b,qwen2.5:3b').split(','),
  anthropicUrl: 'https://api.anthropic.com',
  // Hard cap (rough tokens) applied to the Ollama fallback leg so a
  // double-fallback (Anthropic 429 → Codex fail → Ollama) can never ship an
  // over-context payload to the local model. Defaults to the compression
  // threshold.
  ollamaHardCap: parseInt(process.env.MISER_OLLAMA_HARD_CAP || process.env.MISER_COMPRESSION_THRESHOLD || '32000', 10),
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
