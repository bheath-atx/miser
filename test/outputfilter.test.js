'use strict';

// RTK pre-context output filter — PROPOSAL-RTK-ONLY.md §10 test plan.
//
// Offline and hermetic: every test here drives the filter through its injected
// runner seam, so nothing spawns a subprocess, opens a socket, or touches the
// filesystem. The ONE thing that genuinely needs the real binary — the §10.4
// cross-process admission gate — lives in rtk-admission.test.js and SKIPS
// LOUDLY when no binary is present, rather than passing vacuously.
//
// Numbered references below (1)…(30) are the §10 test-plan items.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createOutputFilter: createOutputFilterWithDeps,
  parseRtkConfig,
  runAdmissionProbe,
  FILTER_SPECS,
  __test,
} = require('../src/outputfilter.js');
const { failingPrettierCheck, coloredYamlPrettierCheck } = require('./fixtures/rtk-prettier.js');

// ---------------------------------------------------------------------------
// Fixtures

const ENABLED_ENV = { MISER_RTK_FILTER: '1', MISER_TIER_B_OUTPUT_TRIM: '1' };

function cfg(over = {}) {
  return { ...parseRtkConfig(ENABLED_ENV), ...over };
}

// Version verification is mandatory too; keep existing filter fixtures offline
// by injecting the pinned binary's version response, without bypassing the gate.
function createOutputFilter(config, deps = {}) {
  return createOutputFilterWithDeps(config, {
    runVersion: async () => okResult('rtk 0.48.0\n'),
    ...deps,
  });
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

// Realistic pytest output, comfortably above the 2048-byte MIN_BYTES floor and
// matching the pytest signature gate.
function pytestOutput(n = 120, tag = 'a') {
  const lines = [
    '============================= test session starts ==============================',
    'platform linux -- Python 3.11.2, pytest-7.4.0, pluggy-1.2.0',
    'collected ' + n + ' items',
    '',
  ];
  for (let i = 0; i < n; i++) {
    lines.push(`tests/test_${tag}_${i}.py::test_case_${i} PASSED                    [ ${i % 100}%]`);
  }
  lines.push(`============================== ${n} passed in 1.23s ==============================`);
  return lines.join('\n');
}

function failingPytestOutput(n = 120) {
  const out = pytestOutput(n);
  return out + '\n=================================== FAILURES ===================================\n'
    + 'E   AssertionError: expected 1 got 2\n'
    + '=========================== 1 failed, ' + n + ' passed ===========================';
}

// A deterministic stand-in for a real RTK filter: a pure function of its input.
function summarize(raw) {
  const lines = raw.split('\n');
  const head = lines[0];
  const tail = lines[lines.length - 1];
  return `[rtk summary] ${lines.length} lines\n${head}\n${tail}`;
}

function okResult(stdout, stderr = '') {
  return { code: 0, stdout, stderr, timedOut: false, invalidUtf8: false };
}

// Records every call so tests can assert a spawn did NOT happen.
function stubRunner(calls, impl) {
  return async (filterId, input) => {
    calls.push({ filterId, input });
    return impl ? impl(filterId, input, calls.length) : okResult(summarize(input));
  };
}

function toolUse(id, command) {
  return { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] };
}

function toolResult(id, content) {
  return { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] };
}

// A transcript of `steps`, each contributing an assistant tool_use + the user
// tool_result that answers it in the immediately following turn.
function transcript(steps, { padTo = 0 } = {}) {
  const messages = [{ role: 'user', content: 'FIRST TASK' }];
  for (let i = 0; i < padTo; i++) {
    messages.push({ role: 'assistant', content: `filler ${i}` });
    messages.push({ role: 'user', content: `filler reply ${i}` });
  }
  for (let i = 0; i < steps.length; i++) {
    messages.push(toolUse(`tu${i}`, steps[i].command));
    messages.push(toolResult(`tu${i}`, steps[i].output));
  }
  return messages;
}

function blockAt(messages, idx) {
  return messages[idx].content[0];
}

function reset() {
  __test.resetProcessState();
}

// ===========================================================================
// §10.1 Determinism
// ===========================================================================

test('(1) same content at index 2 of a short and a long conversation → identical bytes', async () => {
  reset();
  const out = pytestOutput();
  const shortMsgs = transcript([{ command: 'pytest tests/', output: out }]);
  // Same block, but sitting deep inside a 40-message conversation.
  const longMsgs = transcript([{ command: 'pytest tests/', output: out }], { padTo: 18 });

  const a = await createOutputFilter(cfg(), { runFilter: stubRunner([]) }).applyToMessages(shortMsgs);
  reset();
  const b = await createOutputFilter(cfg(), { runFilter: stubRunner([]) }).applyToMessages(longMsgs);

  const aBlock = blockAt(a.messages, 2);
  const bBlock = blockAt(b.messages, 2 + 36);
  assert.equal(a.stats.blocksFiltered, 1);
  assert.equal(b.stats.blocksFiltered, 1);
  assert.equal(aBlock.content, bBlock.content);
  assert.notEqual(aBlock.content, out); // non-vacuous: it really was filtered
});

test('(2) no per-request block cap: 40 eligible blocks → all 40 filtered', async () => {
  reset();
  const steps = [];
  for (let i = 0; i < 40; i++) {
    steps.push({ command: `pytest tests/suite_${i}`, output: pytestOutput(120, `s${i}`) });
  }
  const calls = [];
  const r = await createOutputFilter(cfg(), { runFilter: stubRunner(calls) })
    .applyToMessages(transcript(steps));
  assert.equal(r.stats.blocksFiltered, 40);
  assert.equal(calls.length, 40);
});

test('(3) a nondeterministic filter is rejected by the ADMISSION GATE, not contained at runtime', async () => {
  reset();
  let n = 0;
  const flaky = async (_id, input) => okResult(`${summarize(input)}\nnonce=${n++}`);
  const probe = await runAdmissionProbe(cfg(), 'pytest', pytestOutput(), 3, flaky);
  assert.equal(probe.ok, false);
  assert.match(probe.reason, /nondeterministic/);

  // Positive control: the same gate ADMITS a pure filter, so the rejection
  // above is a real discrimination and not a gate that always says no.
  const pure = async (_id, input) => okResult(summarize(input));
  const good = await runAdmissionProbe(cfg(), 'pytest', pytestOutput(), 3, pure);
  assert.equal(good.ok, true);
});

