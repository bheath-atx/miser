'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const pricingPath = require.resolve('../src/pricing.js');

function freshPricing(envValue) {
  delete require.cache[pricingPath];
  if (envValue === undefined) delete process.env.MISER_PRICING_JSON;
  else process.env.MISER_PRICING_JSON = envValue;
  return require('../src/pricing.js');
}

function restoreEnv(prev) {
  delete require.cache[pricingPath];
  if (prev === undefined) delete process.env.MISER_PRICING_JSON;
  else process.env.MISER_PRICING_JSON = prev;
}

test('Anthropic pricing table pins sonnet, opus, and haiku all five axes', () => {
  const prev = process.env.MISER_PRICING_JSON;
  try {
    const { getPricingTable } = freshPricing(undefined);
    const table = getPricingTable();
    assert.deepEqual(table['claude-sonnet-4-6'], {
      inputPerMTok: 3,
      outputPerMTok: 15,
      cacheReadPerMTok: 0.3,
      cacheWrite5mPerMTok: 3.75,
      cacheWrite1hPerMTok: 6,
    });
    assert.deepEqual(table['claude-opus-4-8'], {
      inputPerMTok: 5,
      outputPerMTok: 25,
      cacheReadPerMTok: 0.5,
      cacheWrite5mPerMTok: 6.25,
      cacheWrite1hPerMTok: 10,
    });
    assert.deepEqual(table['claude-haiku-4-5'], {
      inputPerMTok: 1,
      outputPerMTok: 5,
      cacheReadPerMTok: 0.1,
      cacheWrite5mPerMTok: 1.25,
      cacheWrite1hPerMTok: 2,
    });
    // Dated API response ID must resolve to same prices (not fall through to * fallback)
    assert.deepEqual(table['claude-haiku-4-5-20251001'], {
      inputPerMTok: 1,
      outputPerMTok: 5,
      cacheReadPerMTok: 0.1,
      cacheWrite5mPerMTok: 1.25,
      cacheWrite1hPerMTok: 2,
    });
  } finally {
    restoreEnv(prev);
  }
});

test('unknown model uses fallback pricing and returns 6dp number', () => {
  const prev = process.env.MISER_PRICING_JSON;
  const prevWarn = console.warn;
  const warns = [];
  console.warn = (line) => warns.push(String(line));
  try {
    const { computeCost } = freshPricing(undefined);
    const cost = computeCost({ anthropic: { unknown: { input: 1_000_000, output: 1 } } });
    assert.equal(cost, 3.000015);
    assert.equal(typeof cost, 'number');
    assert.match(warns.join('\n'), /unknown Anthropic model unknown/);
  } finally {
    console.warn = prevWarn;
    restoreEnv(prev);
  }
});

test('MISER_PRICING_JSON partial override merges over defaults', () => {
  const prev = process.env.MISER_PRICING_JSON;
  try {
    const { getPricingTable } = freshPricing(JSON.stringify({
      'claude-sonnet-4-6': { inputPerMTok: 9 },
      'custom-model': { outputPerMTok: 2 },
    }));
    const table = getPricingTable();
    assert.equal(table['claude-sonnet-4-6'].inputPerMTok, 9);
    assert.equal(table['claude-sonnet-4-6'].outputPerMTok, 15);
    assert.deepEqual(table['custom-model'], {
      inputPerMTok: 3,
      outputPerMTok: 2,
      cacheReadPerMTok: 0.3,
      cacheWrite5mPerMTok: 3.75,
      cacheWrite1hPerMTok: 6,
    });
  } finally {
    restoreEnv(prev);
  }
});

test('malformed MISER_PRICING_JSON falls back to defaults without throwing', () => {
  const prev = process.env.MISER_PRICING_JSON;
  const prevWarn = console.warn;
  const warns = [];
  console.warn = (line) => warns.push(String(line));
  try {
    const { getPricingTable } = freshPricing('{bad');
    assert.doesNotThrow(() => getPricingTable());
    assert.equal(getPricingTable()['claude-haiku-4-5'].inputPerMTok, 1);
    assert.match(warns.join('\n'), /invalid MISER_PRICING_JSON/);
  } finally {
    console.warn = prevWarn;
    restoreEnv(prev);
  }
});
