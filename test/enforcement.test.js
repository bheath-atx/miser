'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseEnforcement,
  resolvePolicy,
  classifyRequest,
  createEnforcementState,
  checkEnforcement,
} = require('../src/enforcement.js');

function bodyFor(text, assistantCount = 0) {
  const messages = [];
  for (let i = 0; i < assistantCount; i++) {
    messages.push({ role: 'user', content: `u${i}` });
    messages.push({ role: 'assistant', content: `a${i}` });
  }
  messages.push({ role: 'user', content: text });
  return { model: 'claude', max_tokens: 50, messages };
}

function toolResultBody(content) {
  return {
    model: 'claude',
    max_tokens: 50,
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/tmp/out' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content }] },
    ],
  };
}

function guard(config, state, now = () => new Date('2026-08-25T12:00:00.000Z')) {
  const events = [];
  return {
    enforcementConfig: config,
    enforcementState: state,
    nowFn: now,
    recordEnforcementEvent(project, event) { events.push({ project, ...event }); },
    events,
  };
}

test('parseEnforcement accepts wildcard default and project overrides', () => {
  const parsed = parseEnforcement(JSON.stringify({
    '*': { mode: 'observe', poll: { maxLikelyPollsPer10Min: 2 } },
    'nacho-orch': { mode: 'throttle' },
    'bad name!': { mode: 'block' },
  }));
  assert.equal(parsed['*'].mode, 'observe');
  assert.equal(parsed['*'].poll.maxLikelyPollsPer10Min, 2);
  assert.equal(parsed['nacho-orch'].mode, 'throttle');
  assert.equal(parsed['bad name!'], undefined);

  const policy = resolvePolicy(parsed, 'nacho-orch');
  assert.equal(policy.mode, 'throttle');
  assert.equal(policy.poll.maxLikelyPollsPer10Min, 2);
});

test('controlClass catches measured NACHO control-loop patterns', () => {
  const cases = [
    ['~/bin/spawn-lane.sh --project nacho-orch', 'panel_lifecycle'],
    ['DEADLINE=$((SECONDS+900)); while true; do test -f CODEX-RESULT.md; done', 'audit_monitor'],
    ['curl http://127.0.0.1:20128/api/miser/stats', 'usage_monitor'],
    ['curl http://localhost/v1/orch/nacho-orch/reply', 'brad_comms'],
    ['gh pr view 12 && git diff --stat', 'repo_status'],
  ];
  for (const [text, expected] of cases) {
    const c = classifyRequest('nacho-orch', 'sprints', bodyFor(text), { 'x-miser-poll-class': 'likely' }, 100);
    assert.ok(c.controlClasses.includes(expected), `${text} should include ${expected}`);
  }
});

test('nacho-orch canary warns at poll edge before blocking in throttle mode', () => {
  let nowMs = Date.parse('2026-08-25T12:00:00.000Z');
  const state = createEnforcementState({ nowMs: () => nowMs });
  const config = parseEnforcement(JSON.stringify({
    '*': { mode: 'observe' },
    'nacho-orch': { mode: 'throttle', poll: { maxLikelyPollsPer10Min: 1, minIdlePollSpacingSec: 600 } },
  }));
  const deps = guard(config, state, () => new Date(nowMs));
  const body = bodyFor('curl http://127.0.0.1:20128/api/miser/stats');
  const warn = checkEnforcement('nacho-orch', 'sprints', body, { 'x-miser-poll-class': 'likely' }, 100, deps);
  assert.equal(warn.status, 200);
  assert.equal(warn.headers['x-miser-enforcement-warning'], 'poll-budget-edge');
  assert.match(warn.body.content[0].text, /poll budget edge/);
  nowMs += 1000;
  const block = checkEnforcement('nacho-orch', 'sprints', body, { 'x-miser-poll-class': 'likely' }, 100, deps);
  assert.equal(block.status, 429);
  assert.equal(block.headers['x-miser-enforcement'], 'poll-budget');
  assert.equal(block.headers['retry-after'], '600');
});

test('non-control work turn resets the likely-poll strike window', () => {
  let nowMs = Date.parse('2026-08-25T12:00:00.000Z');
  const state = createEnforcementState({ nowMs: () => nowMs });
  const config = parseEnforcement(JSON.stringify({
    '*': { mode: 'observe' },
    'nacho-orch': { mode: 'throttle', poll: { maxLikelyPollsPer10Min: 1, minIdlePollSpacingSec: 600 } },
  }));
  const deps = guard(config, state, () => new Date(nowMs));
  const poll = bodyFor('curl http://127.0.0.1:20128/api/miser/stats');
  const work = bodyFor('please make the requested boot prompt wording change');

  assert.equal(checkEnforcement('nacho-orch', 'sprints', poll, { 'x-miser-poll-class': 'likely' }, 100, deps).status, 200);
  nowMs += 1000;
  assert.equal(checkEnforcement('nacho-orch', 'sprints', work, { 'x-miser-poll-class': 'likely' }, 100, deps), null);
  nowMs += 1000;
  const warnAgain = checkEnforcement('nacho-orch', 'sprints', poll, { 'x-miser-poll-class': 'likely' }, 100, deps);
  assert.equal(warnAgain.status, 200);
  assert.equal(warnAgain.headers['x-miser-enforcement-warning'], 'poll-budget-edge');
});