// ===========================================================================
// §10.2 Latch and memo (§6)
// ===========================================================================

test('(4) the first fault trips the latch process-wide; later eligible blocks forward raw', async () => {
  reset();
  const out = pytestOutput();
  const calls = [];
  // Fault on the FIRST call only; a per-block fallback would filter the rest.
  const runner = stubRunner(calls, (id, input, nth) => (
    nth === 1 ? { code: 1, stdout: '', stderr: 'boom', timedOut: false } : okResult(summarize(input))
  ));
  const filter = createOutputFilter(cfg(), { runFilter: runner });
  const messages = transcript([
    { command: 'pytest a/', output: out },
    { command: 'pytest b/', output: pytestOutput(120, 'b') },
    { command: 'pytest c/', output: pytestOutput(120, 'c') },
  ]);
  const r = await filter.applyToMessages(messages);

  assert.equal(r.changed, false);
  assert.equal(r.stats.blocksFiltered, 0);
  assert.equal(r.stats.blocksRawPinned, 3);
  assert.equal(filter.latch().tripped, true);
  assert.equal(filter.latch().reason, 'nonzero-exit');
  // (5) no per-block flapping: blocks 2 and 3 were never retried.
  assert.equal(calls.length, 1);
});

test('(5) the latch is one-way across separate requests, not re-armed per request', async () => {
  reset();
  const calls = [];
  const runner = stubRunner(calls, (id, input, nth) => (
    nth === 1 ? { code: null, stdout: '', stderr: '', timedOut: true } : okResult(summarize(input))
  ));
  const filter = createOutputFilter(cfg(), { runFilter: runner });
  const msgs = transcript([{ command: 'pytest x/', output: pytestOutput() }]);

  const first = await filter.applyToMessages(msgs);
  const second = await filter.applyToMessages(msgs);
  assert.equal(first.changed, false);
  assert.equal(second.changed, false);
  assert.equal(calls.length, 1, 'a second request must not re-spawn after the latch');
  assert.equal(filter.latch().reason, 'timeout');
  assert.equal(filter.latch().trips, 1, 'the latch trips at most once per process');
});

test('(6) memo ON and memo OFF are byte-identical in FAILURE-FREE execution', async () => {
  reset();
  const msgs = transcript([
    { command: 'pytest a/', output: pytestOutput(120, 'a') },
    { command: 'pytest a/', output: pytestOutput(120, 'a') },
  ]);
  const withMemo = await createOutputFilter(cfg({ memoEntries: 2048 }), { runFilter: stubRunner([]) })
    .applyToMessages(msgs);
  reset();
  const noMemo = await createOutputFilter(cfg({ memoEntries: 0 }), { runFilter: stubRunner([]) })
    .applyToMessages(msgs);

  assert.equal(JSON.stringify(withMemo.messages), JSON.stringify(noMemo.messages));
  assert.equal(withMemo.stats.blocksFiltered, 2);
  assert.equal(noMemo.stats.blocksFiltered, 2);
  assert.ok(withMemo.stats.memoHits > 0, 'memo-on must actually hit, or this proves nothing');
  assert.equal(noMemo.stats.memoHits, 0);
});

test('(7) memo ON and memo OFF DIFFER under an injected fault — the scoped claim, pinned', async () => {
  reset();
  const out = pytestOutput();
  const msgs = transcript([{ command: 'pytest a/', output: out }]);
  // Succeeds on call 1, faults on call 2. Memo-on never makes call 2.
  const faultOnSecond = (calls) => stubRunner(calls, (id, input, nth) => (
    nth === 1 ? okResult(summarize(input)) : { code: 1, stdout: '', stderr: 'late fault', timedOut: false }
  ));

  const memoCalls = [];
  const memoOn = createOutputFilter(cfg({ memoEntries: 2048 }), { runFilter: faultOnSecond(memoCalls) });
  await memoOn.applyToMessages(msgs);
  const memoOnSecond = await memoOn.applyToMessages(msgs);

  reset();
  const coldCalls = [];
  const memoOff = createOutputFilter(cfg({ memoEntries: 0 }), { runFilter: faultOnSecond(coldCalls) });
  await memoOff.applyToMessages(msgs);
  const memoOffSecond = await memoOff.applyToMessages(msgs);

  // Memo on: a warm hit returns the compressed bytes and never spawns again.
  assert.equal(memoOnSecond.changed, true);
  assert.equal(memoCalls.length, 1);
  // Memo off: the cold path re-spawns, faults, forwards raw and trips the latch.
  assert.equal(memoOffSecond.changed, false);
  assert.equal(coldCalls.length, 2);
  assert.equal(memoOff.latch().tripped, true);
  // They are NOT byte-equivalent. The latch bounds this divergence; it does not
  // erase it, and §6.3's equivalence claim is scoped to failure-free runs only.
  assert.notEqual(JSON.stringify(memoOnSecond.messages), JSON.stringify(memoOffSecond.messages));
});

test('(7b) a fault-derived raw decision is NEVER memoized', async () => {
  reset();
  const calls = [];
  // Always faults. If the raw decision were cached, call 2 would be skipped and
  // the latch reason would be indistinguishable from a memo hit.
  const filter = createOutputFilter(cfg(), {
    runFilter: stubRunner(calls, () => ({ code: 2, stdout: '', stderr: 'x', timedOut: false })),
  });
  const msgs = transcript([{ command: 'pytest a/', output: pytestOutput() }]);
  const r = await filter.applyToMessages(msgs);
  assert.equal(r.stats.memoHits, 0);
  assert.equal(filter.memoSize(), 0, 'a fault must leave the memo empty');
});

