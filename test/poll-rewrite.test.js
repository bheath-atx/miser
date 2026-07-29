'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  parsePollRewriteConfig,
  parsePollRewriteEnv,
  shouldRewrite,
  applyPollRewrite,
  formatRewriteHeader,
  createPollRewriteBreaker,
} = require('../src/poll-rewrite.js');
const { validateStartupConfig } = require('../src/config.js');

const validRaw = JSON.stringify({ pkachu: { panels: ['orch'], maxTokens: 1024 } });

function clone(x) {
  return JSON.parse(JSON.stringify(x));
}

function tmpStatsFile(name) {
  return path.join(os.tmpdir(), `miser-poll-rewrite-${process.pid}-${name}-${Date.now()}-${Math.random()}.json`);
}

function freshStats(file) {
  const statsPath = require.resolve('../src/stats.js');
  delete require.cache[statsPath];
  process.env.MISER_STATS_FILE = file;
  return require('../src/stats.js');
}

test('AC1-AC3: poll rewrite config parses empty, malformed, non-object, and drops bad siblings', () => {
  assert.deepEqual(parsePollRewriteConfig(''), { projects: {}, warnings: [] });
  assert.equal(Object.keys(parsePollRewriteConfig('{oops').projects).length, 0);
  assert.equal(parsePollRewriteConfig('{oops').warnings.length, 1);
  assert.equal(parsePollRewriteConfig('[1,2]').warnings.length, 1);
  const parsed = parsePollRewriteConfig(JSON.stringify({
    'bad name!': { panels: ['x'], maxTokens: 1024 },
    good: { panels: ['canary'], maxTokens: 1024 },
  }));
  assert.deepEqual(parsed.projects.good, { panels: ['canary'], maxTokens: 1024 });
  assert.ok(!parsed.projects['bad name!']);
  assert.equal(parsed.warnings.length, 1);
});

test('AC4-AC7: project validation drops missing panels, zero levers, bad panels/levers, unknown keys', () => {
  const badEntries = [
    { panels: undefined, maxTokens: 1024 },
    { panels: ['a'] },
    { panels: [] , maxTokens: 1024 },
    { panels: [''], maxTokens: 1024 },
    { panels: ['bad!'], maxTokens: 1024 },
    { panels: Array.from({ length: 21 }, (_, i) => `p${i}`), maxTokens: 1024 },
    { panels: 7, maxTokens: 1024 },
    { panels: ['a'], maxTokens: 0 },
    { panels: ['a'], maxTokens: 1.5 },
    { panels: ['a'], maxTokens: '1024' },
    { panels: ['a'], maxTokens: 40000 },
    { panels: ['a'], thinking: 'off' },
    { panels: ['a'], thinking: 512 },
    { panels: ['a'], thinking: 1.5 },
    { panels: ['a'], modelMap: {} },
    { panels: ['a'], modelMap: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`m${i}`, `n${i}`])) },
    { panels: ['a'], modelMap: { 'a b': 'c' } },
    { panels: ['a'], modelMap: { a: '' } },
    { panels: ['a'], maxTokens: 1024, autoApply: true },
  ];
  for (const entry of badEntries) {
    const raw = JSON.stringify({ proj: entry });
    const parsed = parsePollRewriteConfig(raw);
    assert.deepEqual(parsed.projects, {}, JSON.stringify(entry));
    assert.equal(parsed.warnings.length, 1, JSON.stringify(entry));
  }

  const valid = {
    panels: ['canary'],
    maxTokens: 1024,
    thinking: 'strip',
    modelMap: { 'claude-opus-4-8': 'claude-haiku-4-5-20251001' },
  };
  assert.deepEqual(parsePollRewriteConfig(JSON.stringify({ proj: valid })).projects.proj, valid);
  assert.equal(parsePollRewriteConfig(JSON.stringify({ proj: { panels: '*', maxTokens: 1024 } })).projects.proj.panels, '*');
});