test('non-control work turn resets even after a hard poll-budget block', () => {
  let nowMs = Date.parse('2026-08-25T12:00:00.000Z');
  const state = createEnforcementState({ nowMs: () => nowMs });
  const config = parseEnforcement(JSON.stringify({
    '*': { mode: 'observe' },
    'nacho-orch': { mode: 'throttle', poll: { maxLikelyPollsPer10Min: 1, minIdlePollSpacingSec: 600 } },
  }));
  const deps = guard(config, state, () => new Date(nowMs));
  const poll = bodyFor('curl http://127.0.0.1:20128/api/miser/stats');
  const work = bodyFor('please answer Brad and stop polling');

  assert.equal(checkEnforcement('nacho-orch', 'sprints', poll, { 'x-miser-poll-class': 'likely' }, 100, deps).status, 200);
  nowMs += 1000;
  assert.equal(checkEnforcement('nacho-orch', 'sprints', poll, { 'x-miser-poll-class': 'likely' }, 100, deps).status, 429);
  nowMs += 1000;
  assert.equal(checkEnforcement('nacho-orch', 'sprints', work, { 'x-miser-poll-class': 'likely' }, 100, deps), null);
  nowMs += 1000;
  const warnAgain = checkEnforcement('nacho-orch', 'sprints', poll, { 'x-miser-poll-class': 'likely' }, 100, deps);
  assert.equal(warnAgain.status, 200);
  assert.equal(warnAgain.headers['x-miser-enforcement-warning'], 'poll-budget-edge');
});

test('non-NACHO projects do not live-block pollClass during canary even in throttle', () => {
  const state = createEnforcementState({ nowMs: () => 1000 });
  const config = parseEnforcement(JSON.stringify({
    '*': { mode: 'observe' },
    aetheria: { mode: 'throttle', poll: { maxLikelyPollsPer10Min: 1 } },
  }));
  const deps = guard(config, state);
  const body = bodyFor('curl http://127.0.0.1:20128/api/miser/stats');
  assert.equal(checkEnforcement('aetheria', 'orch', body, { 'x-miser-poll-class': 'likely' }, 100, deps), null);
  assert.equal(checkEnforcement('aetheria', 'orch', body, { 'x-miser-poll-class': 'likely' }, 100, deps), null);
});

test('raw assistant turns alone and 450K context do not block work-class turns', () => {
  const state = createEnforcementState({ nowMs: () => 1000 });
  const config = parseEnforcement(JSON.stringify({
    '*': { mode: 'block', session: { maxRequestContextTokensObserve: 450000, maxAssistantTurnsObserve: 100 } },
  }));
  const deps = guard(config, state);
  const body = bodyFor('please make the architectural decision now', 120);
  assert.equal(checkEnforcement('aetheria', 'builder', body, { 'x-miser-poll-class': 'unlikely' }, 800000, deps), null);
});

test('historical oversized tool_result is not blocked unless strict latest-turn block is explicitly enabled', () => {
  const state = createEnforcementState({ nowMs: () => 1000 });
  const config = parseEnforcement(JSON.stringify({
    '*': { mode: 'block', toolResults: { mode: 'alert', maxToolResultBytes: 10 } },
  }));
  const deps = guard(config, state);
  assert.equal(checkEnforcement('nacho-orch', 'sprints', toolResultBody('x'.repeat(100)), { 'x-miser-poll-class': 'unlikely' }, 100, deps), null);
});

test('terminal handoff allowlist permits bounded post-cap spawn/reap before blocking', () => {
  let nowMs = Date.parse('2026-08-25T12:00:00.000Z');
  const state = createEnforcementState({ nowMs: () => nowMs });
  const config = parseEnforcement(JSON.stringify({
    '*': { mode: 'observe' },
    'nacho-orch': {
      mode: 'throttle',
      poll: { maxLikelyPollsPer10Min: 99 },
      orchControl: { maxControlTurnsPerHour: 99, maxControlTurnsPerSession: 1, terminalHandoffMaxTurns: 2, inboundBradReplyMaxTurns: 0 },
    },
  }));
  const deps = guard(config, state, () => new Date(nowMs));
  assert.equal(checkEnforcement('nacho-orch', 'sprints', bodyFor('curl /api/miser/stats'), { 'x-miser-poll-class': 'unlikely' }, 100, deps), null);
  nowMs += 1000;
  assert.equal(checkEnforcement('nacho-orch', 'sprints', bodyFor('write HANDOFF and spawn-lane successor'), { 'x-miser-poll-class': 'unlikely' }, 100, deps), null);
  nowMs += 1000;
  assert.equal(checkEnforcement('nacho-orch', 'sprints', bodyFor('safe-reap predecessor after COMPACT-STATE'), { 'x-miser-poll-class': 'unlikely' }, 100, deps), null);
  nowMs += 1000;
  const block = checkEnforcement('nacho-orch', 'sprints', bodyFor('safe-reap predecessor again'), { 'x-miser-poll-class': 'unlikely' }, 100, deps);
  assert.equal(block.headers['x-miser-enforcement'], 'orch-control-budget');
});
