'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createOutputFilter, parseRtkConfig, __test } = require('../src/outputfilter.js');

const SIZES = [2048, 8192, 32768];
// Keep failure evidence so ECS acceptance cannot mask signature-scan timing.
const SUMMARY = 'summary FAIL';
const ok = stdout => ({ code: 0, stdout, stderr: '', timedOut: false });
const enabled = () => parseRtkConfig({ MISER_RTK_FILTER: '1', MISER_TIER_B_OUTPUT_TRIM: '1' });
const messages = (id, raw) => [
  { role: 'assistant', content: [{ type: 'tool_use', id: 's', name: 'Bash', input: { command: id + ' check' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 's', content: raw }] },
];

// R12's four independent witnesses: multiline whitespace/suffix retries for
// ECS/grep/rg, and overlapping equals/text quantifiers on ONE pytest line.
const WITNESSES = [
  { id: 'ecs', unit: '\n', signature: '  1) problem' },
  { id: 'grep', unit: '\r', signature: 'src/a.js:12:match' },
  { id: 'rg', unit: '\u2028', signature: 'src/a.js:12:match' },
  { id: 'pytest', unit: '=', signature: '=== test session starts ===' },
];

for (const { id, unit, signature } of WITNESSES) {
  for (const latePositive of [false, true]) {
    const shape = latePositive ? 'late positive' : 'rejected';
    test(`R13 scaling: ${id} ${shape} signature stays roughly linear`, { timeout: 60000 }, async t => {
      __test.resetProcessState();
      let versions = 0;
      let filters = 0;
      const filter = createOutputFilter({ ...enabled(), memoEntries: 0, timeoutMs: 10 }, {
        runVersion: async () => { versions++; return ok('rtk 0.48.0\n'); },
        runFilter: async () => { filters++; return ok(SUMMARY); },
      });
      // The x forces the padded prefix to FAIL before the late signature. In
      // particular, blank lines followed directly by an ECS numbered entry
      // would succeed on the old regex's first attempt and miss the bug.
      const inputs = SIZES.map(n => messages(id, unit.repeat(n) + 'x' + (latePositive ? '\n' + signature : '')));
      const verify = (result, input) => {
        assert.equal(result.changed, latePositive);
        assert.equal(result.stats.blocksFiltered, latePositive ? 1 : 0);
        assert.equal(result.stats.memoHits, 0);
        if (latePositive) assert.equal(result.messages[1].content[0].content, SUMMARY);
        else assert.equal(result.messages, input);
      };
      // Exercise the real request path, with no memo or subprocess timeout
      // capable of hiding this synchronous scan. Warm JIT/version for all sizes.
      for (const input of inputs) verify(await filter.applyToMessages(input), input);
      const samples = SIZES.map(() => []);
      let measuredCalls = 0;
      for (let round = 0; round < 3; round++) {
        for (const index of (round % 2 ? [2, 1, 0] : [0, 1, 2])) {
          const started = process.cpuUsage();
          let count = 0;
          let elapsedUs;
          let result;
          do {
            result = await filter.applyToMessages(inputs[index]);
            count++;
            const elapsed = process.cpuUsage(started);
            elapsedUs = elapsed.user + elapsed.system;
          } while (elapsedUs < 20000 && count < 2048);
          measuredCalls += count;
          samples[index].push(elapsedUs / count / 1000);
          verify(result, inputs[index]);
        }
      }
      assert.equal(versions, latePositive ? 1 : 0);
      assert.equal(filters, latePositive ? measuredCalls + SIZES.length : 0);
      assert.equal(filter.memoSize(), 0);
      assert.equal(filter.latch().tripped, false);
      const cpuMs = samples.map(values => values.sort((a, b) => a - b)[1]);
      const growth = [cpuMs[1] / cpuMs[0], cpuMs[2] / cpuMs[1], cpuMs[2] / cpuMs[0]];
      t.diagnostic(JSON.stringify({ id, shape, sizes: SIZES, cpuMs, growth }));
      // Like R10, bound the curve itself: 4x/4x/16x input should cost roughly
      // 4x/4x/16x, not the 16x/16x/256x of quadratic backtracking. CPU medians
      // and repeated batches reduce scheduling/GC noise on fast fixed scans.
      assert.ok(growth[0] < 10 && growth[1] < 10 && growth[2] < 40,
        `nonlinear signature scan: 4x/4x/16x input grew ${growth.map(n => n.toFixed(2)).join('/')}x`);
      assert.ok(cpuMs[2] < 250, `32K ${id} signature used ${cpuMs[2].toFixed(2)}ms CPU`);
    });
  }
}

const SEPARATORS = ['\n', '\r', '\r\n', '\u2028', '\u2029'];
const LINE_CASES = {
  ecs: {
    yes: ['[ERROR] broken', 'Found 2 errors', '1) problem', ' \t\u00a0\ufeff12) problem'],
    no: ['x[ERROR]', ' Found 2 errors', '12)problem', '12x) problem', ' '.repeat(32768) + 'x', '9'.repeat(32768) + 'x'],
    broken: ['12', ') problem'],
  },
  grep: {
    yes: ['a.js:1:match', 'src/a file.js:123:', 'a.js:0:match', 'a'.repeat(32768) + ':12:match'],
    no: [':12:match', 'a.js:match', 'a.js:x:match', 'a.js:12', 'a'.repeat(32768), 'a.js:' + '9'.repeat(32768) + 'x'],
    broken: ['a.js', ':12:match'],
  },
  rg: {
    yes: ['a.js:1:match', 'src/a file.js:123:', 'a.js:0:match', 'a'.repeat(32768) + ':12:match'],
    no: [':12:match', 'a.js:match', 'a.js:x:match', 'a.js:12', 'a'.repeat(32768), 'a.js:' + '9'.repeat(32768) + 'x'],
    broken: ['a.js', ':12:match'],
  },
  pytest: {
    yes: ['===test session starts', '==== FAILURES ====', '=== ERRORS ===', '=== short test summary info ===',
      '=== mixed=delimiter == test session starts ===', '='.repeat(32768) + ' test session starts',
      'platform linux -- Python 3.11.2', 'collected 12 items'],
    no: ['== test session starts', 'test session starts', ' === FAILURES ===', 'platform -- Python ', 'collected x items',
      '='.repeat(32768) + 'x'],
    broken: ['===', 'test session starts'],
  },
};

for (const [id, cases] of Object.entries(LINE_CASES)) {
  test(`R13 gate: ${id} recognizes complete lines and keeps rejected output raw`, async () => {
    __test.resetProcessState();
    let versions = 0;
    let filters = 0;
    const filter = createOutputFilter(enabled(), {
      runVersion: async () => { versions++; return ok('rtk 0.48.0\n'); },
      // Carry failure markers so acceptance cannot mask signature eligibility.
      runFilter: async () => { filters++; return ok('summary FAIL ERROR'); },
    });
    for (const separator of SEPARATORS) {
      for (const [expected, lines] of [[true, cases.yes], [false, [...cases.no, cases.broken.join(separator)]]]) {
        for (const line of lines) {
          const input = messages(id, 'x'.repeat(2048) + separator + line);
          const original = JSON.stringify(input);
          const before = filters;
          const cold = await filter.applyToMessages(input);
          const warm = await filter.applyToMessages(input);
          assert.equal(cold.changed, expected, JSON.stringify({ id, separator, line: line.slice(0, 80) }));
          assert.equal(warm.changed, expected);
          assert.equal(filters - before, expected ? 1 : 0, 'one cold spawn for a match; zero for a rejection or replay');
          assert.equal(warm.stats.memoHits, expected ? 1 : 0);
          if (!expected) {
            assert.equal(cold.messages, input);
            assert.equal(warm.messages, input);
          }
          assert.equal(JSON.stringify(input), original);
        }
      }
    }
    assert.equal(versions, 1);
    assert.equal(filter.latch().tripped, false);
  });
}