test('(8) concurrent identical requests produce identical bytes (no single-flight needed)', async () => {
  reset();
  const msgs = transcript([{ command: 'pytest a/', output: pytestOutput() }]);
  const filter = createOutputFilter(cfg(), { runFilter: stubRunner([]) });
  const [a, b, c] = await Promise.all([
    filter.applyToMessages(msgs),
    filter.applyToMessages(msgs),
    filter.applyToMessages(msgs),
  ]);
  assert.equal(JSON.stringify(a.messages), JSON.stringify(b.messages));
  assert.equal(JSON.stringify(b.messages), JSON.stringify(c.messages));
  assert.equal(a.stats.blocksFiltered, 1);
});

for (const memoEntries of [0, 2048]) {
  test(`R8 latch: an in-flight success stays raw after another instance faults (memo=${memoEntries})`, async () => {
    reset();
    const entered = deferred();
    const pendingRun = deferred();
    const calls = [];
    const alerts = [];
    const messages = transcript([{ command: 'pytest a/', output: pytestOutput() }]);
    const filter = createOutputFilter(cfg({ memoEntries }), {
      runFilter: stubRunner(calls, () => { entered.resolve(); return pendingRun.promise; }),
      onAlert: alert => alerts.push(alert),
    });
    const other = createOutputFilter(cfg(), {
      runFilter: async () => ({ code: null, timedOut: true, stdout: '', stderr: '' }),
      onAlert: alert => alerts.push(alert),
    });

    const inFlight = filter.applyToMessages(messages);
    await entered.promise;
    const faulted = await other.applyToMessages(messages);
    pendingRun.resolve(okResult(summarize(pytestOutput())));
    const late = await inFlight;
    const later = await filter.applyToMessages(messages);

    for (const result of [faulted, late, later]) {
      assert.equal(result.messages, messages, 'every completion after the fault must forward the original array');
      assert.equal(result.changed, false);
      assert.equal(result.stats.blocksFiltered, 0);
      assert.equal(result.stats.blocksRawPinned, 1);
      assert.equal(result.stats.bytesRemoved, 0);
      assert.equal(result.stats.estRemovedTokens, 0);
    }
    assert.equal(calls.length, 1, 'the disabled instance must never retry');
    assert.equal(filter.memoSize(), 0, 'the late success must not populate the memo');
    assert.equal(filter.latch().trips, 1);
    assert.equal(alerts.length, 1);
  });
}

test('R8 latch: discard earlier memo hits as well as a late success before returning a transcript', async () => {
  reset();
  const entered = deferred();
  const pendingRun = deferred();
  const calls = [];
  const warmMessages = transcript([{ command: 'pytest a/', output: pytestOutput() }]);
  const messages = transcript([
    { command: 'pytest a/', output: pytestOutput() },
    { command: 'pytest b/', output: pytestOutput(120, 'b') },
  ]);
  const filter = createOutputFilter(cfg(), {
    runFilter: stubRunner(calls, (_id, input, nth) => {
      if (nth === 1) return okResult(summarize(input));
      entered.resolve();
      return pendingRun.promise;
    }),
  });
  const warm = await filter.applyToMessages(warmMessages);
  assert.equal(warm.stats.blocksFiltered, 1, 'the memo must hold an actual rewrite');
  const inFlight = filter.applyToMessages(messages);
  await entered.promise;
  const other = createOutputFilter(cfg(), {
    runFilter: async () => ({ code: 1, timedOut: false, stdout: '', stderr: 'fault' }),
  });
  await other.applyToMessages(warmMessages);
  pendingRun.resolve(okResult(summarize(pytestOutput(120, 'b'))));
  const result = await inFlight;

  assert.equal(result.messages, messages, 'earlier rewrites must also be rolled back after the latch trips');
  assert.equal(result.changed, false);
  assert.equal(result.stats.memoHits, 1, 'exercise an actual warm hit before waiting');
  assert.equal(result.stats.blocksRawPinned, 2);
  assert.equal(result.stats.blocksFiltered, 0);
  assert.equal(result.stats.bytesRemoved, 0);
  assert.equal(result.stats.estRemovedTokens, 0);
  assert.equal(filter.memoSize(), 1, 'the late success must not enter the memo');
  assert.equal((await filter.applyToMessages(warmMessages)).changed, false, 'the warm memo cannot bypass the latch');
});

test('R8 latch: a later fault in one message rolls back its earlier successful block', async () => {
  reset();
  const raw = pytestOutput();
  const messages = [
    { role: 'assistant', content: [toolUse('a', 'pytest a/').content[0], toolUse('b', 'pytest b/').content[0]] },
    { role: 'user', content: [toolResult('a', raw).content[0], toolResult('b', raw).content[0]] },
  ];
  const filter = createOutputFilter(cfg(), {
    runFilter: stubRunner([], (_id, input, nth) => nth === 1
      ? okResult(summarize(input))
      : { code: 1, timedOut: false, stdout: '', stderr: 'fault' }),
  });
  const result = await filter.applyToMessages(messages);
  assert.equal(result.messages, messages);
  assert.equal(result.changed, false);
  assert.equal(result.stats.blocksRawPinned, 2);
  assert.equal(result.stats.blocksFiltered, 0);
  assert.equal(result.stats.bytesRemoved, 0);
  assert.equal(result.stats.estRemovedTokens, 0);
});

// ===========================================================================
// §10.3 Eligibility identity
// ===========================================================================

test('(9) identical content under an eligible vs an excluded tool → filtered vs raw, no cross-talk', async () => {
  reset();
  const out = pytestOutput();
  const calls = [];
  const r = await createOutputFilter(cfg(), { runFilter: stubRunner(calls) }).applyToMessages(
    transcript([
      { command: 'pytest tests/', output: out },   // allowlisted
      { command: 'cargo test', output: out },      // §4 excluded (non-total sort)
    ]),
  );
  assert.equal(r.stats.blocksFiltered, 1);
  assert.notEqual(blockAt(r.messages, 2).content, out);
  assert.equal(blockAt(r.messages, 4).content, out, 'excluded tool must forward raw');
  assert.equal(calls.length, 1);
});

