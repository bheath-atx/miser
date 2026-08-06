'use strict';

const { isValidProjectName } = require('./routing.js');
const { postPkachu, defaultRouteFromEnv } = require('./daily-rollup.js');

// Project-aware alert routing + the single outbound alert dispatcher.
//
// Dependency direction is ONE WAY and must stay that way (PROPOSAL §2.9, AR16):
//   config.js -> alert-routes.js -> daily-rollup.js
// daily-rollup.js must NEVER require config.js or alert-routes.js. §2.6 inverts
// the rollup's route lookup (the resolver is injected downward from index.js)
// precisely so that stays true.
//
// Reserved namespace (§2.2): PROJECT_RE (routing.js:3) excludes '@', so every
// sentinel and internal bucket label here starts with '@' and CANNOT collide
// with any project name that could reach the resolver. That is a proof by
// grammar, not a convention — AR27 asserts it.
const SENTINEL_DEFAULT = '@default';
const BUCKET_INVALID = '@invalid';
const BUCKET_OVERFLOW = '@overflow';
const OPS_LABEL = '@ops';

const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// ---------------------------------------------------------------------------
// THE STRICTNESS SWITCH (§2.3)
// This table IS the failure policy for alert routing. Nothing else in the
// module decides fatal-vs-degraded; every call site asks this table — axis C
// via enforceAxisC() below, axis D directly in parseAlertRoutes.
//
// Axis D: changing the value changes the policy, no other edit required.
// Axis C: only 'fatal' has an implemented code path. Flipping one of those
// rows fails LOUDLY rather than silently admitting a malformed route, because
// what 'degraded' should mean for a misstated route is a design question §2.3
// does not answer. The comment here previously claimed a flip was free for all
// four rows while the table had no callers at all; corrected per CODEX-BA-R1.
// Axis letters refer to PROPOSAL §2.0.
// ---------------------------------------------------------------------------
function buildFailurePolicy(config = {}) {
  return {
    malformed_entry: 'fatal',                                             // axis C
    unsafe_endpoint: 'fatal',                                             // axis C
    malformed_ops: 'fatal',                                               // axis C
    incomplete_map: config.alertRoutesStrict ? 'fatal' : 'degraded',      // axis D — DEFAULT: degraded
  };
}

// Axis-C enforcement — the table decides, this asks. Before this existed the
// three axis-C rows were hard-coded throws that never consulted
// buildFailurePolicy, which made §2.3's "every call site asks this table" and
// §11's "overrulable by one line" false as written (CODEX-BA-R1 item 4).
//
// Only 'fatal' has an implemented code path for axis C: "degraded" for a
// malformed route would mean admitting a route the operator stated incorrectly,
// and what to do instead (drop the entry? fall back to default? which health
// cause?) is a design question §2.3 does not answer. So a value the table does
// not implement fails LOUDLY here rather than silently admitting a bad route —
// the failure mode that a silent no-op branch would have created.
function enforceAxisC(policy, axis, message) {
  if (policy[axis] === 'fatal') throw new Error(message);
  throw new Error(
    `[miser] fatal: alert-routing failure policy ${axis}='${policy[axis]}' has no implemented code ` +
    `path — only 'fatal' is implemented for axis C (§2.3). Implement that axis's degraded path before ` +
    `flipping this row. The condition that triggered it: ${message}`
  );
}

// ---------------------------------------------------------------------------
// Counters (§2.7). Module-level with an accessor, mirroring the _legErrors
// pattern in router.js:17-25 exactly — same shape, same file conventions.
// ---------------------------------------------------------------------------
const _counters = { delivered: 0, withheld: 0, withheldOverflow: 0, dropped: 0, failed: 0 };
// Bounded runtime state for the unroutable path (§2.4). Cleared on the same UTC
// day boundary the ledger uses, so a legitimate new project is not permanently
// locked out by a burst.
let _unroutedRuntime = new Set();
let _unroutedRuntimeDay = null;
let _unroutedOverflowCount = 0;
let _invalidProjectAlerts = 0;
let _invalidSamples = [];

function getAlertCounters() {
  return { ..._counters };
}

function bumpDropped() {
  _counters.dropped += 1;
}

function getRuntimeRoutingState() {
  return {
    unroutedRuntime: [..._unroutedRuntime],
    unroutedRuntimeOverflow: _unroutedOverflowCount,
    invalidProjectAlerts: _invalidProjectAlerts,
    invalidSamples: [..._invalidSamples],
  };
}

