'use strict';

const { buildGuardDeps } = require('./budgets.js');
const { wireCacheThrashDeps } = require('./cache-thrash.js');
const { wirePollRewrite, __test: pollRewriteTest } = require('./poll-rewrite.js');
const { buildDailyRollupOpts } = require('./daily-rollup.js');

function clonePollRewriteDeps(pollRewrite) {
  if (!pollRewrite) return null;
  return {
    ...pollRewrite,
    projects: pollRewriteTest.cloneProjects(pollRewrite.projects),
  };
}

function buildServerDeps(config, guardDeps) {
  const pollRewrite = clonePollRewriteDeps(wirePollRewrite(config, guardDeps));
  return {
    proxyDeps: { guardDeps, pollRewrite },
    rollupOpts: buildDailyRollupOpts(config),
  };
}

function buildProductionDeps(config, testSeams) {
  const t = testSeams;
  const buildGuard = typeof t?.buildGuardDeps === 'function' ? t.buildGuardDeps : buildGuardDeps;
  const wireThrash = typeof t?.wireCacheThrashDeps === 'function' ? t.wireCacheThrashDeps : wireCacheThrashDeps;
  const buildSrv = typeof t?.buildServerDeps === 'function' ? t.buildServerDeps : buildServerDeps;
  const guardDeps = buildGuard(config);
  wireThrash(config, guardDeps, t);
  const { proxyDeps, rollupOpts } = buildSrv(config, guardDeps);
  return { guardDeps, proxyDeps, rollupOpts };
}

function startProduction(config, runtimeDeps, testSeams) {
  const { createServer, createProxy, startDailyRollupInterval, getRawStatsSnapshot } = runtimeDeps;
  const { guardDeps, proxyDeps, rollupOpts } = buildProductionDeps(config, testSeams);
  const listener = createProxy(proxyDeps);
  const server = createServer(listener);
  startDailyRollupInterval(getRawStatsSnapshot, rollupOpts);
  return { server, guardDeps, proxyDeps, rollupOpts };
}

module.exports = {
  buildServerDeps,
  buildProductionDeps,
  startProduction,
};