test('AC6: modelMap rejects non-string target values instead of regex coercing them', () => {
  const cases = [
    ['number', 7],
    ['null', null],
    ['boolean', true],
    ['array', ['claude-haiku-4-5-20251001']],
    ['object', { target: 'claude-haiku-4-5-20251001' }],
  ];
  for (const [label, value] of cases) {
    const parsed = parsePollRewriteConfig(JSON.stringify({
      proj: { panels: ['a'], modelMap: { 'claude-opus-4-8': value } },
    }));
    assert.deepEqual(parsed.projects, {}, label);
    assert.equal(parsed.warnings.length, 1, label);
    assert.match(parsed.warnings[0], /invalid modelMap/, label);
  }
});

test('AC8: parsePollRewriteEnv fail-closes invalid provided breaker knobs and defaults absent knobs', () => {
  for (const bad of [
    { threshold: '0' },
    { threshold: 'abc' },
    { windowMs: '-5' },
    { resetMs: '0' },
    { resetMs: '-1' },
    { resetMs: 'NaN' },
  ]) {
    const out = parsePollRewriteEnv({ raw: validRaw, ...bad });
    assert.deepEqual(out.projects, {});
    assert.equal(out.breaker, null);
    assert.equal(out.warnings.length, 1);
    assert.match(out.warnings[0], new RegExp(Object.keys(bad)[0]));
  }
  for (const knobs of [
    {},
    { windowMs: null, threshold: null, resetMs: null },
    { windowMs: '', threshold: '', resetMs: '' },
    { windowMs: '', threshold: undefined, resetMs: null },
    { windowMs: '300000', threshold: '3', resetMs: '1800000' },
  ]) {
    const out = parsePollRewriteEnv({ raw: validRaw, ...knobs });
    assert.deepEqual(out.projects.pkachu, { panels: ['orch'], maxTokens: 1024 });
    assert.deepEqual(out.breaker, { windowMs: 300000, threshold: 3, resetMs: 1800000 });
    assert.deepEqual(out.warnings, []);
  }
});

test('AC9-AC12: shouldRewrite gates project, poll class, format, panel selector, and breaker', () => {
  const projects = {
    pkachu: { panels: ['canary'], maxTokens: 1024 },
    wide: { panels: '*', maxTokens: 1024 },
  };
  const breaker = { isDisabled: (_project, nowMs) => nowMs < 500 };
  assert.equal(shouldRewrite('missing', 'canary', 'likely', 'anthropic', projects, breaker, 1000), false);
  assert.equal(shouldRewrite('pkachu', 'canary', 'unlikely', 'anthropic', projects, breaker, 1000), false);
  assert.equal(shouldRewrite('pkachu', 'canary', undefined, 'anthropic', projects, breaker, 1000), false);
  assert.equal(shouldRewrite('pkachu', 'canary', 'likely', 'openai', projects, breaker, 1000), false);
  assert.equal(shouldRewrite('pkachu', 'canary', 'likely', undefined, projects, breaker, 1000), false);
  assert.equal(shouldRewrite('pkachu', 'canary', 'likely', 'anthropic', projects, breaker, 1000), true);
  assert.equal(shouldRewrite('pkachu', 'orch', 'likely', 'anthropic', projects, breaker, 1000), false);
  assert.equal(shouldRewrite('pkachu', null, 'likely', 'anthropic', projects, breaker, 1000), false);
  assert.equal(shouldRewrite('wide', null, 'likely', 'anthropic', projects, breaker, 1000), true);
  assert.equal(shouldRewrite('wide', 'anything', 'likely', 'anthropic', projects, breaker, 1000), true);
  assert.equal(shouldRewrite('wide', 'anything', 'likely', 'anthropic', projects, breaker, 100), false);
});

