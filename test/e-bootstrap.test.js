'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { guardedEnv } = require('./_state-guard.js');

const {
  buildServerDeps,
  buildProductionDeps,
  startProduction,
} = require('../src/bootstrap.js');
const pollRewrite = require('../src/poll-rewrite.js');
const { wireCacheThrashDeps } = require('../src/cache-thrash.js');

function onConfig(overrides = {}) {
  return {
    pollRewriteProjects: {
      pkachu: {
        panels: ['canary'],
        maxTokens: 1024,
        thinking: 'strip',
        modelMap: { 'claude-opus-4-8': 'claude-haiku-4-5-20251001' },
      },
    },
    pollRewriteBreaker: { windowMs: 300000, threshold: 3, resetMs: 1800000 },
    cacheThrashMinRequests: 3,
    cacheThrashSpikeRatio: 3.0,
    cacheThrashInputSpikeRatio: 2.0,
    cacheThrashRingSize: 50,
    ...overrides,
  };
}

function offConfig(overrides = {}) {
  return {
    pollRewriteProjects: {},
    pollRewriteBreaker: { windowMs: 300000, threshold: 3, resetMs: 1800000 },
    cacheThrashMinRequests: 0,
    cacheThrashSpikeRatio: 3.0,
    cacheThrashInputSpikeRatio: 2.0,
    cacheThrashRingSize: 50,
    ...overrides,
  };
}

function stubLedgerAndAlerts() {
  const alerts = [];
  const sent = new Set();
  return {
    alerts,
    createLedger: () => ({ shouldSend: key => !sent.has(key), markSent: key => sent.add(key) }),
    sendAlert: msg => { alerts.push(msg); },
  };
}

function rawUsage(inputTokens, cacheWrite1h) {
  return { input_tokens: inputTokens, cache_creation_input_tokens: cacheWrite1h };
}

async function tick() {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}

async function waitForFile(file) {
  for (let i = 0; i < 20; i++) {
    if (fs.existsSync(file)) return;
    await tick();
  }
  assert.fail(`expected file to be written: ${file}`);
}

async function driveThrash(guardDeps, project = 'pkachu') {
  for (let i = 0; i < 4; i++) guardDeps.checkCacheThrash(project, 'claude', rawUsage(1000, 100), guardDeps);
  guardDeps.checkCacheThrash(project, 'claude', rawUsage(1000, 500), guardDeps);
  await tick();
}

test('AC45a/b plus B1 clone invariant: buildServerDeps OFF/ON shapes are executable and cloned', async () => {
  const guardDeps = {};
  const off = buildServerDeps(offConfig(), guardDeps);
  assert.equal(off.proxyDeps.guardDeps, guardDeps);
  assert.equal(off.proxyDeps.pollRewrite, null);
  assert.deepEqual(off.rollupOpts, { advisor: { enabled: false } });

  const cfg = onConfig();
  const gd = { ledger: stubLedgerAndAlerts().createLedger(), sendAlert: () => {} };
  const on = buildServerDeps(cfg, gd);
  assert.equal(on.proxyDeps.guardDeps, gd);
  assert.deepEqual(Object.keys(on.proxyDeps.pollRewrite).sort(), ['applyPollRewrite', 'breaker', 'formatRewriteHeader', 'nowFn', 'projects', 'recordPollRewriteStats', 'shouldRewrite'].sort());
  assert.equal(on.proxyDeps.pollRewrite.shouldRewrite, pollRewrite.shouldRewrite);
  assert.equal(on.proxyDeps.pollRewrite.applyPollRewrite, pollRewrite.applyPollRewrite);
  assert.deepEqual(on.rollupOpts, { advisor: { enabled: false } });

  assert.deepEqual(on.proxyDeps.pollRewrite.projects, cfg.pollRewriteProjects);
  assert.notEqual(on.proxyDeps.pollRewrite.projects, cfg.pollRewriteProjects);
  assert.notEqual(on.proxyDeps.pollRewrite.projects.pkachu, cfg.pollRewriteProjects.pkachu);
  assert.notEqual(on.proxyDeps.pollRewrite.projects.pkachu.panels, cfg.pollRewriteProjects.pkachu.panels);
  assert.notEqual(on.proxyDeps.pollRewrite.projects.pkachu.modelMap, cfg.pollRewriteProjects.pkachu.modelMap);
  on.proxyDeps.pollRewrite.projects.pkachu.panels.push('mutated');
  on.proxyDeps.pollRewrite.projects.pkachu.modelMap.extra = 'mutated';
  assert.deepEqual(cfg.pollRewriteProjects.pkachu.panels, ['canary']);
  assert.deepEqual(cfg.pollRewriteProjects.pkachu.modelMap, { 'claude-opus-4-8': 'claude-haiku-4-5-20251001' });

  const prevLedgerEnv = process.env.MISER_ALERT_LEDGER_FILE;
  const ledgerFile = path.join(os.tmpdir(), `miser-e-bootstrap-ledger-${process.pid}-${Date.now()}.json`);
  try {
    process.env.MISER_ALERT_LEDGER_FILE = ledgerFile;
    const clean = buildServerDeps(onConfig(), {});
    assert.equal(clean.proxyDeps.pollRewrite.breaker.recordOutcome('pkachu', false, 0).tripped, false);
    clean.proxyDeps.pollRewrite.breaker.recordOutcome('pkachu', false, 1);
    clean.proxyDeps.pollRewrite.breaker.recordOutcome('pkachu', false, 2);
    assert.equal(clean.proxyDeps.pollRewrite.breaker.getState('pkachu').trips, 1);
    await waitForFile(ledgerFile);
    const parsed = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
    assert.equal(typeof parsed['pollrewrite-breaker:pkachu'], 'string');
  } finally {
    process.env.MISER_ALERT_LEDGER_FILE = prevLedgerEnv;
    try { fs.unlinkSync(ledgerFile); } catch (_) {}
  }
});