// Test-only reset. Production never calls this; module-level state is per-process.
function __resetAlertState() {
  for (const k of Object.keys(_counters)) _counters[k] = 0;
  _unroutedRuntime = new Set();
  _unroutedRuntimeDay = null;
  _unroutedOverflowCount = 0;
  _invalidProjectAlerts = 0;
  _invalidSamples = [];
}

// ---------------------------------------------------------------------------
// Shared route-value validator (§2.5, AR22). ONE implementation, used by both
// MISER_ALERT_ROUTES entries and MISER_ALERT_ROUTES_OPS — not two that could
// drift. Throws (axis C fatal) naming the offending key and the violation.
// ---------------------------------------------------------------------------
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost', '[::1]']);

function validateRouteValue(label, value, allowRemote, policy = buildFailurePolicy({}), axis = 'malformed_entry') {
  // The ops route is governed by its own row; a map entry's unsafe-endpoint
  // case is governed by unsafe_endpoint, everything else by malformed_entry.
  const unsafeAxis = axis === 'malformed_ops' ? 'malformed_ops' : 'unsafe_endpoint';
  if (value === SENTINEL_DEFAULT) return SENTINEL_DEFAULT;

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    enforceAxisC(policy, axis,
      `[miser] fatal: MISER_ALERT_ROUTES entry "${label}" must be the string "${SENTINEL_DEFAULT}" ` +
      `or an object {endpoint, tokenFile} — got ${Array.isArray(value) ? 'an array' : typeof value}.`
    );
  }
  // Key-exactness: the same strictness as budgets.js:48 / policy-watchdog.js:47,
  // but fatal instead of skip (§2.2).
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== 'endpoint' || keys[1] !== 'tokenFile') {
    enforceAxisC(policy, axis,
      `[miser] fatal: MISER_ALERT_ROUTES entry "${label}" must have exactly the keys ` +
      `{endpoint, tokenFile} — got {${keys.join(', ')}}.`
    );
  }
  const { endpoint, tokenFile } = value;

  let url;
  try {
    url = new URL(endpoint);
  } catch (_) {
    enforceAxisC(policy, axis,
      `[miser] fatal: MISER_ALERT_ROUTES entry "${label}" endpoint is not a parseable URL: ${endpoint}`
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    enforceAxisC(policy, axis,
      `[miser] fatal: MISER_ALERT_ROUTES entry "${label}" endpoint protocol must be http: or https: ` +
      `— got ${url.protocol}`
    );
  }
  if (!allowRemote && !LOOPBACK_HOSTS.has(url.hostname)) {
    // Not theoretical: alert bodies carry per-project spend figures and model
    // names, and a typo'd or poisoned endpoint would exfiltrate them with a
    // valid bearer token attached (§2.2).
    enforceAxisC(policy, axis,
      `[miser] fatal: MISER_ALERT_ROUTES entry "${label}" endpoint host "${url.hostname}" is not ` +
      `loopback. Alert bodies carry per-project spend and model names plus a bearer token; sending ` +
      `them off-host requires MISER_ALERT_ROUTES_ALLOW_REMOTE=1 as an explicit opt-in.`
    );
  }
  if (typeof tokenFile !== 'string' || !tokenFile.startsWith('/')) {
    enforceAxisC(policy, unsafeAxis,
      `[miser] fatal: MISER_ALERT_ROUTES entry "${label}" tokenFile must be an absolute path ` +
      `(a path, not a token value) — got ${JSON.stringify(tokenFile)}`
    );
  }
  return { endpoint, tokenFile };
}

