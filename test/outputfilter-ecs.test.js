'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createOutputFilter, parseRtkConfig, FILTER_SPECS, __test } = require('../src/outputfilter.js');
const { ECS_SUCCESS, ECS_CLEAN, failingEcsDryRun, sourceDerivedEcs } = require('./fixtures/rtk-ecs.js');

const ok = stdout => ({ code: 0, stdout, stderr: '', timedOut: false });
const config = over => ({
  ...parseRtkConfig({ MISER_RTK_FILTER: '1', MISER_TIER_B_OUTPUT_TRIM: '1' }), ...over,
});

function messages(text, kind = 'string', errorField = 'absent') {
  const content = kind === 'string' ? text : [{ type: 'text', text, cache_control: { type: 'ephemeral' } }];
  const result = { type: 'tool_result', tool_use_id: 'ecs', content };
  if (errorField !== 'absent') result.is_error = errorField;
  return [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'ecs', name: 'Bash', input: { command: 'ecs check src --no-ansi' } }] },
    { role: 'user', content: [result] },
  ];
}

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function harness(over = {}, runner = sourceDerivedEcs) {
  __test.resetProcessState();
  const calls = { version: 0, filter: 0 };
  const filter = createOutputFilter(config(over), {
    runVersion: async () => { calls.version++; return ok('rtk 0.48.0\n'); },
    runFilter: async (id, text) => {
      assert.equal(id, 'ecs');
      calls.filter++;
      return ok(runner(text));
    },
  });
  return { filter, calls };
}

for (const memoEntries of [0, 2048]) for (const kind of ['string', 'single-text']) {
  for (const errorField of ['absent', false, true]) {
    test(`R15 ECS: exact R14 dry-run stays raw (memo=${memoEntries}, ${kind}, is_error=${errorField})`, async () => {
      const raw = failingEcsDryRun();
      assert.equal(Buffer.byteLength(raw), 3808);
      assert.equal(sourceDerivedEcs(raw), ECS_SUCCESS, 'retain the pinned RTK bug in the runner');
      assert.equal(FILTER_SPECS.ecs.signature.test(raw), true, 'exercise acceptance, not an eligibility shortcut');
      const input = freeze(messages(raw, kind, errorField));
      const snapshot = JSON.stringify(input);
      const { filter, calls } = harness({ memoEntries });
      const cold = await filter.applyToMessages(input);
      const warm = await filter.applyToMessages(input);
      for (const result of [cold, warm]) {
        assert.equal(result.changed, false, 'a diff containing the success literal must never become success');
        assert.equal(result.messages, input, 'preserve raw ANSI/content/metadata bytes and shape');
        assert.equal(result.stats.blocksRawPinned, 1);
        assert.equal(result.stats.blocksFiltered, 0);
        assert.equal(result.stats.bytesRemoved, 0);
      }
      assert.equal(cold.stats.memoHits, 0);
      assert.equal(warm.stats.memoHits, memoEntries ? 1 : 0);
      assert.deepEqual(calls, { version: 1, filter: memoEntries ? 1 : 2 });
      assert.equal(filter.memoSize(), memoEntries ? 1 : 0, 'memoize the deterministic raw decision');
      assert.equal(filter.latch().tripped, false, 'fidelity rejection is not a subprocess fault');
      assert.equal(JSON.stringify(input), snapshot);
    });
  }
}

const MARKERS = [
  '1) src/Status.php',
  '123) src/a file.php',
  '[ERROR] broken checker',
  '[WARNING] check needs attention',
  'Found 1 error that needs to be fixed manually.',
  'Found 12 errors that need to be fixed manually.',
  '1 error is fixable! Just add "--fix" to console command and rerun to apply.',
  '12 errors are fixable! Just add "--fix" to console command and rerun to apply.',
  'Good news is that 2 errors are fixable! Just add "--fix" to console command and rerun to apply.',
  '---------- begin diff ----------',
];

test('R15 ECS: each native failure signal survives ANSI, indentation and line boundaries', () => {
  for (const separator of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
    for (const marker of MARKERS) {
      for (const decorated of [marker, `\x1b[1;33m${marker}\x1b[0m`, `\x9b33m${marker}\x9b0m`]) {
        const raw = ECS_CLEAN.trimEnd() + separator + '\t \u00a0\ufeff' + decorated;
        assert.equal(__test.hasFailureMarker(raw, 'ecs'), true, JSON.stringify({ separator, decorated }));
        assert.equal(__test.hasFailureMarker(`ordinary text ${marker}`, 'ecs'), false, 'match anchored output lines');
      }
      for (const id of Object.keys(FILTER_SPECS).filter(id => id !== 'ecs')) {
        assert.equal(__test.hasFailureMarker(marker, id), false, `ECS signals must stay scoped: ${id}`);
      }
    }
  }
  assert.equal(__test.hasFailureMarker('[\x1b[31mERROR\x1b[0m] broken', 'ecs'), true);
  assert.equal(__test.hasFailureMarker('[\x1b[33mWARNING\x1b[0m] check needs attention', 'ecs'), true);
});

