'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const statsPath = require.resolve('../src/stats.js');
const capsPath = require.resolve('../src/weekly-caps.js');

function tmpFile(name) {
  return path.join(os.tmpdir(), `miser-factb-${process.pid}-${name}-${Date.now()}-${Math.random()}.json`);
}

function freshStats(statsFile, capsFile, seed = null) {
  delete require.cache[statsPath];
  delete require.cache[capsPath];
  process.env.MISER_STATS_FILE = statsFile;
  process.env.MISER_WEEKLY_CAPS_FILE = capsFile;
  if (seed) fs.writeFileSync(statsFile, JSON.stringify(seed), 'utf8');
  return require('../src/stats.js');
}

function cleanup(stats, files, prev) {
  if (stats && stats.__resetForTest) stats.__resetForTest();
  delete require.cache[statsPath];
  delete require.cache[capsPath];
  if (prev.stats === undefined) delete process.env.MISER_STATS_FILE;
  else process.env.MISER_STATS_FILE = prev.stats;
  if (prev.caps === undefined) delete process.env.MISER_WEEKLY_CAPS_FILE;
  else process.env.MISER_WEEKLY_CAPS_FILE = prev.caps;
  for (const file of files) {
    try { fs.unlinkSync(file); } catch (_) {}
  }
}

function writeCap(file, methodId, value = 1000) {
  const { unitForMethod } = require('../src/weekly-caps.js');
  fs.writeFileSync(file, JSON.stringify({
    schema_version: 1,
    method_id: methodId,
    caps: { claude: { value, unit: unitForMethod(methodId) } },
    cap_source: 'absent',
    thresholds: { ignored: true },
    _comment: 'ignored',
  }), 'utf8');
}

test('Fact B: configured cap_source is derived and weekly routed fraction is scoped', async () => {
  const statsFile = tmpFile('stats');
  const capsFile = tmpFile('caps');
  const prev = { stats: process.env.MISER_STATS_FILE, caps: process.env.MISER_WEEKLY_CAPS_FILE };
  let stats;
  try {
    stats = freshStats(statsFile, capsFile);
    const methodId = stats.__test.MISER_METHOD_ID;
    writeCap(capsFile, methodId, 1000);
    const now = new Date('2026-08-09T12:00:00.000Z');
    stats.__test.setNowFnForTest(() => now);
    stats.recordAnthropicUsage('alpha', 'anthropic', 'claude-sonnet-5', { input_tokens: 100, output_tokens: 20 }, null, () => now);
    await stats.flushNow();
    const result = stats.getStats('7');
    assert.equal(result.pace.scope, 'miser-routed');
    assert.equal(result.pace.capSource, 'configured');
    assert.equal(result.pace.weeklyCap, 1000);
    assert.equal(result.pace.routedConsumedFrac, 0.2);
    assert.equal(result.pace.elapsedFrac > 0, true);
    assert.equal(result.pace.paceAlerting, 'none');
    assert.equal('scope' in { elapsedFrac: result.pace.elapsedFrac }, false);
  } finally {
    cleanup(stats, [statsFile, capsFile], prev);
  }
});

test('Fact B: method mismatch refuses to divide and keeps numerator', async () => {
  const statsFile = tmpFile('stats');
  const capsFile = tmpFile('caps');
  const prev = { stats: process.env.MISER_STATS_FILE, caps: process.env.MISER_WEEKLY_CAPS_FILE };
  let stats;
  try {
    stats = freshStats(statsFile, capsFile);
    writeCap(capsFile, 'othermethod', 1000);
    const now = new Date('2026-08-09T12:00:00.000Z');
    stats.__test.setNowFnForTest(() => now);
    stats.recordAnthropicUsage('alpha', 'anthropic', 'claude-sonnet-5', { input_tokens: 100 }, null, () => now);
    await stats.flushNow();
    const result = stats.getStats('7');
    assert.equal(result.pace.weightedRoutedConsumed, 100);
    assert.equal(result.pace.routedConsumedFrac, null);
    assert.equal(result.pace.unavailableReason, 'unit-mismatch');
  } finally {
    cleanup(stats, [statsFile, capsFile], prev);
  }
});

