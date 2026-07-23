'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyRoute } = require('../src/routing.js');

test('v4 P1: /p/<project>/v1/messages attributes project and ignores query', () => {
  assert.deepEqual(
    classifyRoute('POST', '/p/a.b_C-1/v1/messages?x=1'),
    { kind: 'messages', format: 'anthropic', project: 'a.b_C-1' },
  );
});

test('v4 P1: encoded slash project bypass is rejected', () => {
  assert.deepEqual(classifyRoute('POST', '/p/alpha%2Fbeta/v1/messages'), { kind: 'not_found' });
});

test('v4 P1: malformed percent encoding is rejected', () => {
  assert.deepEqual(classifyRoute('POST', '/p/%E0%A4%A/v1/messages'), { kind: 'not_found' });
});

test('v4 P1: suffixed messages route is rejected', () => {
  assert.deepEqual(classifyRoute('POST', '/p/alpha/v1/messagesXYZ'), { kind: 'not_found' });
  assert.deepEqual(classifyRoute('POST', '/v1/messagesXYZ'), { kind: 'not_found' });
});

test('v4 P1: invalid project charset and empty project are rejected', () => {
  assert.deepEqual(classifyRoute('POST', '/p/bad+name/v1/messages'), { kind: 'not_found' });
  assert.deepEqual(classifyRoute('POST', '/p//v1/messages'), { kind: 'not_found' });
});

test('v4 P1: existing /v1/messages and exact /api/miser routes are unchanged', () => {
  assert.deepEqual(classifyRoute('POST', '/v1/messages'), { kind: 'messages', format: 'anthropic' });
  assert.deepEqual(classifyRoute('GET', '/api/miser/stats?days=1'), { kind: 'stats' });
  assert.deepEqual(classifyRoute('GET', '/api/miser/stats/trend?days=7'), { kind: 'stats_trend' });
  assert.deepEqual(classifyRoute('GET', '/api/miser/statsXYZ'), { kind: 'not_found' });
});
