'use strict';

const { computeCost } = require('./pricing.js');

function labelEscape(str) {
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

function buildMetricsText(statsResult) {
  const usage = (statsResult && statsResult.usage) || {};
  const lines = [];

  lines.push('# HELP miser_tokens_7d Token usage in the last 7 days (rolling window), by project/provider/model/type.');
  lines.push('# TYPE miser_tokens_7d gauge');
  for (const [project, providerMap] of Object.entries(usage)) {
    if (!providerMap || typeof providerMap !== 'object') continue;
    for (const [provider, modelMap] of Object.entries(providerMap)) {
      if (!modelMap || typeof modelMap !== 'object') continue;
      for (const [model, bucket] of Object.entries(modelMap)) {
        if (!bucket || typeof bucket !== 'object') continue;
        const lp   = labelEscape(project);
        const lpro = labelEscape(provider);
        const lmod = labelEscape(model);
        const emit = (type, value) => {
          if (!Number.isFinite(value) || value <= 0) return;
          lines.push(`miser_tokens_7d{project="${lp}",provider="${lpro}",model="${lmod}",type="${labelEscape(type)}"} ${value}`);
        };
        emit('input',         bucket.input);
        emit('output',        bucket.output);
        emit('cache_read',    bucket.cacheRead);
        emit('cache_write_1h', bucket.cacheWrite1h);
        emit('cache_write_5m', bucket.cacheWrite5m);
      }
    }
  }

  lines.push('# HELP miser_requests_7d Request count in the last 7 days (rolling window), by project/provider/model.');
  lines.push('# TYPE miser_requests_7d gauge');
  for (const [project, providerMap] of Object.entries(usage)) {
    if (!providerMap || typeof providerMap !== 'object') continue;
    for (const [provider, modelMap] of Object.entries(providerMap)) {
      if (!modelMap || typeof modelMap !== 'object') continue;
      for (const [model, bucket] of Object.entries(modelMap)) {
        if (!bucket || typeof bucket !== 'object') continue;
        if (!Number.isFinite(bucket.requests) || bucket.requests <= 0) continue;
        const lp   = labelEscape(project);
        const lpro = labelEscape(provider);
        const lmod = labelEscape(model);
        lines.push(`miser_requests_7d{project="${lp}",provider="${lpro}",model="${lmod}"} ${bucket.requests}`);
      }
    }
  }

  lines.push('# HELP miser_cost_usd_7d Estimated cost in USD in the last 7 days (rolling window), by project.');
  lines.push('# TYPE miser_cost_usd_7d gauge');
  for (const [project, providerMap] of Object.entries(usage)) {
    if (!providerMap || typeof providerMap !== 'object') continue;
    const cost = computeCost(providerMap);
    if (!Number.isFinite(cost) || cost <= 0) continue;
    lines.push(`miser_cost_usd_7d{project="${labelEscape(project)}"} ${cost}`);
  }

  return lines.join('\n') + '\n';
}

module.exports = { buildMetricsText, labelEscape };
