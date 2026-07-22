'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  BETA,
  parseContextEditProjects,
  buildContextManagement,
  mergeBetaHeader,
  injectContextManagement,
} = require('../src/context-management.js');

function captureWarnings(fn) {
  const prev = console.warn;
  const lines = [];
  console.warn = (line) => lines.push(String(line));
  try {
    return { result: fn(), lines };
  } finally {
    console.warn = prev;
  }
}

test('v4 C1: malformed env, array, and non-object disable all projects with warnings', () => {
  for (const raw of ['{bad', '[]', '"x"', '7']) {
    const { result, lines } = captureWarnings(() => parseContextEditProjects(raw));
    assert.deepEqual(result.projects, {});
    assert.ok(lines.length >= 1);
  }
});

test('v4 C1: false/null/string/array project values disable that project', () => {
  const { result, lines } = captureWarnings(() => parseContextEditProjects(JSON.stringify({
    a: false,
    b: null,
    c: 'yes',
    d: [],
  })));
  assert.deepEqual(result.projects, {});
  assert.equal(lines.length, 4);
});

test('v4 C1: unknown keys, out-of-bounds knobs, and bad project keys fail closed', () => {
  const { result, lines } = captureWarnings(() => parseContextEditProjects(JSON.stringify({
    good: true,
    badUnknown: { trigger: 60000, surprise: true },
    badTrigger: { trigger: 9999 },
    badKeep: { keep: 21 },
    badClear: { clearAtLeast: 4999 },
    badExclude: { excludeTools: ['x'.repeat(129)] },
    'bad/name': true,
  })));
  assert.deepEqual(Object.keys(result.projects), ['good']);
  assert.ok(lines.length >= 6);
});

test('v4 C1: valid flat knobs map to the fixed Anthropic fragment', () => {
  const { result } = captureWarnings(() => parseContextEditProjects(JSON.stringify({
    alpha: { trigger: 70000, keep: 7, clearAtLeast: 30000, excludeTools: ['Read'] },
  })));
  const fragment = buildContextManagement(result.projects.alpha);
  assert.deepEqual(fragment, {
    edits: [{
      type: 'clear_tool_uses_20250919',
      trigger: { type: 'input_tokens', value: 70000 },
      keep: { type: 'tool_uses', value: 7 },
      clear_at_least: { type: 'input_tokens', value: 30000 },
      exclude_tools: ['Read'],
    }],
  });
});

test('v4 C1: beta header merge preserves existing entries without duplicates', () => {
  assert.equal(mergeBetaHeader('foo'), `foo,${BETA}`);
  assert.equal(mergeBetaHeader(`foo, ${BETA}`), `foo,${BETA}`);
});

test('v4 C1: injection is skipped for client-supplied context_management', () => {
  const body = { context_management: { edits: [] } };
  const result = injectContextManagement(body, {}, 'alpha', { alpha: { trigger: 60000, keep: 5, clearAtLeast: 20000 } });
  assert.equal(result.injected, false);
  assert.equal(result.body, body);
});