test('(10) an UNPAIRED tool_result is never filtered', async () => {
  reset();
  const out = pytestOutput();
  const calls = [];
  // tool_result whose tool_use_id matches nothing in the preceding assistant turn.
  const messages = [
    { role: 'user', content: 'FIRST TASK' },
    toolUse('tu0', 'pytest tests/'),
    toolResult('ORPHAN', out),
  ];
  const r = await createOutputFilter(cfg(), { runFilter: stubRunner(calls) }).applyToMessages(messages);
  assert.equal(r.changed, false);
  assert.equal(calls.length, 0);
  assert.equal(blockAt(r.messages, 2).content, out);
});

test('(10b) a tool_result whose pair is NOT adjacent is never filtered', async () => {
  reset();
  const out = pytestOutput();
  const calls = [];
  const messages = [
    { role: 'user', content: 'FIRST TASK' },
    toolUse('tu0', 'pytest tests/'),
    { role: 'assistant', content: 'an intervening assistant turn breaks adjacency' },
    toolResult('tu0', out),
  ];
  const r = await createOutputFilter(cfg(), { runFilter: stubRunner(calls) }).applyToMessages(messages);
  assert.equal(r.changed, false);
  assert.equal(calls.length, 0);
});

test('(11) same content, different pairedInput → distinct memo keys (no false-identical)', async () => {
  reset();
  const out = pytestOutput();
  const calls = [];
  const r = await createOutputFilter(cfg(), { runFilter: stubRunner(calls) }).applyToMessages(
    transcript([
      { command: 'pytest tests/alpha', output: out },
      { command: 'pytest tests/beta', output: out },
    ]),
  );
  assert.equal(r.stats.blocksFiltered, 2);
  assert.equal(r.stats.memoHits, 0, 'different paired input must not collide in the memo');
  assert.equal(calls.length, 2);
});

test('(11b) identical paired input AND identical content → one spawn, one memo hit', async () => {
  reset();
  const out = pytestOutput();
  const calls = [];
  const r = await createOutputFilter(cfg(), { runFilter: stubRunner(calls) }).applyToMessages(
    transcript([
      { command: 'pytest tests/alpha', output: out },
      { command: 'pytest tests/alpha', output: out },
    ]),
  );
  assert.equal(r.stats.blocksFiltered, 2);
  assert.equal(r.stats.memoHits, 1);
  assert.equal(calls.length, 1);
});

// ===========================================================================
// §10.4(15) Growth fixture — prefix stability under an appended message.
//
// Same-input determinism alone does NOT prove prefix stability, which is what
// prompt caching actually requires. Per CODEX-IQA-RTK-ONLY.md:39-42 this must
// exercise an ACTUALLY FILTERED eligible block, so raw passthrough cannot
// satisfy it vacuously — hence the explicit non-vacuity assertions.
// ===========================================================================

test('(15) growth fixture: appending a message leaves the forwarded prefix byte-identical', async () => {
  reset();
  const base = transcript([
    { command: 'pytest tests/alpha', output: pytestOutput(120, 'alpha') },
    { command: 'rg -n needle src/', output: rgOutput() },
  ]);

  const filter = createOutputFilter(cfg(), { runFilter: stubRunner([]) });
  const before = await filter.applyToMessages(base);

  // NON-VACUITY: the prefix we are about to compare must contain real filtered
  // output, not untouched raw. If this ever regresses to a passthrough, the
  // prefix comparison below would still pass — and would be meaningless.
  assert.equal(before.changed, true);
  assert.equal(before.stats.blocksFiltered, 2);
  assert.notEqual(blockAt(before.messages, 2).content, base[2].content[0].content);
  assert.notEqual(blockAt(before.messages, 4).content, base[4].content[0].content);

  // The client appends the next turn and resends the whole history, exactly as
  // Claude Code does. Miser is stateless, so the filter recomputes from scratch.
  const grown = base.concat([
    toolUse('tuN', 'pytest tests/omega'),
    toolResult('tuN', pytestOutput(120, 'omega')),
  ]);
  const after = await filter.applyToMessages(grown);

  assert.equal(
    JSON.stringify(after.messages.slice(0, base.length)),
    JSON.stringify(before.messages),
    'the forwarded prefix changed when a message was appended — prompt caching would break',
  );
  assert.equal(after.stats.blocksFiltered, 3);
});

function rgOutput(n = 90) {
  const lines = [];
  for (let i = 0; i < n; i++) {
    lines.push(`src/module_${i % 12}.js:${100 + i}:  const needle = compute(${i}); // occurrence ${i}`);
  }
  return lines.join('\n');
}

// ===========================================================================
// §10.5 Fidelity guard (§5)
// ===========================================================================

test('(16) raw output failing the filter SIGNATURE is forwarded raw, with no spawn', async () => {
  reset();
  // Real-world shape §5 calls out: a failing build emits ordinary non-JSON text.
  // It is routed to a pytest-headed command but carries no pytest signature.
  const notPytest = 'panic: runtime error: index out of range\n'.repeat(200);
  const calls = [];
  const r = await createOutputFilter(cfg(), { runFilter: stubRunner(calls) })
    .applyToMessages(transcript([{ command: 'pytest tests/', output: notPytest }]));
  assert.equal(r.changed, false);
  assert.equal(calls.length, 0, 'the signature gate must reject BEFORE spawning');
});

test('(16b) go test is not allowlisted at all — the §5 fidelity hazard never runs', async () => {
  reset();
  const calls = [];
  const r = await createOutputFilter(cfg(), { runFilter: stubRunner(calls) })
    .applyToMessages(transcript([{ command: 'go test ./...', output: pytestOutput() }]));
  assert.equal(r.changed, false);
  assert.equal(calls.length, 0);
  assert.equal(FILTER_SPECS['go-test'], undefined);
});

test('(17) filtered output that DROPS a failure marker present in raw is discarded', async () => {
  reset();
  const raw = failingPytestOutput();
  const calls = [];
  // A "successful" filter that summarizes away the FAILURES section — exactly
  // the never_worse hazard: smaller, and wrong about whether the run passed.
  const r = await createOutputFilter(cfg(), {
    runFilter: stubRunner(calls, () => okResult('[rtk summary] 121 tests, all green\n' + 'x'.repeat(50))),
  }).applyToMessages(transcript([{ command: 'pytest tests/', output: raw }]));

  assert.equal(calls.length, 1, 'the filter DID run — this is a post-hoc rejection');
  assert.equal(r.changed, false);
  assert.equal(blockAt(r.messages, 2).content, raw);
  assert.equal(r.stats.blocksRawPinned, 1);
});

