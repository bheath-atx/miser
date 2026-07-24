'use strict';

// Codex subscription-cap tracker (B3). Tracks successful requests and 429 events
// in rolling ring buffers. No I/O — pure in-memory. Resets on process restart
// (a false-clear is safe per spec).
//
// deferBackground = capFraction >= 0.80 || events429In5h > 0
// shouldAlert     = capFraction >= 0.80 || events429In5h > 0   (same predicate)
// timeToLimitEstMs = (cap5h - requestsIn5h) * WINDOW_5H_MS / requestsIn5h
//                    null when cap5h <= 0 or burn rate is zero

const WINDOW_5H_MS = 5 * 60 * 60 * 1000;
const WINDOW_7D_MS = 7 * 24 * 60 * 60 * 1000;

function createSubCapTracker(opts = {}) {
  const cap5h = opts.cap5h || 0;
  const weeklyCap = opts.weeklyCap || 0;
  const _successes = [];  // ms timestamps, up to 7-day retention
  const _events429 = [];  // ms timestamps, up to 7-day retention

  function prune(nowMs) {
    const cutoff7d = nowMs - WINDOW_7D_MS;
    while (_successes.length > 0 && _successes[0] < cutoff7d) _successes.shift();
    while (_events429.length > 0 && _events429[0] < cutoff7d) _events429.shift();
  }

  return {
    recordSuccess(nowMs) {
      _successes.push(nowMs);
    },

    record429(nowMs) {
      _events429.push(nowMs);
    },

    getStatus(nowMs) {
      prune(nowMs);
      const cutoff5h = nowMs - WINDOW_5H_MS;
      const requestsIn5h = _successes.filter(t => t >= cutoff5h).length;
      const events429In5h = _events429.filter(t => t >= cutoff5h).length;

      const capFraction = cap5h > 0 ? requestsIn5h / cap5h : 0;
      const deferBackground = capFraction >= 0.80 || events429In5h > 0;
      const shouldAlert = capFraction >= 0.80 || events429In5h > 0;

      const cutoff7d = nowMs - WINDOW_7D_MS;
      const weeklyRequests = _successes.filter(t => t >= cutoff7d).length;
      const weeklyCapFraction = weeklyCap > 0 ? weeklyRequests / weeklyCap : 0;

      const burnRatePerHour = requestsIn5h / 5;

      let timeToLimitEstMs = null;
      if (cap5h > 0 && requestsIn5h > 0) {
        timeToLimitEstMs = (cap5h - requestsIn5h) * WINDOW_5H_MS / requestsIn5h;
      }

      return {
        requestsIn5h,
        events429In5h,
        cap5h,
        capFraction,
        deferBackground,
        weeklyRequests,
        weeklyCap,
        weeklyCapFraction,
        burnRatePerHour,
        timeToLimitEstMs,
        shouldAlert,
      };
    },
  };
}

module.exports = { createSubCapTracker };
