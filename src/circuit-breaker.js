'use strict';

// Per-upstream circuit breaker. States: CLOSED → OPEN → HALF_OPEN → CLOSED.
// Trip condition: `threshold` consecutive retryable failures after retries exhausted.
// OPEN → HALF_OPEN transition is lazy (computed on next acquire() call, no timer).
// Probe slot cleared synchronously within acquire() — Node single-thread guarantee
// ensures two consecutive same-tick calls cannot both claim the probe.

function createBreaker(name, opts = {}) {
  const threshold = opts.threshold != null ? opts.threshold : 5;
  const resetMs = opts.resetMs != null ? opts.resetMs : 30_000;
  const nowFn = opts.nowFn || (() => Date.now());

  let state = 'CLOSED';
  let failures = 0;
  let openedAt = null;
  let probeAllowed = false;

  return {
    acquire() {
      if (state === 'OPEN') {
        if (nowFn() - openedAt >= resetMs) {
          state = 'HALF_OPEN';
          probeAllowed = true;
        } else {
          return false;
        }
      }
      if (state === 'HALF_OPEN') {
        if (probeAllowed) {
          probeAllowed = false; // cleared synchronously — only one probe per reset window
          return true;
        }
        return false;
      }
      // CLOSED
      return true;
    },

    recordSuccess() {
      failures = 0;
      if (state === 'HALF_OPEN') {
        state = 'CLOSED';
        openedAt = null;
        probeAllowed = false;
      }
    },

    recordFailure() {
      if (state === 'HALF_OPEN') {
        // probe failed — re-OPEN with new openedAt
        state = 'OPEN';
        openedAt = nowFn();
        probeAllowed = false;
        return;
      }
      failures += 1;
      if (state === 'CLOSED' && failures >= threshold) {
        state = 'OPEN';
        openedAt = nowFn();
      }
    },

    getState() {
      return { state, failures, openedAt };
    },
  };
}

module.exports = { createBreaker };
