'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { parseHeadroomConfig, createHeadroomFilter } = require('../src/headroom.js');
const cfg = parseHeadroomConfig({ MISER_HEADROOM: '1' });
const prose = 'ordinary prose describing an operation and its accompanying details '.repeat(20);
function transcript(content) {
  return [{ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content, is_error: false }] }];
}
async function apply(content, compress, config = cfg) {
  return createHeadroomFilter(config, { compress }).applyToMessages(transcript(content));
}
test('Headroom default OFF has no inference', async () => {
  let calls = 0;
  assert.equal((await apply(prose, () => { calls++; }, parseHeadroomConfig({}))).changed, false);
  assert.equal(calls, 0);
});
test('exact AB count-label failure bypasses in long blocks', async () => {
  for (const summary of ['tests 438 pass 438 fail 0 skipped 0', 'tests 438\npass 438\nfail 0\nskipped 0', 'tests 438 / pass 438 / fail 0 / skipped 0']) {
    let calls = 0;
    const out = await apply(prose + summary, async () => { calls++; return '438 438 0 0'; });
    assert.equal(calls, 0);
    assert.equal(out.messages[1].content[0].content, prose + summary);
  }
});
test('WITHHELD drop reverts exact source', async () => {
  const raw = prose + 'ok 318 alert is WITHHELD when MISER_ALERT_ROUTES is missing';
  const out = await apply(raw, async () => 'ok 318 alert MISER_ALERT_ROUTES missing');
  assert.equal(out.changed, false);
  assert.equal(out.messages[1].content[0].content, raw);
});
test('each status spelling and repeated occurrence is protected', async () => {
  for (const token of ['WITHHELD', 'not', 'FAIL', 'FAILED', 'SKIP', 'SKIPPED', 'DENIED', 'BLOCKED', 'REJECTED', 'never', 'without', 'no']) {
    const raw = prose + `${token} ${token}`;
    assert.equal((await apply(raw, async () => token)).changed, false);
    assert.equal((await apply(raw, async () => `${token} ${token}`)).changed, true);
  }
});
test('short blocks and structured content bypass', async () => {
  for (const content of ['short tool result', [{ type: 'image', source: {} }], { key: prose }]) {
    let called = false;
    assert.equal((await apply(content, () => { called = true; })).changed, false);
    assert.equal(called, false);
  }
});
test('independent calls preserve metadata, source objects and text boundaries', async () => {
  const input = transcript([{ type: 'text', text: prose }, { type: 'text', text: prose + 'x' }]);
  const snapshot = JSON.stringify(input), calls = [];
  const filter = createHeadroomFilter(cfg, { compress: async text => { calls.push(text); return 'summary'; } });
  const first = await filter.applyToMessages(input), second = await filter.applyToMessages(input);
  assert.deepEqual(first, second);
  assert.equal(calls.length, 4);
  assert.equal(JSON.stringify(input), snapshot);
  assert.equal(first.messages[1].content[0].is_error, false);
  assert.equal(first.messages[1].content[0].content.length, 2);
});
test('orphan results stay raw', async () => {
  const input = [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'unknown', content: prose }] }];
  assert.equal((await createHeadroomFilter(cfg, { compress: () => { throw Error('not paired'); } }).applyToMessages(input)).messages, input);
});
test('failures, empty, invalid and no-gain output revert', async () => {
  for (const run of [async () => { throw Error('down'); }, async () => '', async () => ({}), async () => prose + 'more']) {
    assert.equal((await apply(prose, run)).changed, false);
  }
});
test('config rejects remote endpoints and invalid limits', () => {
  for (const env of [{ MISER_HEADROOM_URL: 'http://example.com/v1/compress' }, { MISER_HEADROOM_TARGET_RATIO: 'NaN' }, { MISER_HEADROOM_TIMEOUT_MS: '0' }]) {
    assert.throws(() => parseHeadroomConfig({ MISER_HEADROOM: '1', ...env }));
  }
});
test('HTTP request is query-free; bad response and deadline fail open', async t => {
  const seen = []; let mode = 'ok';
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => {
      seen.push({ path: req.url, method: req.method, body: JSON.parse(data) });
      if (mode !== 'hang') res.end(mode === 'bad' ? 'not json' : JSON.stringify({ compressed: 'summary' }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const filter = createHeadroomFilter({ ...cfg, endpoint: `http://127.0.0.1:${server.address().port}/v1/compress`, timeoutMs: 200 });
  assert.equal((await filter.applyToMessages(transcript(prose))).changed, true);
  assert.deepEqual(seen[0], { path: '/v1/compress', method: 'POST', body: { text: prose, target_ratio: 0.5 } });
  mode = 'bad'; assert.equal((await filter.applyToMessages(transcript(prose))).changed, false);
  mode = 'hang'; assert.equal((await filter.applyToMessages(transcript(prose))).changed, false);
});