// ---------------------------------------------------------------------------
// parseAlertRoutes — PURE (§2.3, AR3). No logging, no I/O, no emission.
// Everything active about the degraded state is done by
// reportStartupAlertDefects, which the composition root calls (§2.3a).
//
// `env` is a PASSED object (not process.env) so this stays a pure function of
// its arguments — that is what lets defaultConfigured participate in the
// degraded decision without a new env read (§2.3 cause 2).
// ---------------------------------------------------------------------------
function parseAlertRoutes(env = {}, config = {}) {
  // One policy object per parse: the §2.3 table is consulted for every fatal
  // decision in this module, axis C and axis D alike.
  const policy = buildFailurePolicy(config);
  const raw = env.MISER_ALERT_ROUTES;
  if (typeof raw !== 'string' || !raw.trim()) return null; // null is the exclusive OFF signal

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    enforceAxisC(policy, 'malformed_entry', `[miser] fatal: MISER_ALERT_ROUTES is not parseable JSON: ${e.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    enforceAxisC(policy, 'malformed_entry', '[miser] fatal: MISER_ALERT_ROUTES must be a JSON object of project -> route.');
  }
  const projectKeys = Object.keys(parsed);
  if (projectKeys.length === 0) return null; // empty map == OFF, never {}

  const allowRemote = /^(1|true|on|yes)$/i.test(env.MISER_ALERT_ROUTES_ALLOW_REMOTE || '');
  const entries = Object.create(null);
  const mapped = [];
  const defaultDeclared = [];

  for (const key of projectKeys) {
    if (RESERVED_KEYS.has(key)) {
      enforceAxisC(policy, 'malformed_entry', `[miser] fatal: MISER_ALERT_ROUTES key "${key}" is a reserved prototype key.`);
    }
    if (!isValidProjectName(key)) {
      enforceAxisC(policy, 'malformed_entry',
        `[miser] fatal: MISER_ALERT_ROUTES key "${key}" is not a valid project name ` +
        `(must match /^[A-Za-z0-9._-]{1,80}$/ — note this excludes the reserved "@" namespace).`
      );
    }
    // '--' collision is delegated to validateStartupConfig via a new maps row
    // (config.js), matching the shared contract in §1.5. Not re-implemented here.
    const value = validateRouteValue(key, parsed[key], allowRemote, policy);
    entries[key] = value;
    if (value === SENTINEL_DEFAULT) defaultDeclared.push(key);
    else mapped.push(key);
  }

  const defaultConfigured = Boolean(env.MISER_PKACHU_ENDPOINT && env.MISER_PKACHU_TOKEN);

  // Required set (§2.3) = keys of budgets ∪ policy ∪ (on E) pollRewriteProjects.
  // These are exactly the projects whose alerts are configuration-driven and so
  // knowable at startup — and they are the same three keys that drive three of
  // the five ALERTING_FEATURES predicates, which is the ordering property AR30
  // asserts (degraded non-empty => a dispatcher is wired).
  const required = new Set();
  for (const src of [config.budgets, config.policy, config.pollRewriteProjects]) {
    if (src && typeof src === 'object') for (const k of Object.keys(src)) required.add(k);
  }

  // Degraded cause 1: a required project has no entry at all.
  const unroutedConfigured = [...required].filter(p => !(p in entries)).sort();
  // Degraded cause 2 (§2.3): a required project DECLARED the default channel
  // while no default route is configured. Without this, "@default" could
  // falsely satisfy completeness and every alert for that project would hit
  // ALERT-DROPPED at runtime with nothing said at startup.
  const undeliverableDefaultDeclared = defaultConfigured
    ? []
    : [...required].filter(p => entries[p] === SENTINEL_DEFAULT).sort();

  // Axis D is the ONE row of the strictness switch whose value varies, so it is
  // the one row with a call site: the table decides, this asks. Without this the
  // table was inert and MISER_ALERT_ROUTES_STRICT=1 changed nothing (AR26 asks
  // for behaviour, not for the table's return value).
  if (policy.incomplete_map === 'fatal'
      && (unroutedConfigured.length > 0 || undeliverableDefaultDeclared.length > 0)) {
    const causes = [];
    if (unroutedConfigured.length) causes.push(`unrouted=${unroutedConfigured.join(',')}`);
    if (undeliverableDefaultDeclared.length) {
      causes.push(`default-declared-but-unconfigured=${undeliverableDefaultDeclared.join(',')}`);
    }
    throw new Error(
      `[miser] fatal: MISER_ALERT_ROUTES is incomplete and MISER_ALERT_ROUTES_STRICT is on (${causes.join(' ')}). ` +
      `Unset MISER_ALERT_ROUTES_STRICT to downgrade this to the default degraded state.`
    );
  }

  return {
    entries,
    mapped: mapped.sort(),
    defaultDeclared: defaultDeclared.sort(),
    defaultConfigured,
    strict: Boolean(config.alertRoutesStrict),
    degraded: { unroutedConfigured, undeliverableDefaultDeclared },
  };
}

// Ops route (§2.5). Fatal whenever SET and malformed/unsafe — even when
// MISER_ALERT_ROUTES is OFF, because discovering a bad ops route at the moment
// the safety path is first needed is strictly worse. See the operator warning
// in §2.5: this is the one fatal that fires on a variable an operator may
// believe is inactive. Escape hatch is symmetrical with everything else: unset it.
function parseOpsRoute(env = {}, config = {}) {
  const policy = buildFailurePolicy(config);
  const raw = env.MISER_ALERT_ROUTES_OPS;
  if (typeof raw !== 'string' || !raw.trim()) return null; // unset -> fall back to default route
  const allowRemote = /^(1|true|on|yes)$/i.test(env.MISER_ALERT_ROUTES_ALLOW_REMOTE || '');
  if (raw.trim() === SENTINEL_DEFAULT || raw.trim() === `"${SENTINEL_DEFAULT}"`) {
    return SENTINEL_DEFAULT;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    enforceAxisC(policy, 'malformed_ops', `[miser] fatal: MISER_ALERT_ROUTES_OPS is not parseable JSON: ${e.message}`);
  }
  return validateRouteValue('MISER_ALERT_ROUTES_OPS', parsed, allowRemote, policy, 'malformed_ops');
}

// ---------------------------------------------------------------------------
// Destination-class contract (§2.4a) — three classes, one field.
//   scope 'project' : opts.project is a REAL project name -> its route
//   scope 'fleet'   : project omitted/null -> default route  (case A)
//   scope 'ops'     : NEVER inferred -> ops route, else default (case F)
// `opts.project` is a project name, never a route selector.
// ---------------------------------------------------------------------------
function resolveScope(opts = {}) {
  const explicit = opts.scope;
  const hasProject = typeof opts.project === 'string' && opts.project.length > 0;
  if (explicit === 'ops' || explicit === 'fleet' || explicit === 'project') {
    // Explicit scope always wins; a conflict is loud, never silent (rule 3).
    if ((explicit === 'ops' || explicit === 'fleet') && hasProject) {
      console.warn(`[miser/alert] ALERT-SCOPE-CONFLICT scope=${explicit} project=${opts.project}`);
    }
    return explicit;
  }
  return hasProject ? 'project' : 'fleet';
}

function utcDay(nowFn) {
  return (nowFn ? nowFn() : new Date()).toISOString().slice(0, 10);
}

// resolveRoute — §2.4 cases A-F. Pure with respect to routing; the bounded
// unroutable bookkeeping (cases E) mutates module state deliberately and is
// applied BEFORE any ledger key is minted, which is what bounds the ledger
// file's cardinality too (AR23).
function resolveRoute(project, opts = {}) {
  const scope = resolveScope({ ...opts, project });
  const routes = opts.alertRoutes;                       // parsed map or null
  const defaultRoute = opts.defaultRoute !== undefined
    ? opts.defaultRoute
    : defaultRouteFromEnv();
  const opsRoute = opts.opsRoute;

  // Case F — ops scope. Never withheld: withholding a defect report about
  // routing would be a silent loss of the thing that reports silent losses.
  if (scope === 'ops') {
    const target = (opsRoute && opsRoute !== SENTINEL_DEFAULT) ? opsRoute : defaultRoute;
    return { kind: target ? 'route' : 'none', route: target, scope, label: OPS_LABEL };
  }

  // Case D — routes OFF: today's behaviour exactly, unprefixed.
  if (!routes || !routes.entries) {
    return { kind: defaultRoute ? 'route' : 'none', route: defaultRoute, scope, label: scope === 'fleet' ? 'fleet' : project };
  }

  // Case A — fleet scope.
  if (scope === 'fleet') {
    return { kind: defaultRoute ? 'route' : 'none', route: defaultRoute, scope, label: 'fleet' };
  }

  // Cases B / C / E — project scope with routes ON.
  const entry = Object.prototype.hasOwnProperty.call(routes.entries, project)
    ? routes.entries[project]
    : undefined;

  if (entry && entry !== SENTINEL_DEFAULT) {
    return { kind: 'route', route: entry, scope, label: project };          // case B
  }
  if (entry === SENTINEL_DEFAULT) {
    // Case C — declared intent, not a fallback. Unprefixed.
    return { kind: defaultRoute ? 'route' : 'none', route: defaultRoute, scope, label: project };
  }

  // ---- Case E: unmapped or invalid. WITHHELD — never a misroute. ----------
  // (1) Validation + canonicalisation at the alert boundary. Every malformed
  //     project name in existence collapses to ONE bucket, so it can mint at
  //     most one ledger key and one ops alert per UTC day.
  if (!isValidProjectName(project)) {
    _invalidProjectAlerts += 1;
    if (_invalidSamples.length < 3) {
      const sample = String(project).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 32);
      _invalidSamples.push(sample);
    }
    return { kind: 'withheld', bucket: BUCKET_INVALID, scope, label: BUCKET_INVALID };
  }

  // (2) A bounded unknown-projects bucket for valid-but-unmapped names.
  const day = utcDay(opts.nowFn);
  if (_unroutedRuntimeDay !== day) {
    _unroutedRuntimeDay = day;
    _unroutedRuntime = new Set();
    _unroutedOverflowCount = 0;
  }
  const cap = Number.isFinite(opts.unroutedMax) ? opts.unroutedMax : 32;
  if (_unroutedRuntime.has(project)) {
    return { kind: 'withheld', bucket: project, scope, label: project };
  }
  if (_unroutedRuntime.size < cap) {
    _unroutedRuntime.add(project);
    return { kind: 'withheld', bucket: project, scope, label: project };
  }
  // Cap hit: NOT added, NO ledger key minted for it, counted as overflow.
  _unroutedOverflowCount += 1;
  return { kind: 'withheld', bucket: BUCKET_OVERFLOW, scope, label: project, overflow: true };
}

// ---------------------------------------------------------------------------
// createAlertDispatcher — the single outbound path.
//
// PROMISE CONTRACT (§2.9a), normative: the returned promise ALWAYS RESOLVES.
// Never rejects — not for delivery failure, not for a missing route, not for a
// bad token file. Every outcome is a RESOLVED AlertResult. This preserves the
// existing convention at daily-rollup.js:167-172 verbatim, and it is what keeps
// "one event -> at most one log line -> exactly one counter bump" true.
//
// AlertResult (exactly one of):
//   { ok: true,  outcome: 'delivered', kind, scope, endpoint }
//   { ok: false, outcome: 'failed',    kind, scope, endpoint, error }
//   { ok: false, outcome: 'withheld',  kind, scope, project }
//   { ok: false, outcome: 'dropped',   kind, scope, reason }
//
// Before resolving, the dispatcher has ALREADY performed the §2.7 side effects
// for that outcome:
//   - EVERY outcome: exactly one counter bump.
//   - Every NON-DELIVERED outcome: exactly one log line.
//   - 'delivered': COUNTER ONLY, NO LOG LINE. Success is silent, matching
//     daily-rollup.js:177-179 which logs nothing on success.
// Callers read the result; they never log or count a dispatcher-level outcome.
// The ONE thing a caller owns is the case this function cannot reach:
// guardDeps.sendAlert absent -> DROPPED reason=no_dispatcher, logged+counted by
// the pre-dispatcher guard (§2.7 ownership table, §3.3).
// ---------------------------------------------------------------------------
function createAlertDispatcher(config = {}, seams = {}) {
  const post = seams.post || postPkachu;
  const readToken = seams.readToken || require('./daily-rollup.js').readToken;
  const alertRoutes = config.alertRoutes;
  const opsRoute = config.alertRoutesOps;
  const unroutedMax = config.alertRoutesUnroutedMax;
  const escalate = config.alertRoutesUnrouted === 'escalate';

  async function sendAlert(text, opts = {}) {
    const kind = opts.kind || 'unknown';
    let resolved;
    try {
      resolved = resolveRoute(opts.project, {
        scope: opts.scope,
        project: opts.project,
        alertRoutes,
        opsRoute,
        unroutedMax,
        defaultRoute: seams.defaultRoute,
        nowFn: seams.nowFn,
      });
    } catch (e) {
      // Route resolution must never throw out of the emission path.
      console.warn(`[miser/alert] ALERT-DROPPED project=${opts.project || 'fleet'} kind=${kind} reason=resolve_error`);
      _counters.dropped += 1;
      return { ok: false, outcome: 'dropped', kind, scope: 'unknown', reason: 'resolve_error', error: e };
    }
    const { scope, label } = resolved;

    if (resolved.kind === 'withheld') {
      console.warn(`[miser/alert] ALERT-WITHHELD project=${label} kind=${kind}`);
      _counters.withheld += 1;
      if (resolved.overflow) _counters.withheldOverflow += 1;
      // The withheld alert's own subject is not delivered anywhere. Instead a
      // DIFFERENT message, about a DIFFERENT subject, goes to the party who
      // owns that subject (§2.4). Bounded: at most cap+2 ops posts per UTC day
      // because the cap gate above precedes ledger-key creation.
      _maybeOpsDefect(resolved, kind, text);
      return { ok: false, outcome: 'withheld', kind, scope, project: label };
    }

    if (resolved.kind === 'none' || !resolved.route) {
      console.warn(`[miser/alert] ALERT-DROPPED project=${label} kind=${kind} reason=no_destination`);
      _counters.dropped += 1;
      return { ok: false, outcome: 'dropped', kind, scope, reason: 'no_destination' };
    }

    const { endpoint, tokenFile } = resolved.route;
    try {
      const token = await readToken(tokenFile);
      await post(endpoint, token, text);
      _counters.delivered += 1;                       // counter only — no log line
      return { ok: true, outcome: 'delivered', kind, scope, endpoint };
    } catch (err) {
      // The dispatcher's ONE failure line, carrying kind= so a failed send is
      // attributable without a second, per-call-site line (§2.7).
      console.warn(`[miser/alert] WARN alert send failed: kind=${kind} ${err.message}`);
      _counters.failed += 1;
      return { ok: false, outcome: 'failed', kind, scope, endpoint, error: err };
    }
  }

  // Ops-route defect report for the case-E withhold path. Ledger-deduped once
  // per bucket per UTC day; mark BEFORE send, matching every existing call site
  // (budgets.js:171-172 states the rule normatively).
  function _maybeOpsDefect(resolved, kind, withheldText) {
    const ledger = seams.ledger;
    const key = `alertroute:unmapped:${resolved.bucket}`;
    if (ledger) {
      if (!ledger.shouldSend(key)) return;
      ledger.markSent(key);
    }
    let body;
    if (resolved.bucket === BUCKET_OVERFLOW) {
      const cap = Number.isFinite(unroutedMax) ? unroutedMax : 32;
      body = `🚨 miser alert-routing: unroutable-project cardinality cap hit (${cap}) — `
        + `${_unroutedOverflowCount} further distinct projects withheld today; check x-termdeck-project senders`;
    } else if (resolved.bucket === BUCKET_INVALID) {
      body = `🚨 miser alert-routing DEFECT: ${_invalidProjectAlerts} alert(s) withheld today for `
        + `INVALID project names (samples: ${_invalidSamples.join(', ') || 'none'}). `
        + `Alerts for these are WITHHELD; check the x-termdeck-project sender.`;
    } else {
      body = `🚨 miser alert-routing DEFECT: no route for project=${resolved.label} — `
        + `1 alert withheld today (kind=${kind}). Alerts for this project are `
        + `WITHHELD until MISER_ALERT_ROUTES is fixed.`;
      if (escalate) body += `\n--- withheld alert text ---\n${withheldText}`;
    }
    // Fire-and-forget on the ops class; never awaited from the withhold path.
    void sendAlert(body, { scope: 'ops', kind: `alertroute-unmapped` });
  }

  return sendAlert;
}

// ---------------------------------------------------------------------------
// Composition root (§3.2).
// ---------------------------------------------------------------------------

// Single source of truth for "which config keys imply this process can alert".
const ALERTING_FEATURES = [
  { module: 'budgets.js',         enabled: c => c.budgets != null },
  { module: 'policy-watchdog.js', enabled: c => c.policy != null },
  { module: 'router.js',          enabled: c => (c.codex5hCap || 0) > 0 },
  { module: 'cache-thrash.js',    enabled: c => (c.cacheThrashMinRequests || 0) > 0 },
  { module: 'poll-rewrite.js',    enabled: c => !!c.pollRewriteProjects
                                             && Object.keys(c.pollRewriteProjects).length > 0 },
];

// ALLOWLIST of modules PERMITTED to name `sendAlert` without being a registered
// alerting feature (AR11). alert-routes.js DEFINES the dispatcher;
// daily-rollup.js stays on the list because it owns the transport (postPkachu)
// and the one MISER_PKACHU_* read, and its comments reference the dispatcher it
// used to hold. This is a permission list, not a claim that both files define
// one — there is exactly one definition site (§2.9a). Length is asserted (AR11).
const DISPATCHER_OWNERS = ['alert-routes.js', 'daily-rollup.js'];

// Per-cause startup defect reports (§2.3). One row per degraded cause: own log
// line, own ledger key, so the two dedupe independently while the "<=2 alerts
// per UTC day" bound stays provable from this table's length (AR31).
const STARTUP_DEFECTS = [
  {
    field: 'unroutedConfigured',
    key: 'alertroute:incomplete',
    kind: 'alertroute-incomplete',
    line: n => `unrouted=${n.join(',')} — alerts for these projects are WITHHELD`
      + ` until MISER_ALERT_ROUTES covers them`,
    text: n => `🚨 miser alert-routing DEFECT at startup: ${n.length} configured project(s)`
      + ` have no MISER_ALERT_ROUTES entry (${n.join(', ')}). Their alerts are WITHHELD`
      + ` until the map covers them. Proxy is serving normally.`,
  },
  {
    field: 'undeliverableDefaultDeclared',
    key: 'alertroute:default-missing',
    kind: 'alertroute-default-missing',
    line: n => `default-declared-but-unconfigured=${n.join(',')} — these projects declared`
      + ` "${SENTINEL_DEFAULT}" but MISER_PKACHU_ENDPOINT/_TOKEN are unset; their alerts will be DROPPED`,
    text: n => `🚨 miser alert-routing DEFECT at startup: ${n.length} configured project(s)`
      + ` declared "${SENTINEL_DEFAULT}" (${n.join(', ')}) but no default route is configured`
      + ` (MISER_PKACHU_ENDPOINT/_TOKEN unset). Their alerts will be DROPPED, not delivered.`,
  },
];

// Impure by design and by name. Called EXACTLY ONCE per process, by
// wireAlertDispatcher — which RETURNS this value so AR28 can observe it from
// the real composition root. parseAlertRoutes stays pure.
//
// Returns SYNCHRONOUSLY. `dispatched`/`emitted` mean AN ATTEMPT WAS HANDED TO
// THE DISPATCHER, not that it arrived; `settled` exposes the in-flight sends so
// a test can await confirmation. Delivery lands in the §2.7 counters.
function reportStartupAlertDefects(config = {}, guardDeps = {}) {
  const degraded = (config.alertRoutes && config.alertRoutes.degraded) || {};
  const causes = STARTUP_DEFECTS
    .map(d => ({ d, names: degraded[d.field] || [] }))
    .filter(({ names }) => names.length > 0);
  if (causes.length === 0) {
    return { dispatched: false, emitted: false, reason: 'no_defect', settled: Promise.resolve([]) };
  }

  const reasons = [];
  const inflight = [];
  for (const { d, names } of causes) {
    // Step 2 of §2.3 — always, before any emission decision, never ledger-gated.
    console.warn(`[miser/alert] ALERT-ROUTING-DEGRADED ${d.line(names)}`);

    if (!guardDeps.sendAlert) {                      // §3.3 loud fail-closed
      console.warn(`[miser/alert] ALERT-DROPPED project=${OPS_LABEL} kind=${d.kind} reason=no_dispatcher`);
      bumpDropped();
      reasons.push('no_dispatcher');
      continue;
    }
    if (guardDeps.ledger && !guardDeps.ledger.shouldSend(d.key)) {
      reasons.push('deduped');
      continue;
    }
    // MARK BEFORE SEND — normative, and the codebase's existing convention:
    // budgets.js:171-172 ("mark BEFORE send (normative): failed send is not
    // retried that day"), :184-185, policy-watchdog.js:106-107, :149-150,
    // cache-thrash.js:71-72, router.js:101-102 all do exactly this.
    // shouldSend() is READ-ONLY (alert-ledger.js:91-93) — it mints nothing — so
    // without this line the key is never recorded and the once-per-UTC-day
    // dedup does not exist.
    if (guardDeps.ledger) guardDeps.ledger.markSent(d.key);

    // Fire-and-forget: a startup emission must never delay or throw into
    // index.js's synchronous boot path. NO .catch and NO logging here —
    // sendAlert always resolves to an AlertResult and owns its own WARN +
    // counter (§2.9a). A .catch would be dead code; a second warn would
    // double-log one event.
    inflight.push(guardDeps.sendAlert(d.text(names), { scope: 'ops', kind: d.kind }));
    reasons.push('dispatched');
  }
  return {
    dispatched: reasons.includes('dispatched'),
    emitted: reasons.includes('dispatched'),   // ALIAS of dispatched — see §2.9a contract
    reason: reasons.join('+'),
    // Resolves to the dispatcher's AlertResult objects. NEVER rejects, because
    // sendAlert never rejects — so void-ing this cannot produce an unhandled
    // rejection and a test may await it without a try/catch.
    settled: Promise.all(inflight),
  };
}

// Feature-agnostic composition root. Mutates the guardDeps object it is handed
// (the convention wireCacheThrashDeps already uses, cache-thrash.js:101-111) and
// RETURNS the §2.3a startup report.
//
// Called once per process, immediately after guardDeps is constructed and
// before the remaining feature wiring — index.js:59-62:
//   const guardDeps = buildGuardDeps(config);
//   wireAlertDispatcher(config, guardDeps);
//   wireCacheThrashDeps(config, guardDeps);
// buildGuardDeps' signature is UNCHANGED.
function wireAlertDispatcher(config = {}, guardDeps = {}, seams = {}) {
  const anyEnabled = ALERTING_FEATURES.some(f => {
    try { return Boolean(f.enabled(config)); } catch (_) { return false; }
  });

  if (anyEnabled) {
    // Ledger only if ABSENT. Load-bearing, not defensive: buildGuardDeps
    // already creates a ledger for budgets/policy/subcap configs, and a second
    // instance over the same file would give two dedup Maps and two writers
    // (alert-ledger.js:79-87), failing toward DUPLICATE alerts. Same idiom as
    // cache-thrash.js:104-108. AR9 asserts createLedger runs at most once.
    if (!guardDeps.ledger) {
      const mkLedger = seams.createLedger || require('./alert-ledger.js').createLedger;
      guardDeps.ledger = mkLedger();
    }
    if (!guardDeps.nowFn) guardDeps.nowFn = seams.nowFn || (() => new Date());
    // THE TRANSPORT SEAM IS THREADED, not merely declared: seams.post replaces
    // only the socket, leaving real routing/logging/counting in place, which is
    // what lets AR28/AR29/AR32 exercise the PRODUCTION dispatcher. seams.sendAlert
    // replaces the dispatcher wholesale (Layer-1 hermeticity, AR13).
    guardDeps.sendAlert = seams.sendAlert
      || createAlertDispatcher(config, {
        post: seams.post,
        readToken: seams.readToken,
        defaultRoute: seams.defaultRoute,
        ledger: guardDeps.ledger,
        nowFn: guardDeps.nowFn,
      });
  }
  // If NO feature is enabled: leave guardDeps untouched — preserving the
  // zero-I/O all-off property budgets.js:206 and alert-ledger.js:11-16 are
  // explicit about.

  // Final statement, unconditionally. The ONLY call site of the startup
  // ops-defect emission in the codebase. Returned, not discarded, so AR28 is
  // observable from the real composition root.
  return reportStartupAlertDefects(config, guardDeps);
}

// Health surface input (§2.8). Derived from the parser's return value plus the
// bounded runtime state — no emission, no I/O.
function alertRoutingHealth(config = {}) {
  const r = config.alertRoutes;
  const rt = getRuntimeRoutingState();
  const degraded = (r && r.degraded) || { unroutedConfigured: [], undeliverableDefaultDeclared: [] };
  const isDegraded = Boolean(r)
    && (degraded.unroutedConfigured.length > 0 || degraded.undeliverableDefaultDeclared.length > 0);
  return {
    status: isDegraded ? 'degraded' : 'ok',
    mapped: r ? r.mapped : [],
    defaultDeclared: r ? r.defaultDeclared : [],
    defaultConfigured: r ? r.defaultConfigured : Boolean(defaultRouteFromEnv()),
    opsConfigured: Boolean(config.alertRoutesOps),
    strict: Boolean(config.alertRoutesStrict),
    unroutedConfigured: degraded.unroutedConfigured,
    undeliverableDefaultDeclared: degraded.undeliverableDefaultDeclared,
    unroutedRuntime: rt.unroutedRuntime,
    unroutedRuntimeOverflow: rt.unroutedRuntimeOverflow,
    invalidProjectAlerts: rt.invalidProjectAlerts,
    counters: getAlertCounters(),
  };
}

module.exports = {
  parseAlertRoutes,
  parseOpsRoute,
  buildFailurePolicy,
  resolveRoute,
  resolveScope,
  createAlertDispatcher,
  wireAlertDispatcher,
  reportStartupAlertDefects,
  alertRoutingHealth,
  getAlertCounters,
  getRuntimeRoutingState,
  bumpDropped,
  validateRouteValue,
  ALERTING_FEATURES,
  DISPATCHER_OWNERS,
  STARTUP_DEFECTS,
  SENTINEL_DEFAULT,
  __resetAlertState,
};
