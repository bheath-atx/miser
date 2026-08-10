'use strict';

// G6 unit + integration tests — AC1–AC9.
// All offline: buildMetricsText is a pure function; the proxy handler test uses
// createProxy with no live socket (mock transport for the anthropic leg).

const os   = require('node:os');
const path = require('node:path');
process.env.MISER_STATS_FILE = path.join(os.tmpdir(), `miser-metrics-test-${process.pid}-${Date.now()}.json`);

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildMetricsText, labelEscape } = require('../src/metrics.js');
const { computeCost } = require('../src/pricing.js');
const { classifyRoute } = require('../src/routing.js');
const { createProxy } = require('../src/proxy.js');
const { makeRes } = require('./_harness.js');

// ---- Helpers ----------------------------------------------------------------

function fakeGetReq(url) {
  const listeners = {};
  const req = {
    method: 'GET', url, headers: {},
    on(evt, cb) { listeners[evt] = cb; return req; },
  };
  process.nextTick(() => {
    if (listeners.end) listeners.end();
  });
  return req;
}

function runGetHandler(handler, url) {
  return new Promise((resolve) => {
    const res = makeRes();
    const origEnd = res.end.bind(res);
    res.end = (chunk) => { origEnd(chunk); resolve(res); return res; };
    handler(fakeGetReq(url), res);
  });
}

const SAMPLE_USAGE = {
  pkachu: {
    anthropic: {
      'claude-sonnet-4-6': { input: 1000000, output: 200000, cacheRead: 500000, cacheWrite1h: 100000, requests: 10 },
    },
  },
};

// ---- AC9: labelEscape isolated unit test ------------------------------------

test('AC9: labelEscape — double-quote', () => {
  assert.equal(labelEscape('a"b'), 'a\\"b');
});

test('AC9: labelEscape — backslash', () => {
  assert.equal(labelEscape('a\\b'), 'a\\\\b');
});

test('AC9: labelEscape — newline', () => {
  assert.equal(labelEscape('a\nb'), 'a\\nb');
});

test('AC9: labelEscape — clean string is a no-op', () => {
  assert.equal(labelEscape('normal-name_1.2'), 'normal-name_1.2');
});

// ---- AC2: HELP/TYPE headers -------------------------------------------------

test('AC2: HELP and TYPE headers present for all three metric families', () => {
  const text = buildMetricsText({ usage: SAMPLE_USAGE });
  assert.ok(text.includes('# HELP miser_tokens_7d'));
  assert.ok(text.includes('# TYPE miser_tokens_7d gauge'));
  assert.ok(text.includes('# HELP miser_requests_7d'));
  assert.ok(text.includes('# TYPE miser_requests_7d gauge'));
  assert.ok(text.includes('# HELP miser_cost_usd_7d'));
  assert.ok(text.includes('# TYPE miser_cost_usd_7d gauge'));
  assert.ok(!text.includes('_total'), 'No _total metric names should appear');
});

test('R8: authority and rejection gauges expose concrete stats authority state', () => {
  const text = buildMetricsText({
    usage: SAMPLE_USAGE,
    authoritative: false,
    degraded: true,
    persistence: {
      healthy: false,
      durable: false,
      pending: true,
      dirty: true,
      inFlight: false,
      lastFlushErrored: true,
      lastLoadErrored: false,
      writeFailures: 3,
      lastErrorCode: 'WRITE_ERROR',
      lastErrorMessage: 'disk said no',
    },
    weeklyAuthoritative: false,
    nonAuthoritativeWeekCount: 2,
    nonAuthoritativeReasons: ['missing_daily_observation', 'persistence_degraded'],
    recordRejections: {
      total: 4,
      invalidTimestamp: 1,
      outOfBoundsTimestamp: 2,
      loadFailureRefusal: 1,
      byLabel: {
        usage: 3,
        optimizer: 1,
      },
    },
  });

  assert.ok(text.includes('# HELP miser_authoritative'));
  assert.ok(text.includes('# TYPE miser_authoritative gauge'));
  assert.ok(text.includes('miser_authoritative 0\n'));
  assert.ok(text.includes('miser_degraded 1\n'));
  assert.ok(text.includes('miser_persistence_healthy 0\n'));
  assert.ok(text.includes('miser_persistence_durable 0\n'));
  assert.ok(text.includes('miser_persistence_pending 1\n'));
  assert.ok(text.includes('miser_persistence_dirty 1\n'));
  assert.ok(text.includes('miser_persistence_in_flight 0\n'));
  assert.ok(text.includes('miser_persistence_last_flush_errored 1\n'));
  assert.ok(text.includes('miser_persistence_last_load_errored 0\n'));
  assert.ok(text.includes('miser_persistence_write_failures 3\n'));
  assert.ok(text.includes('miser_persistence_last_error{code="WRITE_ERROR"} 1'));
  assert.ok(!text.includes('disk said no'));
  assert.ok(text.includes('miser_weekly_authoritative 0\n'));
  assert.ok(text.includes('miser_non_authoritative_weeks 2\n'));
  assert.ok(text.includes('miser_non_authoritative_week_reasons{reason="missing_daily_observation"} 1'));
  assert.ok(text.includes('miser_non_authoritative_week_reasons{reason="persistence_degraded"} 1'));
  assert.ok(text.includes('miser_record_rejections{reason="total"} 4'));
  assert.ok(text.includes('miser_record_rejections{reason="invalidTimestamp"} 1'));
  assert.ok(text.includes('miser_record_rejections{reason="outOfBoundsTimestamp"} 2'));
  assert.ok(text.includes('miser_record_rejections{reason="loadFailureRefusal"} 1'));
  assert.ok(text.includes('miser_record_rejections_by_label{label="optimizer"} 1'));
  assert.ok(text.includes('miser_record_rejections_by_label{label="usage"} 3'));
});

