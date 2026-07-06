'use strict';

const { compress, validateMessageIntegrity } = require('./compress.js');
const { routeRequest } = require('./router.js');
const { getAllUsage } = require('./quota.js');
const config = require('./config.js');

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body, null, 2));
}

function createProxy() {
  return async function handler(req, res) {
    // Health check
    if (req.method === 'GET' && req.url === '/api/miser/health') {
      json(res, 200, { ok: true, port: config.port, threshold: config.compressionThreshold });
      return;
    }

    // Quota dashboard
    if (req.method === 'GET' && req.url === '/api/miser/quota') {
      json(res, 200, getAllUsage());
      return;
    }

    // Route: Anthropic Messages API or OpenAI Chat Completions
    const isAnthropic = req.method === 'POST' && req.url.startsWith('/v1/messages');
    const isOpenAI    = req.method === 'POST' && req.url.startsWith('/v1/chat/completions');

    if (!isAnthropic && !isOpenAI) {
      json(res, 404, { error: { type: 'not_found', message: `miser: unknown route ${req.url}` } });
      return;
    }

    try {
      const raw = await readBody(req);
      const body = JSON.parse(raw);
      const project = req.headers['x-termdeck-project'] || 'default';
      const format = isOpenAI ? 'openai' : 'anthropic';

      const { messages, tokens, rawTokens } = compress(body, config.compressionThreshold);
      const savedTokens = rawTokens - tokens;

      if (savedTokens > 0) {
        console.log(`[miser] project=${project} format=${format} compressed ${rawTokens}→${tokens} tokens (saved ${savedTokens})`);
      }

      const integrity = validateMessageIntegrity(messages);
      if (!integrity.valid) {
        console.error(`[miser] integrity error, refusing to forward: ${integrity.error}`);
        json(res, 400, { error: { type: 'miser_integrity_error', message: integrity.error } });
        return;
      }

      await routeRequest(messages, body, req.headers, res, project, savedTokens, format);
    } catch (err) {
      console.error('[miser] error:', err.message);
      if (!res.headersSent) {
        json(res, 500, { error: { type: 'proxy_error', message: err.message } });
      }
    }
  };
}

module.exports = { createProxy };