test('Fact B: unknown model counter records once on response path and reads are idempotent', () => {
  const statsFile = tmpFile('stats');
  const capsFile = tmpFile('caps');
  const prev = { stats: process.env.MISER_STATS_FILE, caps: process.env.MISER_WEEKLY_CAPS_FILE };
  let stats;
  try {
    stats = freshStats(statsFile, capsFile);
    const now = new Date('2026-08-09T12:00:00.000Z');
    stats.recordAnthropicUsage('alpha', 'anthropic', 'claude-test-unknown', { input_tokens: 1 }, null, () => now);
    const first = stats.getStats('7');
    const second = stats.getStats('7');
    assert.equal(first.unpriced_models['claude-test-unknown']['2026-08-09'], 1);
    assert.deepEqual(second.unpriced_models, first.unpriced_models);
    assert.ok(second.pace.degradedReasons.includes('unpriced-models'));
  } finally {
    cleanup(stats, [statsFile, capsFile], prev);
  }
});

test('Fact B: provider limit event records and alerts without cap', async () => {
  const statsFile = tmpFile('stats');
  const capsFile = tmpFile('caps');
  const prev = { stats: process.env.MISER_STATS_FILE, caps: process.env.MISER_WEEKLY_CAPS_FILE };
  let stats;
  try {
    stats = freshStats(statsFile, capsFile);
    const prevAnthropicUrl = process.env.MISER_ANTHROPIC_URL;
    process.env.MISER_ANTHROPIC_URL = 'http://127.0.0.1:9';
    const routerPath = require.resolve('../src/router.js');
    const configPath = require.resolve('../src/config.js');
    delete require.cache[routerPath];
    delete require.cache[configPath];
    const { forwardToAnthropic } = require('../src/router.js');
    const alerts = [];
    const upstream = new EventEmitter();
    upstream.statusCode = 429;
    upstream.headers = { 'content-type': 'application/json' };
    const reqs = [];
    const originalRequest = require('node:http').request;
    try {
      require('node:http').request = (_opts, cb) => {
        process.nextTick(() => cb(upstream));
        const req = new EventEmitter();
        req.write = () => {};
        req.end = () => {};
        reqs.push(req);
        return req;
      };
      const promise = forwardToAnthropic([], { model: 'claude-sonnet-5' }, {}, {}, 'alpha', null, 0, {
        sendAlert: (text, opts) => { alerts.push({ text, opts }); },
      });
      await new Promise(resolve => setImmediate(resolve));
      upstream.emit('data', Buffer.from(JSON.stringify({ error: { type: 'rate_limit_error' } })));
      upstream.emit('end');
      await assert.rejects(() => promise, /quota exhausted/);
    } finally {
      require('node:http').request = originalRequest;
      if (prevAnthropicUrl === undefined) delete process.env.MISER_ANTHROPIC_URL;
      else process.env.MISER_ANTHROPIC_URL = prevAnthropicUrl;
      delete require.cache[routerPath];
      delete require.cache[configPath];
    }
    await new Promise(resolve => setImmediate(resolve));
    const result = stats.getStats('7');
    assert.equal(result.limitEvents.length, 1);
    assert.equal(alerts[0].opts.scope, 'fleet');
    assert.equal(alerts[0].opts.kind, 'limit-event');
  } finally {
    cleanup(stats, [statsFile, capsFile], prev);
  }
});

test('Fact B: source does not reintroduce a second cap source or pace verdict', () => {
  const srcDir = path.join(__dirname, '..', 'src');
  const hits = [];
  for (const file of fs.readdirSync(srcDir).filter(name => name.endsWith('.js'))) {
    const text = fs.readFileSync(path.join(srcDir, file), 'utf8');
    if (/MISER_SUBSCRIPTION/.test(text)) hits.push(`${file}: MISER_SUBSCRIPTION`);
    if (/UNDER-PACE|OVER-PACE|NEAR-CAP|ON-PACE/.test(text)) hits.push(`${file}: pace verdict`);
    if (/thresholds/.test(text)) hits.push(`${file}: thresholds`);
  }
  assert.deepEqual(hits, []);
});
