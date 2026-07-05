'use strict';

module.exports = {
  port: parseInt(process.env.MISER_PORT || '20128', 10),
  compressionThreshold: parseInt(process.env.MISER_COMPRESSION_THRESHOLD || '32000', 10),
  ollamaUrl: process.env.MISER_OLLAMA_URL || 'http://127.0.0.1:11435',
  fallbackModels: (process.env.MISER_FALLBACK_MODELS || 'qwen2.5-coder:14b,qwen2.5:7b,qwen2.5:3b').split(','),
  anthropicUrl: 'https://api.anthropic.com',
};
