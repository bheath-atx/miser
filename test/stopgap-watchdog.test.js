'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createStopgapWatchdog,
  isRetryableFailure,
  sessionMatchesPanel,
  termdeckProjectName,
} = require('../src/stopgap-watchdog.js');

function requestBody(text = 'retry this turn') {
  return {
    model: 'claude',
    messages: [
      { role: 'user', content: 'older' },
      { role: 'assistant', content: 'working' },
      { role: 'user', content: [{ type: 'text', text }] },
    ],
  };
}

test('state map updates attempts, successes, retryable failures, and original user text', () => {
  let now = 1000;
  const watchdog = createStopgapWatchdog({ nowFn: () => now, client: {} });

  let st = watchdog.recordProxyOutcome({
    project: 'pkachu',
    panel: 'orch',
    statusCode: 500,
    originalBody: requestBody('recover me'),
  });
  assert.equal(st.lastAttemptTs, 1000);
  assert.equal(st.consecutiveRetryableFailures, 1);
  assert.equal(st.lastUserText, 'recover me');

  now = 2000;
  st = watchdog.recordProxyOutcome({
    project: 'pkachu',
    panel: 'orch',
    statusCode: 200,
    originalBody: requestBody(),
  });
  assert.equal(st.lastAttemptTs, 2000);
  assert.equal(st.lastSuccessTs, 2000);
  assert.equal(st.consecutiveRetryableFailures, 0);
  assert.equal(st.resubmitAttempts, 0);

  assert.equal(watchdog.snapshot().length, 1);
});

test('budget-exhausted 429 is excluded from retryable stuck detection', () => {
  assert.equal(isRetryableFailure({ statusCode: 429 }), true);
  assert.equal(isRetryableFailure({
    statusCode: 429,
    headers: { 'x-miser-budget': 'exhausted' },
  }), false);
  assert.equal(isRetryableFailure({
    statusCode: 429,
    headers: { 'X-Miser-Budget': 'exhausted' },
  }), false);

  const watchdog = createStopgapWatchdog({ nowFn: () => 0, client: {} });
  watchdog.recordProxyOutcome({
    project: 'pkachu',
    panel: 'orch',
    statusCode: 529,
    originalBody: requestBody(),
  });
  const st = watchdog.recordProxyOutcome({
    project: 'pkachu',
    panel: 'orch',
    statusCode: 429,
    headers: { 'x-miser-budget': 'exhausted' },
    originalBody: requestBody(),
  });
  assert.equal(st.consecutiveRetryableFailures, 0);
});

test('resubmit aborts when panel recovers before TermDeck input send', async () => {
  let now = 0;
  const sent = [];
  let watchdog;
  const client = {
    async findSession(project, panel) {
      watchdog.recordProxyOutcome({
        project,
        panel,
        statusCode: 200,
        originalBody: requestBody('healthy replacement turn'),
      });
      return { id: 'sid-1', meta: { project, label: `${project}-${panel.toUpperCase()}` } };
    },
    async sendInput(sessionId, text) {
      sent.push({ sessionId, text, at: now });
      return { ok: true };
    },
  };
  watchdog = createStopgapWatchdog({
    nowFn: () => now,
    stallMs: 180000,
    retryWaitMs: 30000,
    sleepFn: async () => {},
    client,
  });

  watchdog.recordProxyOutcome({
    project: 'pkachu',
    panel: 'orch',
    statusCode: 500,
    originalBody: requestBody('please retry the original task'),
  });
  now = 1000;
  watchdog.recordProxyOutcome({
    project: 'pkachu',
    panel: 'orch',
    statusCode: 529,
    originalBody: requestBody('please retry the original task'),
  });

  now = 181000;
  const result = await watchdog.checkOnce();
  assert.equal(result.length, 1);
  assert.equal(result[0].attempted, false);
  assert.equal(result[0].reason, 'recovered_before_send');
  assert.equal(sent.length, 0);

  const [st] = watchdog.snapshot();
  assert.equal(st.consecutiveRetryableFailures, 0);
  assert.equal(st.resubmitAttempts, 0);
  assert.equal(st.lastResubmitTs, 0);
  assert.equal(st.lastSuccessTs, 181000);
});

test('two retryable failures plus stall triggers bare CR, then original body after retry wait', async () => {
  let now = 0;
  const sent = [];
  const client = {
    async findSession(project, panel) {
      return { id: 'sid-1', meta: { project, label: `${project}-${panel.toUpperCase()}` } };
    },
    async sendInput(sessionId, text) {
      sent.push({ sessionId, text, at: now });
      return { ok: true };
    },
  };
  const watchdog = createStopgapWatchdog({
    nowFn: () => now,
    stallMs: 180000,
    retryWaitMs: 30000,
    sleepFn: async () => {},
    client,
  });

  watchdog.recordProxyOutcome({
    project: 'pkachu',
    panel: 'orch',
    statusCode: 500,
    originalBody: requestBody('please retry the original task'),
  });
  now = 1000;
  watchdog.recordProxyOutcome({
    project: 'pkachu',
    panel: 'orch',
    statusCode: 529,
    originalBody: requestBody('please retry the original task'),
  });

  now = 180999;
  assert.deepEqual(await watchdog.checkOnce(), []);
  assert.equal(sent.length, 0);

  now = 181000;
  let result = await watchdog.checkOnce();
  assert.equal(result.length, 1);
  assert.equal(result[0].mode, 'bare-cr');
  assert.deepEqual(sent.map(s => s.text), ['\r']);

  now = 211000;
  result = await watchdog.checkOnce();
  assert.equal(result.length, 1);
  assert.equal(result[0].mode, 'original-body');
  assert.deepEqual(sent.map(s => s.text), [
    '\r',
    '\x1b[200~please retry the original task\x1b[201~',
    '\r',
  ]);
});

test('project-name alias table maps aetheria and panel labels by suffix', () => {
  assert.equal(termdeckProjectName('aetheria'), 'Aetheria-Concierge');
  assert.equal(termdeckProjectName('pkachu'), 'pkachu');
  assert.equal(sessionMatchesPanel({
    meta: { project: 'Aetheria-Concierge', label: 'Aetheria-Concierge-ORCH' },
  }, 'aetheria', 'orch'), true);
  assert.equal(sessionMatchesPanel({
    meta: { project: 'Structural360', label: 'S360-ORCH' },
  }, 'structural360', 'orch'), true);
  assert.equal(sessionMatchesPanel({
    meta: { project: 'unknown', label: 'Aetheria-Concierge-ORCH' },
  }, 'aetheria', 'orch'), false);
});
