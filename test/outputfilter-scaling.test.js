'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createOutputFilter, parseRtkConfig, __test } = require('../src/outputfilter.js');

const SIZES = [4096, 16384, 65536];
const SUMMARY = 'Prettier: All files formatted correctly';
const ok = stdout => ({ code: 0, stdout, stderr: '', timedOut: false });

// Use the real acceptance path with immediate runners and memo disabled: a
// subprocess timeout or warm memo must not hide synchronous scanning cost.
// CPU time avoids charging other concurrently running test files to this one.
// Repeated batches and medians keep fast, linear scans above timer noise.
for (const [shape, padding] of [
  ['R9 newlines', n => '\n'.repeat(n)],
  ['whitespace lines', n => ' \t\r\n'.repeat(n / 4)],
  ['one long whitespace line', n => ' '.repeat(n)],
  ['interrupted ANSI controls', n => ('\x1b[' + ';'.repeat(30)).repeat(n / 32)],
]) {
  test(`R10 scaling: acceptance stays roughly linear for ${shape}`, { timeout: 60000 }, async t => {
    __test.resetProcessState();
    let calls = 0;
    const filter = createOutputFilter({
      ...parseRtkConfig({ MISER_RTK_FILTER: '1', MISER_TIER_B_OUTPUT_TRIM: '1' }),
      memoEntries: 0,
    }, {
      runVersion: async () => ok('rtk 0.48.0\n'),
      runFilter: async () => { calls++; return ok(SUMMARY); },
    });
    const messages = SIZES.map(n => [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'p', name: 'Bash', input: { command: 'prettier --check config/' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'p', content: 'Checking formatting...\n' + padding(n) + 'x' }] },
    ]);
    // Warm every size before measurement, including version verification.
    for (const input of messages) {
      assert.equal((await filter.applyToMessages(input)).changed, true);
    }
    const samples = SIZES.map(() => []);
    let measuredCalls = 0;
    for (let round = 0; round < 3; round++) {
      for (const index of (round % 2 ? [2, 1, 0] : [0, 1, 2])) {
        const started = process.cpuUsage();
        let count = 0;
        let elapsedUs;
        let result;
        do {
          result = await filter.applyToMessages(messages[index]);
          count++;
          const elapsed = process.cpuUsage(started);
          elapsedUs = elapsed.user + elapsed.system;
        } while (elapsedUs < 20000 && count < 256);
        measuredCalls += count;
        samples[index].push(elapsedUs / count / 1000);
        assert.equal(result.messages[1].content[0].content, SUMMARY);
        assert.equal(result.stats.blocksFiltered, 1);
        assert.equal(result.stats.memoHits, 0);
      }
    }
    assert.equal(calls, measuredCalls + SIZES.length, 'every timed call must scan, with no memo shortcut');
    const cpuMs = samples.map(values => values.sort((a, b) => a - b)[1]);
    const growth = [cpuMs[1] / cpuMs[0], cpuMs[2] / cpuMs[1], cpuMs[2] / cpuMs[0]];
    t.diagnostic(JSON.stringify({ shape, sizes: SIZES, cpuMs, growth }));
    // 4x input should cost about 4x, with headroom for GC and scheduling.
    // Quadratic retry costs about 16x per step / 256x overall and fails these
    // growth bounds even if an absolute timeout happens to pass on a fast CPU.
    assert.ok(growth[0] < 10 && growth[1] < 10 && growth[2] < 40,
      `nonlinear scan: 4x/4x/16x input grew ${growth.map(n => n.toFixed(2)).join('/')}x`);
    assert.ok(cpuMs[2] < 250, `65K acceptance used ${cpuMs[2].toFixed(2)}ms CPU`);
  });
}
