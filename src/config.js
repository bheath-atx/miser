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
  // Codex-specific headers the backend expects from the codex client. Values
  // extracted from the codex CLI binary; VERIFY-AT-CUTOVER against a live capture.
  codexBeta: process.env.MISER_CODEX_BETA || 'responses=experimental',
  codexOriginator: process.env.MISER_CODEX_ORIGINATOR || 'codex_cli_rs',
};
