'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pruneTools } = require('../src/toolprune.js');

function names(tools) {
  return tools.map(t => t.name || (t.function && t.function.name));
}

test('AC1: valid allowlist with zero intersection returns original tools unchanged', () => {
  const tools = [{ name: 'Read' }, { name: 'Write' }];
  const result = pruneTools(tools, { messages: [] }, ['Bash']);
  assert.strictEqual(result, tools);
});

test('AC1: zero allowlist intersection remains NO-OP even when rescues exist', () => {
  const tools = [{ name: 'Read' }, { name: 'Write' }];
  const body = {
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'u1', name: 'Write', input: {} }] },
    ],
  };
  const result = pruneTools(tools, body, ['Bash']);
  assert.strictEqual(result, tools);
});

test('AC2: tool named in history tool_use is rescued', () => {
  const tools = [{ name: 'Read' }, { name: 'Write' }, { name: 'Bash' }];
  const body = {
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'u1', name: 'Write', input: {} }] },
    ],
  };
  const result = pruneTools(tools, body, ['Read']);
  assert.deepEqual(names(result), ['Read', 'Write']);
});

test('AC3: Anthropic tool_choice name is rescued', () => {
  const tools = [{ name: 'Read' }, { name: 'Write' }, { name: 'Bash' }];
  const body = { messages: [], tool_choice: { type: 'tool', name: 'Bash' } };
  const result = pruneTools(tools, body, ['Read']);
  assert.deepEqual(names(result), ['Read', 'Bash']);
});

test('AC3b: OpenAI function tool_choice name is rescued', () => {
  const tools = [
    { type: 'function', function: { name: 'read_file' } },
    { type: 'function', function: { name: 'write_file' } },
    { type: 'function', function: { name: 'run_command' } },
  ];
  const body = {
    messages: [],
    tool_choice: { type: 'function', function: { name: 'run_command' } },
  };
  const result = pruneTools(tools, body, ['read_file']);
  assert.deepEqual(names(result), ['read_file', 'run_command']);
});

test('AC4a: null allowlist is NO-OP', () => {
  const tools = [{ name: 'Read' }, { name: 'Write' }];
  const result = pruneTools(tools, { messages: [] }, null);
  assert.strictEqual(result, tools);
});

test('AC4b: empty allowlist is NO-OP', () => {
  const tools = [{ name: 'Read' }, { name: 'Write' }];
  const result = pruneTools(tools, { messages: [] }, []);
  assert.strictEqual(result, tools);
});

test('normal prune removes non-allowlisted tools', () => {
  const tools = [{ name: 'Read' }, { name: 'Write' }, { name: 'Bash' }];
  const result = pruneTools(tools, { messages: [] }, ['Read', 'Bash']);
  assert.deepEqual(names(result), ['Read', 'Bash']);
});

test('rescue plus prune keeps rescued tools outside the allowlist', () => {
  const tools = [{ name: 'Read' }, { name: 'Write' }, { name: 'Bash' }, { name: 'Glob' }];
  const body = {
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'u1', name: 'Write', input: {} }] },
    ],
    tool_choice: { type: 'tool', name: 'Bash' },
  };
  const result = pruneTools(tools, body, ['Read']);
  assert.deepEqual(names(result), ['Read', 'Write', 'Bash']);
});
