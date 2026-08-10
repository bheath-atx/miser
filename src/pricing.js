'use strict';

// Source snapshot: Anthropic pricing docs, https://platform.claude.com/docs/en/about-claude/pricing
// Pinned 2026-07-22; re-verified 2026-07-23 and 2026-08-09. Values are USD per million tokens.
// Claude Sonnet 5 has time-tiered docs pricing. DEFAULT_PRICING carries the introductory
// rate through 2026-08-31; update this entry to the 2026-09-01+ standard rate on rollover.
// Dated API response model IDs (e.g. claude-haiku-4-5-20251001) are aliased to the base ID so
// priceForModel() never falls through to the * fallback for known models.
const _HAIKU_4_5 = Object.freeze({
  inputPerMTok: 1.000000,
  outputPerMTok: 5.000000,
  cacheReadPerMTok: 0.100000,
  cacheWrite5mPerMTok: 1.250000,
  cacheWrite1hPerMTok: 2.000000,
});
const DEFAULT_PRICING = Object.freeze({
  'claude-sonnet-4-6': Object.freeze({
    inputPerMTok: 3.000000,
    outputPerMTok: 15.000000,
    cacheReadPerMTok: 0.300000,
    cacheWrite5mPerMTok: 3.750000,
    cacheWrite1hPerMTok: 6.000000,
  }),
  'claude-opus-4-8': Object.freeze({
    inputPerMTok: 5.000000,
    outputPerMTok: 25.000000,
    cacheReadPerMTok: 0.500000,
    cacheWrite5mPerMTok: 6.250000,
    cacheWrite1hPerMTok: 10.000000,
  }),
  'claude-opus-5': Object.freeze({
    inputPerMTok: 5.000000,
    outputPerMTok: 25.000000,
    cacheReadPerMTok: 0.500000,
    cacheWrite5mPerMTok: 6.250000,
    cacheWrite1hPerMTok: 10.000000,
  }),
  'claude-sonnet-5': Object.freeze({
    inputPerMTok: 2.000000,
    outputPerMTok: 10.000000,
    cacheReadPerMTok: 0.200000,
    cacheWrite5mPerMTok: 2.500000,
    cacheWrite1hPerMTok: 4.000000,
  }),
  'claude-fable-5': Object.freeze({
    inputPerMTok: 10.000000,
    outputPerMTok: 50.000000,
    cacheReadPerMTok: 1.000000,
    cacheWrite5mPerMTok: 12.500000,
    cacheWrite1hPerMTok: 20.000000,
  }),
  'claude-haiku-4-5': _HAIKU_4_5,
  'claude-haiku-4-5-20251001': _HAIKU_4_5,
  '*': Object.freeze({
    inputPerMTok: 3.000000,
    outputPerMTok: 15.000000,
    cacheReadPerMTok: 0.300000,
    cacheWrite5mPerMTok: 3.750000,
    cacheWrite1hPerMTok: 6.000000,
  }),
});

const PRICE_KEYS = Object.freeze([
  'inputPerMTok',
  'outputPerMTok',
  'cacheReadPerMTok',
  'cacheWrite5mPerMTok',
  'cacheWrite1hPerMTok',
]);

let _cachedRaw = null;
let _cachedPricing = null;

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

function cloneDefaults() {
  const out = {};
  for (const [model, price] of Object.entries(DEFAULT_PRICING)) {
    out[model] = { ...price };
  }
  return out;
}

function normalizedOverridePrice(model, override, base) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return null;
  const out = { ...(base || DEFAULT_PRICING['*']) };
  for (const key of PRICE_KEYS) {
    if (Number.isFinite(override[key])) out[key] = override[key];
  }
  return out;
}

function getPricingTable() {
  const raw = process.env.MISER_PRICING_JSON || '';
  if (_cachedPricing && raw === _cachedRaw) return _cachedPricing;

  const pricing = cloneDefaults();
  if (raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('override must be a JSON object');
      }
      for (const [model, override] of Object.entries(parsed)) {
        const merged = normalizedOverridePrice(model, override, pricing[model]);
        if (merged) pricing[model] = merged;
      }
    } catch (err) {
      console.warn(`[miser/pricing] WARN invalid MISER_PRICING_JSON: ${err.message}; using defaults`);
      _cachedRaw = raw;
      _cachedPricing = cloneDefaults();
      return _cachedPricing;
    }
  }

  _cachedRaw = raw;
  _cachedPricing = pricing;
  return _cachedPricing;
}

function priceForModel(model) {
  const table = getPricingTable();
  if (table[model]) return table[model];
  console.warn(`[miser/pricing] WARN unknown Anthropic model ${model || 'unknown'}; using fallback pricing`);
  return table['*'];
}

function hasExplicitPriceForModel(model) {
  const table = getPricingTable();
  return !!(model && Object.prototype.hasOwnProperty.call(table, model) && model !== '*');
}

function computeCost(usageTree) {
  let total = 0;
  for (const [provider, models] of Object.entries(usageTree || {})) {
    if (provider !== 'anthropic' || !models || typeof models !== 'object') continue;
    for (const [model, bucket] of Object.entries(models)) {
      if (!bucket || typeof bucket !== 'object') continue;
      const price = priceForModel(model);
      total += ((bucket.input || 0) / 1_000_000) * price.inputPerMTok;
      total += ((bucket.output || 0) / 1_000_000) * price.outputPerMTok;
      total += ((bucket.cacheRead || 0) / 1_000_000) * price.cacheReadPerMTok;
      total += ((bucket.cacheWrite5m || 0) / 1_000_000) * price.cacheWrite5mPerMTok;
      total += ((bucket.cacheWrite1h || 0) / 1_000_000) * price.cacheWrite1hPerMTok;
    }
  }
  return round6(total);
}

function __resetForTest() {
  _cachedRaw = null;
  _cachedPricing = null;
}

module.exports = {
  DEFAULT_PRICING,
  getPricingTable,
  priceForModel,
  hasExplicitPriceForModel,
  computeCost,
  round6,
  __resetForTest,
};