test('AC45c/e: buildProductionDeps preserves cache-thrash mutation on one guardDeps object with callable-truthiness fallback', async () => {
  const cfg = onConfig();
  const sentinels = [];
  for (const wireShape of [
    { label: 'spy-real', withWire: true },
    { label: 'missing' },
    { label: 'undefined', value: undefined },
    { label: 'null', value: null },
    { label: 'prototype', protoValue: 'not-a-function' },
    { label: 'proxy', proxy: true },
  ]) {
    const sentinel = {};
    sentinels.push(sentinel);
    const alert = stubLedgerAndAlerts();
    const wireCalls = [];
    const buildCalls = [];
    let seams = {
      buildGuardDeps: () => sentinel,
      buildServerDeps: (c, gd) => {
        buildCalls.push([c, gd]);
        return buildServerDeps(c, gd);
      },
      createLedger: alert.createLedger,
      sendAlert: alert.sendAlert,
    };
    if (wireShape.withWire) {
      seams.wireCacheThrashDeps = (c, gd, t) => {
        wireCalls.push([c, gd, t]);
        return wireCacheThrashDeps(c, gd, t);
      };
    } else if (wireShape.label === 'prototype') {
      seams = Object.assign(Object.create({ wireCacheThrashDeps: wireShape.protoValue }), seams);
    } else if (wireShape.proxy) {
      seams = new Proxy(seams, {
        get(target, prop, receiver) {
          if (prop === 'wireCacheThrashDeps') return 'not-a-function';
          return Reflect.get(target, prop, receiver);
        },
      });
    } else if ('value' in wireShape) {
      seams.wireCacheThrashDeps = wireShape.value;
    }
    const result = buildProductionDeps(cfg, seams);
    if (wireShape.withWire) {
      assert.equal(wireCalls.length, 1);
      assert.deepEqual(wireCalls[0], [cfg, sentinel, seams]);
    }
    assert.equal(buildCalls.length, 1);
    assert.deepEqual(buildCalls[0], [cfg, sentinel]);
    assert.equal(result.guardDeps, sentinel);
    assert.equal(result.proxyDeps.guardDeps, sentinel);
    assert.equal(typeof sentinel.checkCacheThrash, 'function');
    assert.equal(typeof sentinel.getCacheThrashStatus, 'function');
    await driveThrash(sentinel);
    assert.equal(alert.alerts.filter(msg => /cache-thrash/.test(msg)).length, 1, wireShape.label);
    result.proxyDeps.pollRewrite.breaker.recordOutcome('pkachu', false, 0);
    result.proxyDeps.pollRewrite.breaker.recordOutcome('pkachu', false, 1);
    result.proxyDeps.pollRewrite.breaker.recordOutcome('pkachu', false, 2);
    await tick();
    assert.equal(alert.alerts.filter(msg => /poll-rewrite breaker/.test(msg)).length, 1, wireShape.label);
    assert.deepEqual(result.rollupOpts, { advisor: { enabled: false } });
  }

  const runtime = runtimeStubs();
  const prod = startProduction(cfg, runtime);
  assert.equal(Object.keys(runtime).sort().join(','), 'createProxy,createServer,getRawStatsSnapshot,startDailyRollupInterval');
  assert.equal(prod.proxyDeps.guardDeps, prod.guardDeps);
  assert.equal(typeof prod.guardDeps.checkCacheThrash, 'function');
  assert.equal(typeof prod.guardDeps.getCacheThrashStatus, 'function');

  const alert = stubLedgerAndAlerts();
  const observed = startProduction(cfg, runtimeStubs(), {
    createLedger: alert.createLedger,
    sendAlert: alert.sendAlert,
  });
  await driveThrash(observed.guardDeps);
  assert.equal(alert.alerts.filter(msg => /cache-thrash/.test(msg)).length, 1);
});