test('(17b) filtered output that PRESERVES the failure marker is accepted', async () => {
  reset();
  const raw = failingPytestOutput();
  const r = await createOutputFilter(cfg(), {
    runFilter: stubRunner([], () => okResult('[rtk summary] FAILURES: 1 failed\nE   AssertionError')),
  }).applyToMessages(transcript([{ command: 'pytest tests/', output: raw }]));
  assert.equal(r.changed, true);
  assert.equal(r.stats.blocksFiltered, 1);
});

test('R8 Prettier: the admission fixture cannot become a false all-files-formatted summary', async () => {
  reset();
  const raw = failingPrettierCheck();
  const messages = transcript([{ command: 'prettier --check src/', output: raw }]);
  const calls = [];
  // Exact success string produced at RTK 79347d5 when it excludes [warn] paths.
  const filter = createOutputFilter(cfg(), {
    runFilter: stubRunner(calls, () => okResult('Prettier: All files formatted correctly')),
  });
  const first = await filter.applyToMessages(messages);
  const repeated = await filter.applyToMessages(messages);
  for (const result of [first, repeated]) {
    assert.equal(result.messages, messages);
    assert.equal(result.changed, false);
    assert.equal(result.stats.blocksRawPinned, 1);
    assert.equal(result.stats.bytesRemoved, 0);
  }
  assert.equal(calls.length, 1, 'the signature must admit the sample; the fidelity rejection is memoized');
  assert.equal(repeated.stats.memoHits, 1);
  assert.equal(filter.latch().tripped, false, 'a fidelity rejection is deterministic, not a subprocess fault');
});

test('R10 Prettier: the exact colored-YAML witness stays raw on cold and memo-hit replay', async () => {
  reset();
  const raw = coloredYamlPrettierCheck();
  assert.equal(Buffer.byteLength(raw), 3912, 'retain the complete R9 witness');
  const messages = transcript([{ command: 'prettier --check --color config/', output: raw }]);
  const calls = [];
  const filter = createOutputFilter(cfg(), {
    runFilter: stubRunner(calls, () => okResult('Prettier: All files formatted correctly')),
  });
  const cold = await filter.applyToMessages(messages);
  const warm = await filter.applyToMessages(messages);
  assert.equal(calls.length, 1, 'exercise acceptance and then memo replay at default thresholds');
  assert.equal(cold.stats.memoHits, 0);
  assert.equal(warm.stats.memoHits, 1);
  for (const result of [cold, warm]) {
    assert.equal(result.changed, false, 'colored warnings cannot become success');
    assert.equal(result.messages, messages);
    assert.equal(blockAt(result.messages, 2).content, raw, 'preserve the original ANSI bytes');
    assert.equal(result.stats.blocksRawPinned, 1);
    assert.equal(result.stats.blocksFiltered, 0);
    assert.equal(result.stats.bytesRemoved, 0);
  }
  assert.equal(filter.latch().tripped, false);
});

test('R10 Prettier: ANSI-wrapped warnings, errors and faithful summaries retain failure signals', async () => {
  for (const marker of [
    '[\x1b[33mwarn\x1b[39m] config/file.yaml',
    '[\x1b[31merror\x1b[39m] config/file.yaml: invalid yaml',
    '\x1b[1;33m[warn]\x1b[0m config/file.yaml',
    '\x1b[2K\t[\x1b[38;2;200;100;0mwarn\x1b[0m] config/file.yaml',
    '[\x9b33mwarn\x9b39m] config/file.yaml',
    'Code style \x1b[33missues found\x1b[39m in 1 file.',
  ]) {
    reset();
    const raw = 'Checking formatting...\n' + `${marker}\n`.repeat(100);
    const summary = '\x1b[33mPrettier:\x1b[39m 100 files need formatting';
    const messages = transcript([{ command: 'prettier --check --color config/', output: raw }]);
    const calls = [];
    const filter = createOutputFilter(cfg(), {
      runFilter: stubRunner(calls, () => okResult(summary)),
    });
    assert.equal(__test.hasFailureMarker(raw, 'prettier'), true, JSON.stringify(marker));
    for (let replay = 0; replay < 2; replay++) {
      const result = await filter.applyToMessages(messages);
      assert.equal(result.changed, true, 'a faithful colored failure summary is still useful');
      assert.equal(blockAt(result.messages, 2).content, summary, 'normalization is detection-only');
      assert.equal(result.stats.memoHits, replay);
    }
    assert.equal(calls.length, 1);
  }
});

test('R10 Prettier: failure detection respects line boundaries and leading whitespace', () => {
  for (const newline of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
    for (const marker of ['[warn] file.yaml', '[error] file.yaml', 'Code style issues found in 1 file.', 'Prettier: 1 file need formatting']) {
      assert.equal(__test.hasFailureMarker(`Checking formatting...${newline}${newline}\t \u00a0${marker}`, 'prettier'), true);
      assert.equal(__test.hasFailureMarker(`Checking formatting...${newline}ordinary text ${marker}`, 'prettier'), false);
    }
  }
  assert.equal(__test.hasFailureMarker('Checking formatting...\nPrettier: All files formatted correctly', 'prettier'), false);
  assert.equal(__test.hasFailureMarker('Checking formatting...\nPrettier: 0 files need formatting', 'prettier'), false);
});

test('R8 Prettier: warning paths, unprefixed style issues and errors each retain failure signals', async () => {
  for (const raw of [
    '[warn] src/file.ts\n'.repeat(200),
    'Code style issues found in the above file(s). Run Prettier to fix.\n'.repeat(50),
    '[error] src/file.ts: Syntax error\n'.repeat(100),
  ]) {
    reset();
    const messages = transcript([{ command: 'prettier --check src/', output: raw }]);
    const calls = [];
    const result = await createOutputFilter(cfg(), {
      runFilter: stubRunner(calls, () => okResult('Prettier: All files formatted correctly')),
    }).applyToMessages(messages);
    assert.equal(calls.length, 1);
    assert.equal(result.messages, messages, raw.split('\n')[0]);
    assert.equal(result.stats.blocksRawPinned, 1);
  }
});

