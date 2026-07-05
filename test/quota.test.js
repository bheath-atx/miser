'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { recordUsage, getUsage, getAllUsage } = require('../src/quota.js');

test('getUsage returns null for unknown project', () => {
  assert.equal(getUsage('unknown-project-xyz-' + Date.now()), null);
});

test('recordUsage tracks requests and provider', () => {
  const proj = 'test-' + Date.now();
  recordUsage(proj, 'anthropic', 'claude-sonnet-4-6');
  const u = getUsage(proj);
  assert.ok(u !== null);
  assert.equal(u.requests, 1);
  assert.equal(u.lastProvider, 'anthropic');
  assert.equal(u.lastModel, 'claude-sonnet-4-6');
  assert.ok(u.providers.anthropic === 1);
});

test('recordUsage increments on repeated calls', () => {
  const proj = 'repeat-' + Date.now();
  recordUsage(proj, 'anthropic', 'claude-sonnet-4-6');
  recordUsage(proj, 'anthropic', 'claude-sonnet-4-6');
  assert.equal(getUsage(proj).requests, 2);
});

test('recordUsage tracks provider switches', () => {
  const proj = 'switch-' + Date.now();
  recordUsage(proj, 'anthropic', 'claude-sonnet-4-6');
  recordUsage(proj, 'ollama', 'qwen2.5-coder:14b');
  const u = getUsage(proj);
  assert.equal(u.providers.anthropic, 1);
  assert.equal(u.providers.ollama, 1);
  assert.equal(u.lastProvider, 'ollama');
});

test('getAllUsage includes all recorded projects', () => {
  const a = 'all-a-' + Date.now();
  const b = 'all-b-' + Date.now();
  recordUsage(a, 'anthropic', 'claude-sonnet-4-6');
  recordUsage(b, 'ollama', 'qwen2.5:7b');
  const all = getAllUsage();
  assert.ok(a in all);
  assert.ok(b in all);
});
