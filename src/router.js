'use strict';

const https = require('node:https');
const http = require('node:http');
const { translateToOllama, translateOllamaStream } = require('./translate.js');
const { recordUsage } = require('./quota.js');
const config = require('./config.js');

async function routeRequest(messages, originalBody, incomingHeaders, res, project, savedTokens) {
  try {
    await forwardToAnthropic(messages, originalBody, incomingHeaders, res, project, savedTokens);
  } catch (err) {
    if (err.statusCode === 429) {
      console.log('[miser] Anthropic 429 — falling back to Ollama');
      await forwardToOllama(messages, originalBody, res, project, savedTokens);
    } else {
      throw err;
    }
  }
}

function forwardToAnthropic(messages, originalBody, incomingHeaders, res, project, savedTokens) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ ...originalBody, messages });
    const options = {
      hostname: 'api.anthropic.com',
      port: 443,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'anthropic-version': incomingHeaders['anthropic-version'] || '2023-06-01',
      },
    };

    // Forward all auth headers — subscription uses Authorization: Bearer,
    // API-key use x-api-key. Forward both so either auth mode works unchanged.
    if (incomingHeaders['x-api-key']) options.headers['x-api-key'] = incomingHeaders['x-api-key'];
    if (incomingHeaders['authorization']) options.headers['authorization'] = incomingHeaders['authorization'];
    if (incomingHeaders['anthropic-beta']) options.headers['anthropic-beta'] = incomingHeaders['anthropic-beta'];

    const req = https.request(options, (upstream) => {
      if (upstream.statusCode === 429) {
        const err = new Error('anthropic quota exhausted');
        err.statusCode = 429;
        upstream.resume();
        reject(err);
        return;
      }

      res.writeHead(upstream.statusCode, {
        'content-type': upstream.headers['content-type'] || 'application/json',
        'x-miser-provider': 'anthropic',
        'x-miser-model': originalBody.model || 'unknown',
        'x-miser-saved-tokens': String(savedTokens),
      });
      upstream.pipe(res);
      upstream.on('end', () => { recordUsage(project, 'anthropic', originalBody.model || 'unknown'); resolve(); });
      upstream.on('error', reject);
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function forwardToOllama(messages, originalBody, res, project, savedTokens) {
  return new Promise((resolve, reject) => {
    const model = config.fallbackModels[0];
    const ollamaBody = translateToOllama(messages, originalBody, model);
    const bodyStr = JSON.stringify(ollamaBody);
    const ollamaUrl = new URL('/api/chat', config.ollamaUrl);
    const transport = ollamaUrl.protocol === 'https:' ? https : http;

    const options = {
      hostname: ollamaUrl.hostname,
      port: ollamaUrl.port || (ollamaUrl.protocol === 'https:' ? 443 : 80),
      path: ollamaUrl.pathname,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(bodyStr),
      },
    };

    const req = transport.request(options, (upstream) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'x-miser-provider': 'ollama',
        'x-miser-model': model,
        'x-miser-saved-tokens': String(savedTokens),
      });
      translateOllamaStream(upstream, res, model);
      upstream.on('end', () => { recordUsage(project, 'ollama', model); resolve(); });
      upstream.on('error', reject);
    });

    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

module.exports = { routeRequest };