test('AC13-AC18/AC20: applyPollRewrite levers are immutable, independent, no-op by result, and all-or-nothing', () => {
  const maxInput = { max_tokens: 8000, model: 'claude' };
  const beforeMax = clone(maxInput);
  const max = applyPollRewrite(maxInput, { maxTokens: 1024 });
  assert.equal(max.body.max_tokens, 1024);
  assert.deepEqual(max.applied, ['maxTokens']);
  assert.deepEqual(max.details, { maxTokens: 1024 });
  assert.deepEqual(maxInput, beforeMax);
  assert.equal(applyPollRewrite({ max_tokens: 512 }, { maxTokens: 1024 }).body.max_tokens, 512);
  assert.equal(Object.prototype.hasOwnProperty.call(applyPollRewrite({}, { maxTokens: 1024 }).body, 'max_tokens'), false);

  const stripInput = { thinking: { type: 'enabled', budget_tokens: 8000 }, model: 'claude' };
  const strip = applyPollRewrite(stripInput, { thinking: 'strip' });
  assert.equal(Object.prototype.hasOwnProperty.call(strip.body, 'thinking'), false);
  assert.deepEqual(strip.details, { thinking: 'strip' });
  assert.deepEqual(stripInput, { thinking: { type: 'enabled', budget_tokens: 8000 }, model: 'claude' });

  const capInput = { thinking: { type: 'enabled', budget_tokens: 8000 } };
  const cap = applyPollRewrite(capInput, { thinking: 2048 });
  assert.equal(cap.body.thinking.budget_tokens, 2048);
  assert.notEqual(cap.body.thinking, capInput.thinking);
  assert.equal(capInput.thinking.budget_tokens, 8000);
  assert.deepEqual(applyPollRewrite({ thinking: { type: 'enabled', budget_tokens: 1500 } }, { thinking: 2048 }).applied, []);
  assert.deepEqual(applyPollRewrite({ thinking: { type: 'disabled' } }, { thinking: 2048 }).applied, []);

  const model = applyPollRewrite({ model: 'claude-opus-4-8' }, {
    modelMap: { 'claude-opus-4-8': 'claude-haiku-4-5-20251001' },
  });
  assert.equal(model.body.model, 'claude-haiku-4-5-20251001');
  assert.deepEqual(model.details, { model: 'claude-haiku-4-5-20251001' });
  assert.deepEqual(applyPollRewrite({ model: 'claude-opus-4-8-20250601' }, {
    modelMap: { 'claude-opus-4-8': 'x' },
  }).applied, []);

  const abandonInput = { max_tokens: 8000, thinking: { type: 'enabled', budget_tokens: 4000 } };
  const abandonBefore = clone(abandonInput);
  const abandon = applyPollRewrite(abandonInput, { maxTokens: 1500, thinking: 2048 });
  assert.equal(abandon.body, abandonInput);
  assert.deepEqual(abandon.applied, []);
  assert.deepEqual(abandon.details, {});
  assert.equal(abandon.skipped, 'thinking-exceeds-max-tokens');
  assert.deepEqual(abandonInput, abandonBefore);

  const lowBudget = { max_tokens: 8000, thinking: { type: 'enabled', budget_tokens: 512 } };
  assert.equal(applyPollRewrite(lowBudget, { maxTokens: 1024 }).body, lowBudget);
  assert.equal(applyPollRewrite({ model: 'a', max_tokens: 8000, thinking: { type: 'enabled', budget_tokens: 512 } }, {
    modelMap: { a: 'b' },
  }).skipped, 'thinking-budget-too-low');

  const contextManagement = { edits: [] };
  assert.deepEqual(applyPollRewrite({ model: 'a', max_tokens: 8000, context_management: contextManagement }, { maxTokens: 1024 }).details, { maxTokens: 1024 });
  assert.deepEqual(applyPollRewrite({ model: 'a', max_tokens: 8000, thinking: { type: 'enabled', budget_tokens: 8000 }, context_management: contextManagement }, { thinking: 'strip' }).details, { thinking: 'strip' });
  assert.deepEqual(applyPollRewrite({ model: 'a', max_tokens: 8000, context_management: contextManagement }, { modelMap: { a: 'b' } }).details, { model: 'b' });
  assert.equal(applyPollRewrite({ model: 'a', max_tokens: 8000, context_management: contextManagement }, { maxTokens: 1024 }).body.context_management, contextManagement);
});

