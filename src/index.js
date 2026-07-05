'use strict';

const http = require('node:http');
const { createProxy } = require('./proxy.js');
const config = require('./config.js');

const server = http.createServer(createProxy());

server.listen(config.port, '127.0.0.1', () => {
  console.log(`[miser] v0.1.0 listening on 127.0.0.1:${config.port}`);
  console.log(`[miser] compression threshold: ${config.compressionThreshold} tokens`);
  console.log(`[miser] ollama url: ${config.ollamaUrl}`);
  console.log(`[miser] fallback models: ${config.fallbackModels.join(', ')}`);
  console.log(`[miser] health: GET http://127.0.0.1:${config.port}/api/miser/health`);
  console.log(`[miser] quota:  GET http://127.0.0.1:${config.port}/api/miser/quota`);
});

server.on('error', (err) => {
  console.error('[miser] server error:', err.message);
  process.exit(1);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT',  () => server.close(() => process.exit(0)));
