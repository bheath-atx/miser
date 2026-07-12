'use strict';

const { compress } = require('./compress.js');
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
      json(res, 200, { ok: true, port: config.port, cacheHint: config.cacheHint });
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
      const originalBody = JSON.parse(raw);
      const project = req.headers['x-termdeck-project'] || 'default';
      const format = isOpenAI ? 'openai' : 'anthropic';

      // compress() v2 is LOSSLESS: it returns the REDUCED body (hoisted system,
      // optional cache hint, deduped messages). NO threshold gate, NO synthetic
      // client rejection, NO size ceiling — a client-illegal request is forwarded
      // as-is so Anthropic's authoritative error reaches the client (I1–I3, §8.8).
      const { body, messages, tokens, rawTokens } = compress(originalBody, {
        format,
        cacheHint: config.cacheHint,
      });
      const savedTokens = rawTokens - tokens;

      if (savedTokens > 0) {
        console.log(`[miser] project=${project} format=${format} deduped ${rawTokens}→${tokens} tokens (saved ${savedTokens})`);
      }

      // Forward the REDUCED body (I6) — every leg serializes THIS body, so the
      // hoisted top-level `system` and any cache hint reach the wire on all legs.
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