function auditCacheControl(body) {
  const found = [];
  function walk(node, pathLabel, parent) {
    if (!node || typeof node !== 'object') return;
    if (Object.prototype.hasOwnProperty.call(node, 'cache_control')) {
      found.push({ path: `${pathLabel}.cache_control`, value: clone(node.cache_control), obj: node.cache_control, parent });
    }
    if (Array.isArray(node)) node.forEach((item, i) => walk(item, `${pathLabel}[${i}]`, node));
    else for (const [k, v] of Object.entries(node)) walk(v, pathLabel ? `${pathLabel}.${k}` : k, node);
  }
  walk(body, '', null);
  return found;
}

test('AC19: cache_control paths, values, and identities survive apply and abandon outcomes', () => {
  const body = {
    model: 'claude-opus-4-8',
    max_tokens: 8000,
    thinking: { type: 'enabled', budget_tokens: 4000 },
    system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] }],
    tools: [{ name: 't', input_schema: {}, cache_control: { type: 'ephemeral' } }],
    metadata: { user_id: 'u' },
  };
  function assertCacheControlSurvives(overrides, knobs) {
    const input = { ...clone(body), ...clone(overrides) };
    const before = auditCacheControl(input);
    const result = applyPollRewrite(input, knobs);
    const target = result.body;
    const after = auditCacheControl(target);
    assert.equal(after.length, before.length);
    for (let i = 0; i < before.length; i++) {
      assert.equal(after[i].path, before[i].path);
      assert.deepEqual(after[i].value, before[i].value);
      assert.equal(after[i].obj, before[i].obj);
      assert.equal(after[i].parent, before[i].parent);
    }
    assert.equal(target.messages, input.messages);
    assert.equal(target.system, input.system);
    assert.equal(target.tools, input.tools);
    assert.equal(target.metadata, input.metadata);
  }

  for (const knobs of [
    { maxTokens: 1024 },
    { thinking: 'strip' },
    { modelMap: { 'claude-opus-4-8': 'claude-haiku-4-5-20251001' } },
    { maxTokens: 1024, thinking: 'strip', modelMap: { 'claude-opus-4-8': 'claude-haiku-4-5-20251001' } },
    { maxTokens: 1500, thinking: 2048 },
  ]) {
    assertCacheControlSurvives({}, knobs);
  }
  assertCacheControlSurvives({ thinking: { type: 'enabled', budget_tokens: 512 } }, { maxTokens: 1024 });
  assertCacheControlSurvives(
    { thinking: { type: 'enabled', budget_tokens: 512 } },
    { modelMap: { 'claude-opus-4-8': 'claude-haiku-4-5-20251001' } }
  );
});

