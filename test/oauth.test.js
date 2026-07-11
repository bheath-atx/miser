'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeBearerProvider, extractBearer, OAuthUnavailableError } = require('../src/oauth.js');

// A fake auth.json matching the real Codex shape — but ENTIRELY synthetic.
// Tests never read the real ~/.codex/auth.json.
const FAKE_AUTH = JSON.stringify({
  auth_mode: 'chatgpt',
  OPENAI_API_KEY: 'sk-METERED-DO-NOT-USE',
  tokens: { id_token: 'id', access_token: 'ACCESS-TOKEN-XYZ', refresh_token: 'r', account_id: 'acct_123' },
  last_refresh: '2026-07-11T00:00:00Z',
});

test('reads subscription access_token via injected reader (no real file touched)', () => {
  let readPath = null;
  const getBearer = makeBearerProvider({
    authPath: '/nonexistent/fake/auth.json',
    readFile: (p) => { readPath = p; return FAKE_AUTH; },
  });
  const bearer = getBearer();
  assert.equal(bearer.token, 'ACCESS-TOKEN-XYZ');
  assert.equal(bearer.accountId, 'acct_123');
  assert.equal(readPath, '/nonexistent/fake/auth.json');
});

test('NEVER uses OPENAI_API_KEY — bearer is the subscription access_token only', () => {
  const getBearer = makeBearerProvider({ authPath: 'x', readFile: () => FAKE_AUTH });
  const bearer = getBearer();
  assert.notEqual(bearer.token, 'sk-METERED-DO-NOT-USE');
  assert.ok(!bearer.token.startsWith('sk-'));
});

test('fails closed when auth file is missing', () => {
  const getBearer = makeBearerProvider({
    authPath: 'x',
    readFile: () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; },
  });
  assert.throws(() => getBearer(), OAuthUnavailableError);
});

test('fails closed when JSON is malformed', () => {
  const getBearer = makeBearerProvider({ authPath: 'x', readFile: () => 'not json {' });
  assert.throws(() => getBearer(), OAuthUnavailableError);
});

test('fails closed when access_token is absent', () => {
  const noToken = JSON.stringify({ tokens: { account_id: 'a' } });
  const getBearer = makeBearerProvider({ authPath: 'x', readFile: () => noToken });
  assert.throws(() => getBearer(), OAuthUnavailableError);
});

test('fails closed when access_token is empty string', () => {
  assert.throws(() => extractBearer({ tokens: { access_token: '   ' } }), OAuthUnavailableError);
});

test('OAuthUnavailableError carries a 401 statusCode (treated as transient→Ollama)', () => {
  try { extractBearer({}); assert.fail('should throw'); }
  catch (e) { assert.equal(e.statusCode, 401); }
});
