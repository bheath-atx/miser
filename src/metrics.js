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

  lines.push('# HELP miser_authoritative Stats rolling-window aggregate authority state (1 authoritative, 0 non-authoritative).');
  lines.push('# TYPE miser_authoritative gauge');
  if (statsResult && typeof statsResult.authoritative === 'boolean') {
    lines.push(`miser_authoritative ${statsResult.authoritative ? 1 : 0}`);
  }

  lines.push('# HELP miser_degraded Stats persistence degradation state (1 degraded, 0 healthy).');
  lines.push('# TYPE miser_degraded gauge');
  if (statsResult && typeof statsResult.degraded === 'boolean') {
    lines.push(`miser_degraded ${statsResult.degraded ? 1 : 0}`);
  }

  lines.push('# HELP miser_persistence_healthy Stats persistence health state (1 healthy, 0 unhealthy).');
  lines.push('# TYPE miser_persistence_healthy gauge');
  if (statsResult && statsResult.persistence && typeof statsResult.persistence.healthy === 'boolean') {
    lines.push(`miser_persistence_healthy ${statsResult.persistence.healthy ? 1 : 0}`);
  }

  lines.push('# HELP miser_persistence_durable Stats persistence durability state (1 durable, 0 pending or degraded).');
  lines.push('# TYPE miser_persistence_durable gauge');
  if (statsResult && statsResult.persistence && typeof statsResult.persistence.durable === 'boolean') {
    lines.push(`miser_persistence_durable ${statsResult.persistence.durable ? 1 : 0}`);
  }

  lines.push('# HELP miser_persistence_pending Stats persistence pending-write state (1 pending, 0 not pending).');
  lines.push('# TYPE miser_persistence_pending gauge');
  if (statsResult && statsResult.persistence && typeof statsResult.persistence.pending === 'boolean') {
    lines.push(`miser_persistence_pending ${statsResult.persistence.pending ? 1 : 0}`);
  }

  lines.push('# HELP miser_persistence_dirty Stats persistence dirty state (1 has unwritten changes, 0 clean).');
  lines.push('# TYPE miser_persistence_dirty gauge');
  if (statsResult && statsResult.persistence && typeof statsResult.persistence.dirty === 'boolean') {
    lines.push(`miser_persistence_dirty ${statsResult.persistence.dirty ? 1 : 0}`);
  }

  lines.push('# HELP miser_persistence_in_flight Stats persistence write-in-flight state (1 writing, 0 idle).');
  lines.push('# TYPE miser_persistence_in_flight gauge');
  if (statsResult && statsResult.persistence && typeof statsResult.persistence.inFlight === 'boolean') {
    lines.push(`miser_persistence_in_flight ${statsResult.persistence.inFlight ? 1 : 0}`);
  }

  lines.push('# HELP miser_persistence_last_flush_errored Stats persistence last-flush error state (1 errored, 0 clean).');
  lines.push('# TYPE miser_persistence_last_flush_errored gauge');
  if (statsResult && statsResult.persistence && typeof statsResult.persistence.lastFlushErrored === 'boolean') {
    lines.push(`miser_persistence_last_flush_errored ${statsResult.persistence.lastFlushErrored ? 1 : 0}`);
  }

  lines.push('# HELP miser_persistence_last_load_errored Stats persistence last-load error state (1 errored, 0 clean).');
  lines.push('# TYPE miser_persistence_last_load_errored gauge');
  if (statsResult && statsResult.persistence && typeof statsResult.persistence.lastLoadErrored === 'boolean') {
    lines.push(`miser_persistence_last_load_errored ${statsResult.persistence.lastLoadErrored ? 1 : 0}`);
  }

  lines.push('# HELP miser_persistence_write_failures Consecutive stats persistence write failure count.');
  lines.push('# TYPE miser_persistence_write_failures gauge');
  if (statsResult && statsResult.persistence && Number.isFinite(statsResult.persistence.writeFailures)) {
    lines.push(`miser_persistence_write_failures ${statsResult.persistence.writeFailures}`);
  }

  lines.push('# HELP miser_persistence_last_error Stats persistence last error code presence.');
  lines.push('# TYPE miser_persistence_last_error gauge');
  if (statsResult && statsResult.persistence && typeof statsResult.persistence.lastErrorCode === 'string'
      && statsResult.persistence.lastErrorCode) {
    lines.push(`miser_persistence_last_error{code="${labelEscape(statsResult.persistence.lastErrorCode)}"} 1`);
  }

  lines.push('# HELP miser_weekly_authoritative Stats weekly payload authority state (1 all exposed weeks authoritative, 0 some weeks non-authoritative).');
  lines.push('# TYPE miser_weekly_authoritative gauge');
  if (statsResult && typeof statsResult.weeklyAuthoritative === 'boolean') {
    lines.push(`miser_weekly_authoritative ${statsResult.weeklyAuthoritative ? 1 : 0}`);
  }

  lines.push('# HELP miser_non_authoritative_weeks Non-authoritative week count in the stats payload.');
  lines.push('# TYPE miser_non_authoritative_weeks gauge');
  if (statsResult && Number.isFinite(statsResult.nonAuthoritativeWeekCount)) {
    lines.push(`miser_non_authoritative_weeks ${statsResult.nonAuthoritativeWeekCount}`);
  }

  lines.push('# HELP miser_non_authoritative_week_reasons Non-authoritative week reason presence in the stats payload.');
  lines.push('# TYPE miser_non_authoritative_week_reasons gauge');
  for (const reason of (Array.isArray(statsResult && statsResult.nonAuthoritativeReasons)
    ? statsResult.nonAuthoritativeReasons : [])) {
    lines.push(`miser_non_authoritative_week_reasons{reason="${labelEscape(reason)}"} 1`);
  }

  const rejections = (statsResult && statsResult.recordRejections) || null;
  lines.push('# HELP miser_record_rejections Rejected or dropped stats record count, by reason.');
  lines.push('# TYPE miser_record_rejections gauge');
  if (rejections && typeof rejections === 'object') {
    for (const reason of ['total', 'invalidTimestamp', 'outOfBoundsTimestamp', 'loadFailureRefusal']) {
      if (Number.isFinite(rejections[reason])) {
        lines.push(`miser_record_rejections{reason="${labelEscape(reason)}"} ${rejections[reason]}`);
      }
    }
  }

  lines.push('# HELP miser_record_rejections_by_label Rejected or dropped stats record count, by stats label.');
  lines.push('# TYPE miser_record_rejections_by_label gauge');
  const byLabel = rejections && rejections.byLabel;
  if (byLabel && typeof byLabel === 'object') {
    for (const [label, value] of Object.entries(byLabel).sort(([a], [b]) => a.localeCompare(b))) {
      if (Number.isFinite(value)) {
        lines.push(`miser_record_rejections_by_label{label="${labelEscape(label)}"} ${value}`);
      }
    }
  }

  const unpriced = (statsResult && statsResult.unpriced_models) || {};
  lines.push('# HELP miser_unpriced_requests_7d Fallback-priced Anthropic request count in the last 7 days, by model.');
  lines.push('# TYPE miser_unpriced_requests_7d gauge');
  for (const [model, days] of Object.entries(unpriced)) {
    if (!days || typeof days !== 'object') continue;
    const total = Object.values(days).reduce((sum, n) => sum + (Number.isFinite(n) ? n : 0), 0);
    if (total > 0) lines.push(`miser_unpriced_requests_7d{model="${labelEscape(model)}"} ${total}`);
  }

  const pace = statsResult && statsResult.pace;
  lines.push('# HELP miser_routed_weighted_tokens_week_to_date Weighted token equivalents for miser-routed Anthropic traffic only; this is a floor because unrouted panels are not counted.');
  lines.push('# TYPE miser_routed_weighted_tokens_week_to_date gauge');
  if (pace && Number.isFinite(pace.weightedRoutedConsumed)) {
    lines.push(`miser_routed_weighted_tokens_week_to_date ${pace.weightedRoutedConsumed}`);
  }
  lines.push('# HELP miser_routed_consumed_frac Miser-routed fraction of weekly cap; floor scope only, not transcript-visible fleet consumption.');
  lines.push('# TYPE miser_routed_consumed_frac gauge');
  if (pace && Number.isFinite(pace.routedConsumedFrac)) {
    lines.push(`miser_routed_consumed_frac ${pace.routedConsumedFrac}`);
  }
  lines.push('# HELP miser_routed_pace_delta Miser-routed consumed fraction minus elapsed week fraction; input only, no pace verdict.');
  lines.push('# TYPE miser_routed_pace_delta gauge');
  if (pace && Number.isFinite(pace.routedPaceDelta)) {
    lines.push(`miser_routed_pace_delta ${pace.routedPaceDelta}`);
  }
  lines.push('# HELP miser_limit_events_7d Provider usage-limit events observed by miser in the last 7 days.');
  lines.push('# TYPE miser_limit_events_7d gauge');
  if (Array.isArray(statsResult && statsResult.limitEvents)) {
    lines.push(`miser_limit_events_7d ${statsResult.limitEvents.length}`);
  }

  return lines.join('\n') + '\n';
}

module.exports = { buildMetricsText, labelEscape };