test('R8 Prettier: faithful failure and genuine success summaries can still be accepted', async () => {
  for (const [raw, summary] of [
    [failingPrettierCheck(), 'Prettier: 200 files need formatting\n1. src/file_000.ts'],
    ['Checking formatting...\nAll matched files use Prettier code style!\n', 'Prettier: All files formatted correctly'],
  ]) {
    reset();
    const result = await createOutputFilter(cfg({ minBytes: 0, minGainBytes: 1 }), {
      runFilter: stubRunner([], () => okResult(summary)),
    }).applyToMessages(transcript([{ command: 'prettier --check src/', output: raw }]));
    assert.equal(result.stats.blocksFiltered, 1);
    assert.equal(blockAt(result.messages, 2).content, summary);
  }
});

// ===========================================================================
// F2 (CODEX-IQA-RTK-ONLY.md MINOR) — RTK's caught-panic path
// ===========================================================================

test('F2: a caught filter panic (exit 0 + stderr warning + raw stdout) is treated as a FAULT', async () => {
  reset();
  const raw = pytestOutput();
  // pipe_cmd.rs:244-249,281-284 — catch_unwind warns on stderr and returns the
  // RAW input with SUCCESS; main.rs:2818-2819 returns exit code 0. Exit status
  // alone therefore cannot see this, which is precisely what F2 corrects.
  const calls = [];
  const filter = createOutputFilter(cfg(), {
    runFilter: stubRunner(calls, (id, input) => okResult(
      input,
      '[rtk] warning: filter panicked — passing through raw output\n',
    )),
  });
  const r = await filter.applyToMessages(transcript([
    { command: 'pytest a/', output: raw },
    { command: 'pytest b/', output: pytestOutput(120, 'b') },
  ]));

  assert.equal(r.changed, false);
  assert.equal(blockAt(r.messages, 2).content, raw);
  assert.equal(filter.latch().tripped, true);
  assert.equal(filter.latch().reason, 'rtk-panic');
  // Latched, so the second eligible block is not retried.
  assert.equal(calls.length, 1);
});

test('F2b: the admission gate also rejects a filter that panics', async () => {
  reset();
  const panicking = async (_id, input) => okResult(input, '[rtk] warning: filter panicked — passing through raw output');
  const probe = await runAdmissionProbe(cfg(), 'pytest', pytestOutput(), 3, panicking);
  assert.equal(probe.ok, false);
  assert.equal(probe.reason, 'rtk-panic');
});

// ===========================================================================
// §10.7 Accept, fail-open, bounds
// ===========================================================================

test('(22) a gain below MISER_RTK_MIN_GAIN_BYTES forwards raw', async () => {
  reset();
  const raw = pytestOutput();
  // Shave only a handful of bytes — well under the 256-byte accept margin.
  const r = await createOutputFilter(cfg(), {
    runFilter: stubRunner([], (id, input) => okResult(input.slice(0, input.length - 10))),
  }).applyToMessages(transcript([{ command: 'pytest tests/', output: raw }]));
  assert.equal(r.changed, false);
  assert.equal(blockAt(r.messages, 2).content, raw);
  assert.equal(r.stats.blocksRawPinned, 1);
});

test('(23) every fault kind forwards the block UNMODIFIED', async () => {
  const faults = {
    'missing binary': { spawnError: 'ENOENT', code: null, stdout: '', stderr: '', timedOut: false },
    'non-zero exit': { code: 3, stdout: 'partial', stderr: 'err', timedOut: false },
    timeout: { code: null, stdout: '', stderr: '', timedOut: true },
    'non-utf8': { code: 0, stdout: '��', stderr: '', timedOut: false, invalidUtf8: true },
    'runner throw': null, // handled below
  };
  for (const [name, result] of Object.entries(faults)) {
    reset();
    const raw = pytestOutput();
    const runner = result
      ? stubRunner([], () => result)
      : async () => { throw new Error('adapter exploded'); };
    const filter = createOutputFilter(cfg(), { runFilter: runner });
    const r = await filter.applyToMessages(transcript([{ command: 'pytest tests/', output: raw }]));
    assert.equal(r.changed, false, `${name} must forward unmodified`);
    assert.equal(blockAt(r.messages, 2).content, raw, `${name} must preserve raw bytes`);
    assert.equal(filter.latch().tripped, true, `${name} must trip the latch`);
  }
});

test('(24) content above MAX_BYTES forwards raw with no spawn; below MIN_BYTES likewise', async () => {
  reset();
  const calls = [];
  const huge = pytestOutput(40000);
  assert.ok(Buffer.byteLength(huge) > 1048576, 'fixture must actually exceed MAX_BYTES');
  const tiny = '==== test session starts ====\ncollected 1 item\n1 passed';
  const r = await createOutputFilter(cfg(), { runFilter: stubRunner(calls) }).applyToMessages(
    transcript([
      { command: 'pytest big/', output: huge },
      { command: 'pytest small/', output: tiny },
    ]),
  );
  assert.equal(r.changed, false);
  assert.equal(calls.length, 0);
});

test('(30) with the feature OFF there is no filter, no spawn and no memo', () => {
  assert.equal(parseRtkConfig({}).enabled, false);
  // The umbrella is a real kill switch: either flag alone leaves it OFF (§9/§11).
  assert.equal(parseRtkConfig({ MISER_RTK_FILTER: '1' }).enabled, false);
  assert.equal(parseRtkConfig({ MISER_TIER_B_OUTPUT_TRIM: '1' }).enabled, false);
  assert.equal(parseRtkConfig(ENABLED_ENV).enabled, true);
});

// ===========================================================================
// Config + identity units
// ===========================================================================