test('Fact B: metrics expose unpriced and routed-scope pace gauges without verdicts', () => {
  const text = buildMetricsText({
    usage: {},
    unpriced_models: { 'claude-test-unknown': { '2026-08-09': 2 } },
    limitEvents: [{ status: 429 }],
    pace: {
      weightedRoutedConsumed: 250,
      routedConsumedFrac: 0.25,
      routedPaceDelta: -0.1,
    },
  });
  assert.match(text, /miser_unpriced_requests_7d\{model="claude-test-unknown"\} 2/);
  assert.match(text, /# HELP miser_routed_consumed_frac Miser-routed fraction of configured weekly cap/);
  assert.match(text, /miser_routed_consumed_frac 0\.25/);
  assert.match(text, /miser_routed_pace_delta -0\.1/);
  assert.match(text, /miser_limit_events_7d 1/);
  assert.doesNotMatch(text, /UNDER-PACE|OVER-PACE|NEAR-CAP|ON-PACE/);
});

test('Fact B: metrics omit estimated cap percentage gauges because range cannot render', () => {
  const text = buildMetricsText({
    usage: {},
    pace: {
      capSource: 'estimated',
      weightedRoutedConsumed: 250,
      routedConsumedFrac: 0.25,
      routedPaceDelta: -0.1,
      capRange: { low: 500, high: 1000 },
    },
  });
  assert.match(text, /estimated denominators are omitted because Prometheus cannot render the required range marker/);
  assert.doesNotMatch(text, /^miser_routed_consumed_frac /m);
  assert.doesNotMatch(text, /^miser_routed_pace_delta /m);
  assert.match(text, /^miser_routed_weighted_tokens_week_to_date 250$/m);
});

// ---- AC3: Prometheus compliance (comprehensive) -----------------------------

test('AC3: Prometheus compliance — label escaping, format, and trailing newline', () => {
  const complexUsage = {
    'alpha': {
      'anthropic': {
        'claude-sonnet-4-6': { input: 1000, output: 200, cacheRead: 500, requests: 5 },
        'model-with-"quote': { input: 300, output: 60, requests: 2 },
        'model-with-\\slash': { input: 400, output: 70, requests: 1 },
        'model-with-\nnewline': { input: 500, output: 80, requests: 1 },
      },
      'openai': {
        'gpt-4': { input: 200, output: 40, requests: 3 },
      },
    },
    'beta': {
      'anthropic': {
        'claude-haiku-4-5': { input: 800, output: 150, cacheWrite1h: 100, requests: 7 },
      },
    },
  };

  const text = buildMetricsText({ usage: complexUsage });

  // All three families present
  assert.ok(text.includes('# HELP miser_tokens_7d'));
  assert.ok(text.includes('# HELP miser_requests_7d'));
  assert.ok(text.includes('# HELP miser_cost_usd_7d'));

  // Every data line matches the required format
  const dataLines = text.split('\n').filter(l => l.length > 0 && !l.startsWith('#'));
  const lineRe = /^miser_[a-z_]+_7d\{[^}]+\} [0-9]+(\.[0-9]+)?$/;
  for (const line of dataLines) {
    assert.match(line, lineRe, `line did not match format: ${line}`);
  }

  // Escaped characters
  assert.ok(text.includes('\\"quote'), 'double-quote should be escaped as \\"');
  assert.ok(text.includes('\\\\slash'), 'backslash should be escaped as \\\\');
  assert.ok(text.includes('\\nnewline'), 'newline should be escaped as \\n');
  // No literal unescaped quote inside a label value (all " open/close label values)
  // The pattern `model="...<UNESCAPED ">"` would be `model="abc"def"` — test by
  // checking the escaped forms appear and literal mid-value quotes don't:
  assert.ok(!text.match(/model="[^"]*[^\\]"[^,}]/), 'no unescaped " inside label value');

  // Output ends with \n
  assert.equal(text[text.length - 1], '\n', 'output must end with newline');

  // Requests count present and correct
  assert.ok(text.includes('miser_requests_7d{project="alpha",provider="anthropic",model="claude-sonnet-4-6"} 5'));
});

// ---- AC3b: exact cost value -------------------------------------------------

test('AC3b: cost value matches computeCost(statsResult.usage[project])', () => {
  const projectUsage = {
    anthropic: {
      'claude-sonnet-4-6': { input: 1000, output: 200, cacheRead: 0, cacheWrite1h: 0, cacheWrite5m: 0, requests: 1 },
    },
  };
  const statsResult = { usage: { testproject: projectUsage } };
  const text = buildMetricsText(statsResult);
  const expectedCost = computeCost(projectUsage);
  assert.ok(expectedCost > 0, 'cost must be > 0 for known token counts');
  assert.ok(
    text.includes(`miser_cost_usd_7d{project="testproject"} ${expectedCost}`),
    `cost line not found for ${expectedCost}`,
  );
});

// ---- AC4: type label vocabulary ---------------------------------------------

test('AC4: type label values are exactly from the allowed vocabulary', () => {
  const usage = {
    proj: {
      anthropic: {
        model1: { input: 100, output: 50, cacheRead: 200, cacheWrite1h: 10, cacheWrite5m: 5, requests: 1 },
      },
    },
  };
  const text = buildMetricsText({ usage });
  const typeRe = /type="([^"]+)"/g;
  const allowed = new Set(['input', 'output', 'cache_read', 'cache_write_1h', 'cache_write_5m']);
  let match;
  while ((match = typeRe.exec(text)) !== null) {
    assert.ok(allowed.has(match[1]), `unexpected type label: ${match[1]}`);
  }
});