test('R15 ECS: each isolated failure signal defeats a coexisting success literal on cold and warm paths', async () => {
  for (const marker of MARKERS) for (const decorated of [marker, `\x1b[33m${marker}\x1b[0m`]) {
    // A synthetic zero-count line passes the unchanged candidate gate without
    // contributing a failure itself, isolating each signal at acceptance.
    const raw = 'Found 0 errors\n' + ' '.repeat(2048) + '\n' + ECS_CLEAN + decorated + '\n';
    const input = freeze(messages(raw));
    const { filter, calls } = harness();
    const cold = await filter.applyToMessages(input);
    const warm = await filter.applyToMessages(input);
    assert.equal(cold.changed, false, marker);
    assert.equal(cold.messages, input);
    assert.equal(warm.messages, input);
    assert.equal(cold.stats.blocksRawPinned, 1);
    assert.equal(warm.stats.memoHits, 1);
    assert.deepEqual(calls, { version: 1, filter: 1 });
    assert.equal(filter.latch().tripped, false);
  }
});

test('R15 ECS: genuine clean output has no failure signals and preserves existing gate behavior', async () => {
  for (const raw of [ECS_CLEAN, `\x1b[32m${ECS_CLEAN.trimEnd()}\x1b[0m\n`, ' '.repeat(2048) + '\n' + ECS_CLEAN]) {
    const input = freeze(messages(raw));
    const { filter, calls } = harness({ minBytes: 0, minGainBytes: 1 });
    assert.equal(sourceDerivedEcs(raw), ECS_SUCCESS);
    assert.equal(__test.hasFailureMarker(raw, 'ecs'), false);
    assert.equal(__test.hasFailureMarker(ECS_SUCCESS, 'ecs'), false);
    // R13's conservative signature already excludes pure [OK] successes.
    // EF1 must not widen that gate or start classifying them as failures.
    assert.equal(FILTER_SPECS.ecs.signature.test(raw), false);
    for (let replay = 0; replay < 2; replay++) {
      const result = await filter.applyToMessages(input);
      assert.equal(result.messages, input);
      assert.equal(result.stats.blocksRawPinned, 0);
      assert.equal(result.stats.memoHits, 0);
    }
    assert.deepEqual(calls, { version: 0, filter: 0 });
  }
});

test('R15 ECS: a clean zero-count candidate still accepts and memoizes RTK success', async () => {
  // Synthetic admission control: zero is not a failure, and the literal alone
  // must not cause a blanket ECS rejection. Native [OK] output is tested above.
  const raw = 'Found 0 errors\n' + ' '.repeat(2048) + '\n' + ECS_CLEAN;
  for (const kind of ['string', 'single-text']) {
    const input = freeze(messages(raw, kind));
    const { filter, calls } = harness();
    assert.equal(__test.hasFailureMarker(raw, 'ecs'), false);
    for (let replay = 0; replay < 2; replay++) {
      const result = await filter.applyToMessages(input);
      assert.equal(result.changed, true);
      assert.equal(result.stats.blocksFiltered, 1);
      assert.equal(result.stats.memoHits, replay);
      const expected = messages(ECS_SUCCESS, kind);
      assert.deepEqual(result.messages, expected, 'preserve single-text metadata on accepted success');
    }
    assert.deepEqual(calls, { version: 1, filter: 1 });
  }
});

test('R15 ECS: faithful failure summaries remain eligible for filtering and memo replay', async () => {
  const withoutLiteral = failingEcsDryRun().replaceAll('No errors found', 'No issues found');
  for (const [raw, runner, summary] of [
    [withoutLiteral, sourceDerivedEcs, '1) src/Status.php'],
    [failingEcsDryRun(), () => '[WARNING] 1 error is fixable!', '[WARNING] 1 error is fixable!'],
    [failingEcsDryRun(), () => '[ERROR] Found 1 error', '[ERROR] Found 1 error'],
  ]) {
    const input = freeze(messages(raw));
    const { filter, calls } = harness({}, runner);
    for (let replay = 0; replay < 2; replay++) {
      const result = await filter.applyToMessages(input);
      assert.equal(result.changed, true, 'failure evidence in filtered output remains useful');
      assert.equal(result.messages[1].content[0].content, summary);
      assert.equal(result.stats.memoHits, replay);
    }
    assert.deepEqual(calls, { version: 1, filter: 1 });
    assert.equal(filter.latch().tripped, false);
  }
});