test('config: the Phase 1 allowlist is exactly §4, and the §4 exclusions are absent', () => {
  const filters = parseRtkConfig(ENABLED_ENV).filters;
  assert.deepEqual(
    [...filters].sort(),
    ['ecs', 'grep', 'paratest', 'pest', 'php-test', 'phpunit', 'prettier', 'pytest', 'rg'],
  );
  for (const excluded of ['log', 'ruff-check', 'ruff-format', 'tsc', 'mypy', 'cargo-test',
    'go-test', 'pint', 'sqlfluff-lint', 'phpstan', 'vitest', 'find']) {
    assert.equal(filters.includes(excluded), false, `${excluded} must not be admitted`);
  }
});

test('config: an unknown filter id in MISER_RTK_FILTERS is dropped, not trusted', () => {
  const filters = parseRtkConfig({ ...ENABLED_ENV, MISER_RTK_FILTERS: 'pytest,not-a-filter,rg' }).filters;
  assert.deepEqual(filters, ['pytest', 'rg']);
});

test('command heads with shell metacharacters are ineligible (the output is not that tool\'s)', async () => {
  reset();
  const calls = [];
  const out = pytestOutput();
  const r = await createOutputFilter(cfg(), { runFilter: stubRunner(calls) }).applyToMessages(
    transcript([
      { command: 'pytest tests/ | tail -5', output: out },
      { command: 'pytest tests/ > out.txt', output: out },
      { command: 'FOO=1 pytest tests/', output: out },
      { command: 'pytest tests/ && echo done', output: out },
    ]),
  );
  assert.equal(r.changed, false);
  assert.equal(calls.length, 0);
});

test('an absolute path command head still resolves to its filter', async () => {
  reset();
  const r = await createOutputFilter(cfg(), { runFilter: stubRunner([]) })
    .applyToMessages(transcript([{ command: '/usr/local/bin/pytest tests/', output: pytestOutput() }]));
  assert.equal(r.stats.blocksFiltered, 1);
});

test('memo key excludes tool_use_id but includes every other semantic field', () => {
  const { memoKeyFor } = __test;
  const base = { type: 'tool_result', tool_use_id: 'a', content: 'x' };
  const other = { type: 'tool_result', tool_use_id: 'DIFFERENT', content: 'x' };
  assert.equal(
    memoKeyFor('Bash', { command: 'pytest' }, base, 'pytest', ''),
    memoKeyFor('Bash', { command: 'pytest' }, other, 'pytest', ''),
  );
  const errored = { ...base, is_error: true };
  assert.notEqual(
    memoKeyFor('Bash', { command: 'pytest' }, base, 'pytest', ''),
    memoKeyFor('Bash', { command: 'pytest' }, errored, 'pytest', ''),
  );
  // rtkVersion participates: a version change is a one-time prefix rewrite, and
  // must NOT silently reuse the previous binary's cached output.
  assert.notEqual(
    memoKeyFor('Bash', { command: 'pytest' }, base, 'pytest', '1.0.0'),
    memoKeyFor('Bash', { command: 'pytest' }, base, 'pytest', '1.0.1'),
  );
});

test('field ORDER in the paired input does not change the memo key', () => {
  const { memoKeyFor } = __test;
  const block = { type: 'tool_result', tool_use_id: 'a', content: 'x' };
  assert.equal(
    memoKeyFor('Bash', { command: 'pytest', timeout: 5 }, block, 'pytest', ''),
    memoKeyFor('Bash', { timeout: 5, command: 'pytest' }, block, 'pytest', ''),
  );
});

test('a version mismatch refuses to enable and never produces filtered bytes', async () => {
  reset();
  const calls = [];
  const filter = createOutputFilter(cfg({ version: '0.9.9' }), {
    runFilter: stubRunner(calls),
    runVersion: async () => okResult('rtk 0.1.0\n'),
  });
  const r = await filter.applyToMessages(transcript([{ command: 'pytest tests/', output: pytestOutput() }]));
  assert.equal(r.changed, false);
  assert.equal(calls.length, 0, 'no filter may run against an unverified binary');
  assert.equal(filter.latch().reason, 'version-mismatch');
});

test('a matching version enables filtering and probes the binary only once', async () => {
  reset();
  let versionCalls = 0;
  const filter = createOutputFilter(cfg({ version: '0.1.0' }), {
    runFilter: stubRunner([]),
    runVersion: async () => { versionCalls++; return okResult('rtk 0.1.0\n'); },
  });
  const msgs = transcript([
    { command: 'pytest a/', output: pytestOutput(120, 'a') },
    { command: 'pytest b/', output: pytestOutput(120, 'b') },
  ]);
  const r = await filter.applyToMessages(msgs);
  assert.equal(r.stats.blocksFiltered, 2);
  assert.equal(versionCalls, 1);
});

test('R8 version: the default and empty environment settings pin RTK 79347d5 to 0.48.0', () => {
  assert.equal(parseRtkConfig(ENABLED_ENV).version, '0.48.0');
  for (const version of ['', '   ']) {
    assert.equal(parseRtkConfig({ ...ENABLED_ENV, MISER_RTK_VERSION: version }).version, '0.48.0');
  }
  assert.equal(parseRtkConfig({ ...ENABLED_ENV, MISER_RTK_VERSION: '0.48.1' }).version, '0.48.1');
});

test('R8 version: an unset or empty version cannot bypass a mismatched binary', async () => {
  for (const config of [cfg(), cfg({ version: '' }), cfg({ version: undefined })]) {
    reset();
    let probes = 0;
    const calls = [];
    const filter = createOutputFilter(config, {
      runFilter: stubRunner(calls),
      runVersion: async () => { probes++; return okResult('rtk 0.48.1\n'); },
    });
    const messages = transcript([{ command: 'pytest a/', output: pytestOutput() }]);
    const result = await filter.applyToMessages(messages);
    assert.equal(result.messages, messages);
    assert.equal(probes, 1);
    assert.equal(calls.length, 0);
    assert.equal(filter.latch().reason, 'version-mismatch');
  }
});