function runtimeStubs() {
  const calls = [];
  let listened = false;
  const runtime = {
    createServer(listener) {
      calls.push(['createServer', listener]);
      return { listener, listen: () => { listened = true; } };
    },
    createProxy(proxyDeps) {
      calls.push(['createProxy', proxyDeps]);
      return { marker: 'listener' };
    },
    startDailyRollupInterval(getRawStatsSnapshot, rollupOpts) {
      calls.push(['rollup', getRawStatsSnapshot, rollupOpts]);
      return { marker: 'timer' };
    },
    getRawStatsSnapshot() { return {}; },
  };
  Object.defineProperties(runtime, {
    _calls: { value: calls },
    _listened: { value: () => listened },
  });
  return runtime;
}

test('AC45d: startProduction composes proxy/server/rollup with third-parameter testSeams only and never listens', () => {
  const cfg = onConfig();
  const sentinel = {};
  const runtime = runtimeStubs();
  const testSeams = {
    buildGuardDeps: () => sentinel,
    wireCacheThrashDeps,
    buildServerDeps,
    ...stubLedgerAndAlerts(),
  };
  const result = startProduction(cfg, runtime, testSeams);
  assert.equal(runtime._calls[0][0], 'createProxy');
  assert.equal(runtime._calls[0][1], result.proxyDeps);
  assert.equal(runtime._calls[0][1].guardDeps, sentinel);
  assert.equal(runtime._calls[1][0], 'createServer');
  assert.deepEqual(runtime._calls[1][1], { marker: 'listener' });
  assert.equal(result.server.listener.marker, 'listener');
  assert.equal(runtime._calls[2][0], 'rollup');
  assert.equal(runtime._calls[2][1], runtime.getRawStatsSnapshot);
  assert.equal(runtime._calls[2][2], result.rollupOpts);
  assert.equal(runtime._listened(), false);

  const sentinel2 = {};
  const fallback = startProduction(cfg, runtimeStubs(), {
    buildGuardDeps: () => sentinel2,
    buildServerDeps,
    ...stubLedgerAndAlerts(),
  });
  assert.equal(fallback.proxyDeps.guardDeps, sentinel2);
  assert.equal(typeof sentinel2.checkCacheThrash, 'function');
});

test('AC45 hygiene: index.js is a thin startProduction caller without direct guard wiring', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  assert.match(src, /startProduction\(config,\s*\{/);
  assert.doesNotMatch(src, /buildGuardDeps|wireCacheThrashDeps|buildServerDeps/);
});

test('AC46: config env reaches pollRewrite fields and validates panel collision in fresh processes', () => {
  const node = process.execPath;
  const configPath = path.join(__dirname, '..', 'src', 'config.js');
  const baseEnv = { PATH: process.env.PATH, HOME: process.env.HOME, ...guardedEnv() };
  function run(env, validate = false) {
    return spawnSync(node, ['-e', `
      const config = require(${JSON.stringify(configPath)});
      ${validate ? 'config.validateStartupConfig(config);' : ''}
      process.stdout.write(JSON.stringify({
        pollRewriteProjects: config.pollRewriteProjects,
        pollRewriteBreaker: config.pollRewriteBreaker,
        hasProjects: Object.prototype.hasOwnProperty.call(config, 'pollRewriteProjects'),
        hasBreaker: Object.prototype.hasOwnProperty.call(config, 'pollRewriteBreaker')
      }));
    `], { env: { ...baseEnv, ...env }, encoding: 'utf8' });
  }

  let child = run({});
  assert.equal(child.status, 0, child.stderr);
  let out = JSON.parse(child.stdout);
  assert.deepEqual(out.pollRewriteProjects, {});
  assert.deepEqual(out.pollRewriteBreaker, { windowMs: 300000, threshold: 3, resetMs: 1800000 });
  assert.equal(out.hasProjects, true);
  assert.equal(out.hasBreaker, true);

  child = run({ MISER_POLL_REWRITE: '{"pkachu":{"panels":["orch"],"maxTokens":1024}}' });
  assert.equal(child.status, 0, child.stderr);
  out = JSON.parse(child.stdout);
  assert.deepEqual(out.pollRewriteProjects.pkachu, { panels: ['orch'], maxTokens: 1024 });

  child = run({
    MISER_POLL_REWRITE: '{"pkachu":{"panels":["orch"],"maxTokens":1024}}',
    MISER_POLL_REWRITE_BREAKER_THRESHOLD: '0',
  });
  assert.equal(child.status, 0, child.stderr);
  out = JSON.parse(child.stdout);
  assert.deepEqual(out.pollRewriteProjects, {});
  assert.equal(out.pollRewriteBreaker, null);

  child = run({ MISER_POLL_REWRITE: '{"a--b":{"panels":["x"],"maxTokens":1024}}' }, true);
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /--/);
  assert.match(child.stderr, /panel routing/);
});