test('AC21-AC26: poll rewrite breaker trips synchronously, prunes windows, resets, isolates projects, and alerts once', async () => {
  const alerts = [];
  const sent = new Set();
  const breaker = createPollRewriteBreaker({ windowMs: 300000, threshold: 3, resetMs: 1800000 }, {
    ledger: { shouldSend: k => !sent.has(k), markSent: k => sent.add(k) },
    sendAlert: msg => { alerts.push(msg); },
  });
  breaker.recordOutcome('a', false, 0);
  breaker.recordOutcome('a', false, 60000);
  const trip = breaker.recordOutcome('a', false, 120000);
  assert.deepEqual(trip, { tripped: true });
  assert.equal(breaker.isDisabled('a', 120000), true);
  assert.deepEqual(breaker.getState('a'), { disabledUntil: 1920000, windowCount: 0, trips: 1 });
  assert.equal(breaker.isDisabled('a', 1920000 - 1), true);
  assert.equal(breaker.isDisabled('a', 1920000), false);
  breaker.recordOutcome('a', false, 1920000);
  breaker.recordOutcome('a', false, 1920001);
  assert.equal(breaker.getState('a').trips, 1);
  assert.equal(breaker.isDisabled('b', 1920001), false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(alerts.length, 1);

  const pruned = createPollRewriteBreaker({ windowMs: 300000, threshold: 3, resetMs: 1800000 }, {});
  pruned.recordOutcome('p', false, 0);
  pruned.recordOutcome('p', false, 60000);
  pruned.recordOutcome('p', false, 400000);
  assert.equal(pruned.isDisabled('p', 400000), false);

  const neutral = createPollRewriteBreaker({ windowMs: 300000, threshold: 3, resetMs: 1800000 }, {});
  neutral.recordOutcome('p', false, 0);
  neutral.recordOutcome('p', true, 1000);
  neutral.recordOutcome('p', false, 2000);
  neutral.recordOutcome('p', false, 3000);
  assert.equal(neutral.getState('p').trips, 1);
});

test('AC26: throwing poll rewrite sendAlert is swallowed with a warning', async () => {
  const warns = [];
  const prev = console.warn;
  console.warn = (...args) => warns.push(args.join(' '));
  try {
    const breaker = createPollRewriteBreaker({ windowMs: 300000, threshold: 1, resetMs: 1800000 }, {
      ledger: { shouldSend: () => true, markSent: () => {} },
      sendAlert: () => { throw new Error('alert down'); },
    });
    assert.doesNotThrow(() => breaker.recordOutcome('p', false, 0));
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(warns.some(w => /poll-rewrite alert error/.test(w)));
  } finally {
    console.warn = prev;
  }
});

test('AC34: startup validation rejects pollRewrite projects with panel separator collision', () => {
  assert.throws(() => validateStartupConfig({ pollRewriteProjects: { 'a--b': { panels: ['x'], maxTokens: 1024 } } }), /--.*panel routing/);
  assert.doesNotThrow(() => validateStartupConfig({ pollRewriteProjects: { clean: { panels: ['x'], maxTokens: 1024 } } }));
});

test('AC35/AC36: recordPollRewriteStats sparse node aggregates and pre-v4 fixture remains unchanged', () => {
  const file = tmpStatsFile('stats');
  const prevEnv = process.env.MISER_STATS_FILE;
  try {
    const stats = freshStats(file);
    const nowFn = () => new Date('2026-07-20T12:00:00.000Z');
    stats.recordPollRewriteStats('onlypr', { levers: ['maxTokens', 'thinking'] }, nowFn);
    stats.recordPollRewriteStats('onlypr', { skipped: true }, nowFn);
    stats.recordPollRewriteStats('onlypr', { breakerTrip: true }, nowFn);
    stats.recordPollRewriteStats('onlypr', { levers: ['maxTokens'], breakerTrip: true }, nowFn);
    const result = stats.getStats('30');
    assert.deepEqual(result.perProject.onlypr.pollRewrite, {
      appliedCount: 2,
      leverCounts: { maxTokens: 2, thinking: 1, model: 0 },
      skippedInvalid: 1,
      breakerTrips: 2,
    });
    assert.deepEqual(Object.keys(result.perProject.onlypr), ['pollRewrite', 'anthropicEstCostUSD']);

    const fixtureFile = tmpStatsFile('fixture');
    fs.copyFileSync(path.join(__dirname, 'fixtures-pre-v4-stats-snapshot.json'), fixtureFile);
    const fixtureStats = freshStats(fixtureFile);
    const out = fixtureStats.getStats('30');
    assert.equal(JSON.stringify(out).includes('pollRewrite'), false);
    try { fs.unlinkSync(fixtureFile); } catch (_) {}
  } finally {
    process.env.MISER_STATS_FILE = prevEnv;
    try { fs.unlinkSync(file); } catch (_) {}
  }
});

test('AC43: formatRewriteHeader uses details and deterministic maxTokens/thinking/model order', () => {
  assert.equal(formatRewriteHeader(['maxTokens'], { maxTokens: 1024 }), 'maxTokens=1024');
  assert.equal(formatRewriteHeader(['thinking'], { thinking: 'strip' }), 'thinking=strip');
  assert.equal(formatRewriteHeader(['thinking'], { thinking: 2048 }), 'thinking=2048');
  assert.equal(formatRewriteHeader(['model'], { model: 'claude-haiku-4-5-20251001' }), 'model=claude-haiku-4-5-20251001');
  assert.equal(formatRewriteHeader(['model', 'thinking', 'maxTokens'], {
    maxTokens: 1024,
    thinking: 'strip',
    model: 'claude-haiku-4-5-20251001',
  }), 'maxTokens=1024;thinking=strip;model=claude-haiku-4-5-20251001');
  assert.equal(formatRewriteHeader([], {}), null);
});
