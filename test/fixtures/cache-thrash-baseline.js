'use strict';

function createCacheThrashChecker(config) {
  if (config.cacheThrashMinRequests === 0) {
    return {
      check: () => {},
      getStatus: () => ({ warm: false, insufficientBaseline: true }),
    };
  }

  const _states = new Map();
  const minReq  = config.cacheThrashMinRequests;
  const maxRing = config.cacheThrashRingSize;

  function getOrCreate(project) {
    if (!_states.has(project)) {
      _states.set(project, { ring: [], hasNonZeroPriorBaseline: false });
    }
    return _states.get(project);
  }

  function observeUsage(state, project, rawUsage) {
    const inputTokens = (rawUsage.input_tokens) || 0;
    const creation = (rawUsage.cache_creation && typeof rawUsage.cache_creation === 'object')
      ? rawUsage.cache_creation : {};
    const cacheWrite1h = (creation.ephemeral_1h_input_tokens) || rawUsage.cache_creation_input_tokens || 0;

    const priorEntries = [...state.ring];
    state.ring.push({ inputTokens, cacheWrite1h });
    if (state.ring.length > maxRing) state.ring.shift();

    if (priorEntries.length < minReq) {
      return { warm: false, insufficientBaseline: true, shouldAlert: false };
    }

    const avgCacheWrite1hPrior = priorEntries.length > 0
      ? priorEntries.reduce((s, e) => s + e.cacheWrite1h, 0) / priorEntries.length
      : 0;
    const avgInputTokensPrior = priorEntries.length > 0
      ? priorEntries.reduce((s, e) => s + e.inputTokens, 0) / priorEntries.length
      : 0;

    if (avgCacheWrite1hPrior === 0) {
      if (cacheWrite1h > 0) {
        console.log(`[miser] thrash-detector: first cache-write observed for project=${project}, establishing baseline`);
        state.hasNonZeroPriorBaseline = false;
      }
      return { warm: true, insufficientBaseline: true, shouldAlert: false };
    }

    state.hasNonZeroPriorBaseline = true;

    const spiking    = cacheWrite1h > config.cacheThrashSpikeRatio * avgCacheWrite1hPrior;
    const inputNormal = inputTokens < config.cacheThrashInputSpikeRatio * avgInputTokensPrior;
    const shouldAlert = spiking && inputNormal && cacheWrite1h > 0;

    return {
      warm: true,
      insufficientBaseline: false,
      shouldAlert,
      details: { cacheWrite1h, avgCacheWrite1hPrior, inputTokens, avgInputTokensPrior },
    };
  }

  function check(project, model, rawUsage, guardDeps) {
    try {
      if (!rawUsage) return { warm: false, insufficientBaseline: true, shouldAlert: false };
      const state = getOrCreate(project);
      const result = observeUsage(state, project, rawUsage);
      if (result.shouldAlert && guardDeps && guardDeps.ledger
          && guardDeps.ledger.shouldSend('thrash:' + project)) {
        guardDeps.ledger.markSent('thrash:' + project);
        const { details } = result;
        if (!guardDeps.sendAlert) {
          // Pre-dispatcher check (§3.3 / §2.7 ownership table).
          console.warn(`[miser/alert] ALERT-DROPPED project=${project} kind=cache-thrash reason=no_dispatcher`);
          require('./alert-routes.js').bumpDropped();
          return result;
        }
        Promise.resolve()
          .then(() => guardDeps.sendAlert(
            `⚠️ miser cache-thrash: project=${project} model=${model} — ` +
            `cacheWrite1h ${details.cacheWrite1h} vs prior avg ${details.avgCacheWrite1hPrior.toFixed(0)} ` +
            `(${(details.cacheWrite1h / details.avgCacheWrite1hPrior).toFixed(1)}×); ` +
            `inputTokens=${details.inputTokens} normal ` +
            `(${(details.inputTokens / (details.avgInputTokensPrior || 1)).toFixed(1)}× avg) — prefix mutation suspected`,
            { project, kind: 'cache-thrash' }
          ))
          .catch(e => console.warn('[miser] thrash alert error:', e.message));
      }
      return result;
    } catch (e) {
      console.warn('[miser] thrash check error:', e.message);
      return { warm: false, insufficientBaseline: true, shouldAlert: false };
    }
  }

  function getStatus(project) {
    const state = _states.get(project);
    if (!state || state.ring.length === 0) return { warm: false, insufficientBaseline: true };
    if (state.ring.length < minReq) return { warm: false, insufficientBaseline: true };
    return { warm: true, insufficientBaseline: !state.hasNonZeroPriorBaseline };
  }

  return { check, getStatus };
}

function wireCacheThrashDeps(config, guardDeps, seams) {
  if (config.cacheThrashMinRequests === 0) return;

  // Pure CONSUMER now (§3.2): wireAlertDispatcher owns dispatcher + ledger
  // construction. The absence-guards remain so a cache-thrash-only config that
  // somehow reaches here without the composition root still gets a ledger, but
  // the PRODUCTION FALLBACK to daily-rollup.sendAlert is DELETED (§3.1) — there
  // is no expression here that can produce a network-capable dispatcher.
  if (!guardDeps.ledger) {
    const mkLedger = (seams && seams.createLedger) || require('./alert-ledger.js').createLedger;
    guardDeps.ledger = mkLedger();
    guardDeps.nowFn = () => new Date();
  }
  if (!guardDeps.sendAlert && seams && seams.sendAlert) {
    guardDeps.sendAlert = seams.sendAlert;
  }
  const factory = (seams && seams.createCacheThrashChecker) || createCacheThrashChecker;
  const thrash = factory(config);
  guardDeps.checkCacheThrash    = thrash.check;
  guardDeps.getCacheThrashStatus = thrash.getStatus;
}

module.exports = { createCacheThrashChecker, wireCacheThrashDeps };