// ---- AC5: zero-value lines not emitted -------------------------------------

test('AC5: lines with value 0 are not emitted (sparse)', () => {
  const usage = {
    proj: {
      anthropic: {
        model1: { input: 100, output: 0, cacheRead: 0, cacheWrite1h: 0, requests: 1 },
      },
    },
  };
  const text = buildMetricsText({ usage });
  // Only 'input' is non-zero; output/cacheRead/cacheWrite1h should not appear
  assert.ok(text.includes('type="input"'), 'input should appear');
  assert.ok(!text.includes('type="output"'), 'output=0 should not appear');
  assert.ok(!text.includes('type="cache_read"'), 'cache_read=0 should not appear');
  assert.ok(!text.includes('type="cache_write_1h"'), 'cache_write_1h=0 should not appear');
});

// ---- AC6: requests lines present when requests > 0 -------------------------

test('AC6: miser_requests_7d lines appear for buckets with requests > 0', () => {
  const text = buildMetricsText({ usage: SAMPLE_USAGE });
  assert.ok(text.includes('miser_requests_7d{project="pkachu",provider="anthropic",model="claude-sonnet-4-6"} 10'));
});

// ---- AC7: empty stats → only headers, still ends with \n -------------------

test('AC7: empty stats produces only HELP/TYPE headers, ends with newline', () => {
  const text = buildMetricsText({ usage: {} });
  assert.ok(text.includes('# HELP miser_tokens_7d'));
  const dataLines = text.split('\n').filter(l => l.length > 0 && !l.startsWith('#'));
  assert.equal(dataLines.length, 0, 'no data lines for empty stats');
  assert.equal(text[text.length - 1], '\n', 'still ends with newline');
});

test('AC7: null/undefined stats produces only headers', () => {
  const text = buildMetricsText(null);
  assert.ok(text.includes('# HELP miser_tokens_7d'));
  const dataLines = text.split('\n').filter(l => l.length > 0 && !l.startsWith('#'));
  assert.equal(dataLines.length, 0);
});

// ---- AC1 + AC8: GET /api/miser/metrics endpoint (proxy integration) --------

test('AC1: GET /api/miser/metrics returns 200 with correct content-type', async () => {
  const handler = createProxy({
    transports: {
      anthropic: (msgs, body, hdrs, res) => {
        res.writeHead(200, {}); res.end(); return Promise.resolve();
      },
    },
  });
  const res = await runGetHandler(handler, '/api/miser/metrics');
  assert.equal(res.statusCode, 200);
  const ct = res.headers['content-type'] || '';
  assert.ok(ct.includes('text/plain'), `content-type should be text/plain, got: ${ct}`);
  assert.ok(ct.includes('version=0.0.4'), `content-type should include version=0.0.4, got: ${ct}`);
});

test('AC8: GET /api/miser/stats still returns JSON (no regression)', async () => {
  const handler = createProxy({
    transports: {
      anthropic: (msgs, body, hdrs, res) => {
        res.writeHead(200, {}); res.end(); return Promise.resolve();
      },
    },
  });
  const res = await runGetHandler(handler, '/api/miser/stats');
  assert.equal(res.statusCode, 200);
  const ct = res.headers['content-type'] || '';
  assert.ok(ct.includes('application/json'), `should be JSON, got: ${ct}`);
  const body = JSON.parse(res.body());
  assert.equal(body.ok, true);
});

test('routing: classifyRoute GET /api/miser/metrics → metrics kind', () => {
  assert.deepEqual(classifyRoute('GET', '/api/miser/metrics'), { kind: 'metrics' });
});