for (const matches of [false, true]) {
  test(`R8 version: concurrent requests await one ${matches ? 'matching' : 'mismatched'} probe`, async () => {
    reset();
    const probe = deferred();
    let probes = 0;
    let settled = 0;
    const calls = [];
    const filter = createOutputFilter(cfg({ version: '0.48.0', memoEntries: 0 }), {
      runVersion: () => { probes++; return probe.promise; },
      runFilter: stubRunner(calls),
    });
    const messages = transcript([{ command: 'pytest a/', output: pytestOutput() }]);
    const requests = [0, 1].map(() => filter.applyToMessages(messages).then(result => { settled++; return result; }));
    // Flush runnable work while the probe remains explicitly unresolved. No
    // wall-clock delay or timing assumption decides which request wins the race.
    await new Promise(setImmediate);
    const before = { probes, filterCalls: calls.length, settled };
    probe.resolve(okResult(`rtk ${matches ? '0.48.0' : '0.48.1'}\n`));
    const results = await Promise.all(requests);
    assert.deepEqual(before, { probes: 1, filterCalls: 0, settled: 0 });
    for (const result of results) {
      assert.equal(result.changed, matches);
      assert.equal(result.stats.blocksFiltered, matches ? 1 : 0);
      if (!matches) assert.equal(result.messages, messages);
    }
    assert.deepEqual(results[0].messages, results[1].messages);
    assert.equal(calls.length, matches ? 2 : 0);
    const next = await filter.applyToMessages(messages);
    assert.equal(next.changed, matches);
    assert.equal(calls.length, matches ? 3 : 0);
    assert.equal(probes, 1, 'completion must not cause another version probe');
  });
}

test('R8 version: substring matches, suffixes and extra stdout do not satisfy the exact pin', async () => {
  for (const stdout of [
    'rtk 0.48.00\n', 'rtk 10.48.0\n', 'rtk 0.48.0-rc.1\n', 'rtk 0.48.0+different\n',
    'unrelated 0.48.0\n', 'rtk 0.48.0\nextra output\n',
  ]) {
    reset();
    const calls = [];
    const filter = createOutputFilter(cfg({ version: '0.48.0' }), {
      runVersion: async () => okResult(stdout),
      runFilter: stubRunner(calls),
    });
    const result = await filter.applyToMessages(transcript([{ command: 'pytest a/', output: pytestOutput() }]));
    assert.equal(result.changed, false, stdout);
    assert.equal(calls.length, 0, stdout);
    assert.equal(filter.latch().reason, 'version-mismatch', stdout);
  }
});

test('R8 version: probe faults fail open and permanently disable filtering', async () => {
  const probes = [
    async () => { throw new Error('version probe rejected'); },
    async () => ({ spawnError: 'ENOENT', code: null }),
    async () => ({ ...okResult('rtk 0.48.0\n'), timedOut: true }),
    async () => ({ ...okResult('rtk 0.48.0\n'), code: 1 }),
    async () => ({ ...okResult('rtk 0.48.0\n'), invalidUtf8: true }),
    async () => null,
  ];
  for (const runProbe of probes) {
    reset();
    let probeCalls = 0;
    const calls = [];
    const filter = createOutputFilter(cfg({ version: '0.48.0' }), {
      runVersion: () => { probeCalls++; return runProbe(); },
      runFilter: stubRunner(calls),
    });
    const messages = transcript([{ command: 'pytest a/', output: pytestOutput() }]);
    const results = await Promise.all([filter.applyToMessages(messages), filter.applyToMessages(messages)]);
    results.push(await filter.applyToMessages(messages));
    for (const result of results) assert.equal(result.messages, messages);
    assert.equal(calls.length, 0);
    assert.equal(probeCalls, 1);
    assert.equal(filter.latch().reason, 'version-probe-failed');
  }
});

test('multi-block and image tool_result content is never rewritten (shape preservation)', async () => {
  reset();
  const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
  const calls = [];
  const messages = [
    { role: 'user', content: 'FIRST TASK' },
    toolUse('tu0', 'pytest tests/'),
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu0', content: [img] }] },
    toolUse('tu1', 'pytest tests/'),
    {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'tu1',
        content: [{ type: 'text', text: pytestOutput() }, { type: 'text', text: 'second block' }],
      }],
    },
  ];
  const r = await createOutputFilter(cfg(), { runFilter: stubRunner(calls) }).applyToMessages(messages);
  assert.equal(r.changed, false);
  assert.equal(calls.length, 0);
});

test('a single-text-block tool_result IS filtered, in place, preserving block shape', async () => {
  reset();
  const raw = pytestOutput();
  const messages = [
    { role: 'user', content: 'FIRST TASK' },
    toolUse('tu0', 'pytest tests/'),
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu0', content: [{ type: 'text', text: raw }] }] },
  ];
  const r = await createOutputFilter(cfg(), { runFilter: stubRunner([]) }).applyToMessages(messages);
  assert.equal(r.stats.blocksFiltered, 1);
  const block = blockAt(r.messages, 2);
  assert.ok(Array.isArray(block.content));
  assert.equal(block.content.length, 1);
  assert.equal(block.content[0].type, 'text');
  assert.notEqual(block.content[0].text, raw);
});

test('the input message array and its blocks are never mutated', async () => {
  reset();
  const raw = pytestOutput();
  const messages = transcript([{ command: 'pytest tests/', output: raw }]);
  const snapshot = JSON.stringify(messages);
  const r = await createOutputFilter(cfg(), { runFilter: stubRunner([]) }).applyToMessages(messages);
  assert.equal(r.changed, true);
  assert.equal(JSON.stringify(messages), snapshot, 'applyToMessages mutated its input');
});

test('a deep-frozen message array is filtered without throwing', async () => {
  reset();
  const messages = transcript([{ command: 'pytest tests/', output: pytestOutput() }]);
  // proxy.js freezes originalBody; compress() can hand those same objects back
  // on its normalization path, so the filter must be purely additive.
  const freeze = (v) => {
    if (v && typeof v === 'object') { Object.keys(v).forEach(k => freeze(v[k])); Object.freeze(v); }
    return v;
  };
  freeze(messages);
  const r = await createOutputFilter(cfg(), { runFilter: stubRunner([]) }).applyToMessages(messages);
  assert.equal(r.stats.blocksFiltered, 1);
});
