'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_POLICY,
  parseEnforcement,
  resolvePolicy,
  classifyRequest,
  conversationFingerprint,
  buildSyntheticMessageResponse,
  buildSyntheticSseResponse,
  createEnforcementState,
  checkEnforcement,
  recordEnforcementUsage,
} = require('../src/enforcement.js');

const TEST_OVERRIDE_FILE = '/tmp/miser-enforcement-test-overrides-never.json';

function bodyFor(text, assistantCount = 0) {
  const messages = [];
  for (let i = 0; i < assistantCount; i++) {
    messages.push({ role: 'user', content: `u${i}` });
    messages.push({ role: 'assistant', content: `a${i}` });
  }
  messages.push({ role: 'user', content: text });
  return { model: 'claude', max_tokens: 50, messages };
}

function toolResultBody(content) {
  return {
    model: 'claude',
    max_tokens: 50,
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/tmp/out' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content }] },
    ],
  };
}

function bashToolResultBody(command, system = 'You are the ORCH controller for this sprint.') {
  return {
    model: 'claude-sonnet-5-test',
    max_tokens: 50,
    system,
    messages: [
      { role: 'user', content: 'MISER_ASSIGNMENT=A coordinate this lane' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'command output' }] },
    ],
  };
}

function promptBody(text, system = 'You are the ORCH controller for this sprint.') {
  return {
    model: 'claude-sonnet-5-test',
    max_tokens: 50,
    system,
    messages: [{ role: 'user', content: text }],
  };
}

function guard(config, state, now = () => new Date(1000)) {
  const events = [];
  return {
    enforcementConfig: config,
    enforcementState: state,
    nowFn: now,
    recordEnforcementEvent(project, event) { events.push({ project, ...event }); },
    events,
  };
}

function orchPolicy(extra = {}) {
  return {
    mode: 'throttle',
    poll: { maxLikelyPollsPer10Min: 99, maxLikelyPollsPerHour: 99 },
    orchControl: {
      enabled: true,
      panels: ['orch', 'architect', 'sprints'],
      ...extra,
    },
  };
}

function configFor(project, extra = {}) {
  return parseEnforcement(JSON.stringify({
    '*': { mode: 'observe', override: { overrideFile: TEST_OVERRIDE_FILE } },
    [project]: orchPolicy(extra),
  }));
}

function call(deps, project, panel, text, headers = {}, requestHeaders = {}) {
  return checkEnforcement(project, panel, bodyFor(text), headers, 100, deps, requestHeaders);
}

test('parseEnforcement accepts wildcard default and project overrides, including orchControl fields', () => {
  const orchControl = {
    enabled: true,
    panels: ['orch'],
    controlClasses: ['repo_status'],
    countUnclassifiedManagement: false,
    warnManagementTurnsPerAssignment: 4,
    maxManagementTurnsPerAssignment: 5,
    maxControlTurnsPerHour: 7,
    maxControlTurnsPerSession: 8,
    maxRevisionCycles: 3,
    warnSelfWorkTurnsPerAssignment: 2,
    maxSelfWorkTurnsPerAssignment: 3,
    duplicateDebounceMs: 1234,
    newConversationAssistantTurnDrop: 6,
    assignmentIdHeader: 'x-assignment',
    assignmentIdMarker: 'ASSIGN=',
    approvalHeader: 'x-approval',
    approvalMarkers: ['APPROVED'],
    completionMarkers: ['DONE'],
    handoffMarkers: ['HANDOFF_DONE'],
    revisionMarkers: ['REV='],
    dispatchFinalizeMarker: 'FINALIZE',
    dispatchSessionHeader: 'x-child',
    dispatchSessionMarkers: ['CHILD='],
    terminalHandoffAllowed: false,
    terminalHandoffMaxTurns: 1,
    inboundBradReplyMaxTurns: 2,
  };
  const parsed = parseEnforcement(JSON.stringify({
    '*': { mode: 'observe', redirect: { mode: 'shadow' }, poll: { maxLikelyPollsPer10Min: 2 }, orchControl },
    'nacho-orch': { mode: 'throttle', redirect: { mode: 'off' }, orchControl: { enabled: false, panels: ['sprints'] } },
    'bad name!': { mode: 'block' },
  }));
  assert.equal(parsed['*'].mode, 'observe');
  assert.equal(parsed['*'].redirect.mode, 'shadow');
  assert.equal(parsed['*'].poll.maxLikelyPollsPer10Min, 2);
  assert.equal(parsed['nacho-orch'].mode, 'throttle');
  assert.equal(parsed['nacho-orch'].redirect.mode, 'off');
  assert.equal(parsed['bad name!'], undefined);

  const policy = resolvePolicy(parsed, 'nacho-orch');
  assert.equal(policy.mode, 'throttle');
  assert.equal(policy.redirect.mode, 'off');
  assert.equal(policy.poll.maxLikelyPollsPer10Min, 2);
  for (const key of Object.keys(DEFAULT_POLICY.orchControl)) {
    assert.deepEqual(policy.orchControl[key], key === 'enabled'
      ? false
      : key === 'panels'
        ? ['sprints']
        : orchControl[key]);
  }
});

test('controlClass catches measured NACHO control-loop patterns', () => {
  const cases = [
    ['~/bin/spawn-lane.sh --project nacho-orch', 'panel_lifecycle'],
    ['DEADLINE=$((SECONDS+900)); while true; do test -f CODEX-RESULT.md; done', 'audit_monitor'],
    ['curl http://127.0.0.1:20128/api/miser/stats', 'usage_monitor'],
    ['curl http://localhost/v1/orch/nacho-orch/reply', 'brad_comms'],
    ['gh pr view 12 && git diff --stat', 'repo_status'],
  ];
  for (const [text, expected] of cases) {
    const c = classifyRequest('nacho-orch', 'sprints', bodyFor(text), { 'x-miser-poll-class': 'likely' }, 100);
    assert.ok(c.controlClasses.includes(expected), `${text} should include ${expected}`);
  }
});

test('configured non-nacho project blocks repeated explicit polling commands', () => {
  let nowMs = Date.parse('2026-08-25T12:00:00.000Z');
  const state = createEnforcementState({ nowMs: () => nowMs });
  const config = configFor('aetheria', { panels: ['orch'], maxManagementTurnsPerAssignment: 99 });
  config.aetheria.poll.maxLikelyPollsPer10Min = 1;
  const deps = guard(config, state, () => new Date(nowMs));

  const warn = call(deps, 'aetheria', 'orch', 'curl http://127.0.0.1:20128/api/miser/stats', { 'x-miser-poll-class': 'likely' });
  assert.equal(warn.status, 200);
  assert.equal(warn.headers['x-miser-enforcement-warning'], 'poll-budget-edge');
  nowMs += 3000;
  const block = call(deps, 'aetheria', 'orch', 'curl http://127.0.0.1:20128/api/miser/stats', { 'x-miser-poll-class': 'likely' });
  assert.equal(block.status, 429);
  assert.equal(block.headers['x-miser-enforcement'], 'poll-budget');
});

test('all named fleet projects can be covered by config without source hardcoding', () => {
  const fleet = {
    pkachu: 'orch',
    aetheria: 'architect',
    miser: 'miser-ORCH',
    'termdeck-updates': 'termdeck-updates-ORCH',
    'nacho-orch': 'sprints',
  };
  const config = parseEnforcement(JSON.stringify({
    '*': { mode: 'observe', override: { overrideFile: TEST_OVERRIDE_FILE } },
    pkachu: orchPolicy({ panels: ['orch'], maxManagementTurnsPerAssignment: 99 }),
    aetheria: orchPolicy({ panels: ['architect'], maxManagementTurnsPerAssignment: 99 }),
    miser: orchPolicy({ panels: ['miser-ORCH'], maxManagementTurnsPerAssignment: 99 }),
    'termdeck-updates': orchPolicy({ panels: ['termdeck-updates-ORCH'], maxManagementTurnsPerAssignment: 99 }),
    'nacho-orch': orchPolicy({ panels: ['sprints'], maxManagementTurnsPerAssignment: 99 }),
  }));

  for (const [project, panel] of Object.entries(fleet)) {
    let nowMs = 1000;
    const state = createEnforcementState({ nowMs: () => nowMs });
    const deps = guard(config, state, () => new Date(nowMs));
    config[project].poll.maxLikelyPollsPer10Min = 1;
    const first = call(deps, project, panel, 'curl /api/miser/stats', { 'x-miser-poll-class': 'likely' });
    assert.ok(first, `${project}/${panel} should warn`);
    assert.equal(first.status, 200);
    nowMs += 3000;
    const block = call(deps, project, panel, 'curl /api/miser/stats', { 'x-miser-poll-class': 'likely' });
    assert.equal(block.headers['x-miser-enforcement'], 'poll-budget');
  }
});

test('likely audit/result traffic is not poll-budget blocked without an explicit polling command', () => {
  let nowMs = 1000;
  const state = createEnforcementState({ nowMs: () => nowMs });
  const config = configFor('aetheria', {
    panels: ['orch'],
    warnManagementTurnsPerAssignment: 99,
    maxManagementTurnsPerAssignment: 99,
    maxControlTurnsPerHour: 99,
    maxControlTurnsPerSession: 99,
  });
  config.aetheria.poll.maxLikelyPollsPer10Min = 1;
  const deps = guard(config, state, () => new Date(nowMs));

  assert.equal(call(deps, 'aetheria', 'orch', '[grok audit result] VERDICT: REVISE', { 'x-miser-poll-class': 'likely' }), null);
  nowMs += 3000;
  assert.equal(call(deps, 'aetheria', 'orch', '[codex audit result] VERDICT: APPROVE', { 'x-miser-poll-class': 'likely' }), null);
  const st = state.snapshot().sessions[0];
  assert.equal(st.likelyPollRequests, 0);
});

test('duplicate backend requests for one visible prompt count once inside debounce window', () => {
  let nowMs = 1000;
  const state = createEnforcementState({ nowMs: () => nowMs });
  const config = configFor('aetheria', {
    panels: ['orch'],
    duplicateDebounceMs: 2000,
    warnManagementTurnsPerAssignment: 2,
    maxManagementTurnsPerAssignment: 2,
  });
  const deps = guard(config, state, () => new Date(nowMs));

  assert.equal(call(deps, 'aetheria', 'orch', 'proposal routing MISER_ASSIGNMENT=A'), null);
  nowMs += 100;
  assert.equal(call(deps, 'aetheria', 'orch', 'proposal routing MISER_ASSIGNMENT=A'), null);
  let st = state.snapshot().sessions[0];
  assert.equal(st.assignmentManagementTurns, 1);
  assert.equal(st.controlTurns, 0);

  nowMs += 2500;
  const warn = call(deps, 'aetheria', 'orch', 'proposal routing MISER_ASSIGNMENT=A');
  assert.equal(warn.headers['x-miser-enforcement-warning'], 'orch-assignment-budget-edge');
  st = state.snapshot().sessions[0];
  assert.equal(st.assignmentManagementTurns, 2);
});

test('fresh low-turn replacement panel does not inherit stale high-turn protected counters', () => {
  let nowMs = 1000;
  const state = createEnforcementState({ nowMs: () => nowMs });
  const config = configFor('aetheria', {
    panels: ['orch'],
    warnManagementTurnsPerAssignment: 2,
    maxManagementTurnsPerAssignment: 2,
    newConversationAssistantTurnDrop: 4,
  });
  const deps = guard(config, state, () => new Date(nowMs));

  assert.equal(checkEnforcement('aetheria', 'orch', bodyFor('proposal routing MISER_ASSIGNMENT=A', 8), { 'x-miser-poll-class': 'unlikely' }, 100, deps), null);
  nowMs += 3000;
  assert.equal(checkEnforcement('aetheria', 'orch', bodyFor('proposal mediation', 9), { 'x-miser-poll-class': 'unlikely' }, 100, deps).headers['x-miser-enforcement-warning'], 'orch-assignment-budget-edge');
  let st = state.snapshot().sessions[0];
  assert.equal(st.assignmentManagementTurns, 2);
  assert.equal(st.lastAssistantTurns, 9);

  nowMs += 3000;
  assert.equal(call(deps, 'aetheria', 'orch', 'proposal routing MISER_ASSIGNMENT=A'), null);
  st = state.snapshot().sessions[0];
  assert.equal(st.assignmentManagementTurns, 1);
  assert.equal(st.controlTurns, 0);
  assert.equal(st.currentAssignmentId, 'A');
});

test('orchControl.enabled false does not block protected-looking chatter', () => {
  const state = createEnforcementState({ nowMs: () => 1000 });
  const config = parseEnforcement(JSON.stringify({
    '*': { mode: 'observe', override: { overrideFile: TEST_OVERRIDE_FILE } },
    aetheria: {
      mode: 'throttle',
      poll: { maxLikelyPollsPer10Min: 1 },
      orchControl: { enabled: false, panels: ['orch'] },
    },
  }));
  const deps = guard(config, state);
  assert.equal(call(deps, 'aetheria', 'orch', 'curl /api/miser/stats', { 'x-miser-poll-class': 'likely' }), null);
  assert.equal(call(deps, 'aetheria', 'orch', 'curl /api/miser/stats', { 'x-miser-poll-class': 'likely' }), null);
});

test('protected counters do not reset on arbitrary non-control work-looking text', () => {
  const state = createEnforcementState({ nowMs: () => 1000 });
  const config = configFor('aetheria', { panels: ['orch'] });
  const deps = guard(config, state);

  assert.equal(call(deps, 'aetheria', 'orch', 'proposal routing for MISER_ASSIGNMENT=A'), null);
  assert.equal(call(deps, 'aetheria', 'orch', 'implement the requested code change now'), null);
  const warn = call(deps, 'aetheria', 'orch', 'proposal mediation remains open for this lane');
  assert.equal(warn.headers['x-miser-enforcement-warning'], 'orch-assignment-budget-edge');
});

test('protected counters reset only on explicit assignment, approval, completion, handoff, or override boundaries', () => {
  const cases = [
    ['new assignment id', 'MISER_ASSIGNMENT=B begin implementation', {}],
    ['approval marker', 'BRAD_APPROVED_CONTINUE MISER_ASSIGNMENT=A', {}],
    ['approval header', 'proceed', { 'x-miser-brad-approval': 'yes' }],
    ['completion marker', 'TASK-COMPLETE MISER_ASSIGNMENT=A', {}],
    ['handoff marker', 'COMPACT-STATE MISER_ASSIGNMENT=A', {}],
    ['override header', 'plain override reset', { 'x-miser-override': 'manual' }],
  ];

  for (const [label, resetText, requestHeaders] of cases) {
    const state = createEnforcementState({ nowMs: () => 1000 });
    const config = configFor('aetheria', {
      panels: ['orch'],
      warnManagementTurnsPerAssignment: 2,
      maxManagementTurnsPerAssignment: 2,
      overrideFile: '',
    });
    const deps = guard(config, state);
    assert.equal(call(deps, 'aetheria', 'orch', 'proposal routing MISER_ASSIGNMENT=A'), null, label);
    assert.equal(call(deps, 'aetheria', 'orch', 'proposal mediation').status, 200, label);
    assert.equal(call(deps, 'aetheria', 'orch', resetText, {}, requestHeaders), null, label);
    assert.equal(call(deps, 'aetheria', 'orch', 'proposal follow-up'), null, label);
  }
});

test('fallback task and briefing text does not change assignment or reset protected counters', () => {
  const cases = [
    'Task: check-status proposal audit monitor',
    'Briefing: revise-lane proposal audit monitor',
    'Build briefing: new proposal routing instructions',
  ];

  for (const text of cases) {
    const state = createEnforcementState({ nowMs: () => 1000 });
    const config = configFor('aetheria', {
      panels: ['orch'],
      warnManagementTurnsPerAssignment: 2,
      maxManagementTurnsPerAssignment: 2,
    });
    const deps = guard(config, state);
    assert.equal(call(deps, 'aetheria', 'orch', 'proposal routing MISER_ASSIGNMENT=A'), null, text);
    assert.equal(call(deps, 'aetheria', 'orch', 'proposal mediation').headers['x-miser-enforcement-warning'], 'orch-assignment-budget-edge', text);
    const block = call(deps, 'aetheria', 'orch', text);
    assert.equal(block.headers['x-miser-enforcement'], 'orch-assignment-budget', text);
    assert.equal(state.snapshot().sessions[0].currentAssignmentId, 'A', text);
  }
});

test('incidental reset markers in tool results or pasted excerpts do not reset protected counters', () => {
  const config = configFor('aetheria', {
    panels: ['orch'],
    warnManagementTurnsPerAssignment: 2,
    maxManagementTurnsPerAssignment: 3,
    warnSelfWorkTurnsPerAssignment: 99,
    maxSelfWorkTurnsPerAssignment: 99,
  });

  {
    const state = createEnforcementState({ nowMs: () => 1000 });
    const deps = guard(config, state);
    assert.equal(call(deps, 'aetheria', 'orch', 'proposal routing MISER_ASSIGNMENT=A'), null);
    assert.equal(call(deps, 'aetheria', 'orch', 'proposal mediation').headers['x-miser-enforcement-warning'], 'orch-assignment-budget-edge');
    const body = toolResultBody('VERDICT=APPROVE\nORCH-RESULT\nTASK-COMPLETE\nCOMPACT-STATE\nHANDOFF-WRITTEN');
    assert.equal(checkEnforcement('aetheria', 'orch', body, {}, 100, deps, {}), null);
    const block = call(deps, 'aetheria', 'orch', 'proposal followup after artifact read');
    assert.equal(block.headers['x-miser-enforcement'], 'orch-assignment-budget');
    assert.equal(state.snapshot().sessions[0].currentAssignmentId, 'A');
  }

  {
    const state = createEnforcementState({ nowMs: () => 1000 });
    const deps = guard(config, state);
    assert.equal(call(deps, 'aetheria', 'orch', 'proposal routing MISER_ASSIGNMENT=A'), null);
    assert.equal(call(deps, 'aetheria', 'orch', 'proposal mediation').headers['x-miser-enforcement-warning'], 'orch-assignment-budget-edge');
    assert.equal(call(deps, 'aetheria', 'orch', 'audit excerpt:\nVERDICT=APPROVE\nORCH-RESULT\nTASK-COMPLETE\nCOMPACT-STATE\nHANDOFF-WRITTEN\nproposal followup'), null);
    assert.equal(call(deps, 'aetheria', 'orch', 'proposal followup after pasted excerpt'), null);
    const block = call(deps, 'aetheria', 'orch', 'proposal followup still same assignment');
    assert.equal(block.headers['x-miser-enforcement'], 'orch-assignment-budget');
    assert.equal(state.snapshot().sessions[0].currentAssignmentId, 'A');
  }
});

test('anchored reset markers require explicit assignment syntax', () => {
  const state = createEnforcementState({ nowMs: () => 1000 });
  const config = configFor('aetheria', {
    panels: ['orch'],
    warnManagementTurnsPerAssignment: 2,
    maxManagementTurnsPerAssignment: 2,
  });
  const deps = guard(config, state);

  assert.equal(call(deps, 'aetheria', 'orch', 'proposal routing MISER_ASSIGNMENT=A'), null);
  assert.equal(call(deps, 'aetheria', 'orch', 'proposal mediation').headers['x-miser-enforcement-warning'], 'orch-assignment-budget-edge');
  let block = call(deps, 'aetheria', 'orch', 'please note TASK-COMPLETE MISER_ASSIGNMENT=A proposal followup');
  assert.equal(block.headers['x-miser-enforcement'], 'orch-assignment-budget');

  const resetState = createEnforcementState({ nowMs: () => 1000 });
  const resetDeps = guard(config, resetState);
  assert.equal(call(resetDeps, 'aetheria', 'orch', 'proposal routing MISER_ASSIGNMENT=A'), null);
  assert.equal(call(resetDeps, 'aetheria', 'orch', 'proposal mediation').headers['x-miser-enforcement-warning'], 'orch-assignment-budget-edge');
  assert.equal(call(resetDeps, 'aetheria', 'orch', 'TASK-COMPLETE MISER_ASSIGNMENT=A'), null);
  assert.equal(call(resetDeps, 'aetheria', 'orch', 'proposal follow-up'), null);
});

test('assignment management warns at 2 and blocks after 3', () => {
  const state = createEnforcementState({ nowMs: () => 1000 });
  const config = configFor('aetheria', { panels: ['orch'] });
  const deps = guard(config, state);

  assert.equal(call(deps, 'aetheria', 'orch', 'proposal routing MISER_ASSIGNMENT=A'), null);
  const warn = call(deps, 'aetheria', 'orch', 'proposal mediation for builder audit');
  assert.equal(warn.status, 200);
  assert.equal(warn.headers['x-miser-enforcement-warning'], 'orch-assignment-budget-edge');
  assert.equal(call(deps, 'aetheria', 'orch', 'proposal approval gate status'), null);
  const block = call(deps, 'aetheria', 'orch', 'proposal revision routing again');
  assert.equal(block.status, 429);
  assert.equal(block.headers['x-miser-enforcement'], 'orch-assignment-budget');
});

test('generic panel_lifecycle without explicit handoff marker does not qualify as terminal handoff', () => {
  const state = createEnforcementState({ nowMs: () => 1000 });
  const config = configFor('aetheria', {
    panels: ['orch'],
    controlClasses: ['panel_lifecycle'],
    maxControlTurnsPerSession: 1,
    warnManagementTurnsPerAssignment: 99,
    maxManagementTurnsPerAssignment: 99,
    terminalHandoffMaxTurns: 1,
  });
  const deps = guard(config, state);

  assert.equal(call(deps, 'aetheria', 'orch', 'spawn-lane successor'), null);
  const block = call(deps, 'aetheria', 'orch', 'safe-reap predecessor again');
  assert.equal(block.headers['x-miser-enforcement'], 'orch-control-budget');
});

test('explicit terminal handoff is bounded after the control cap', () => {
  const state = createEnforcementState({ nowMs: () => 1000 });
  const config = configFor('aetheria', {
    panels: ['orch'],
    controlClasses: ['panel_lifecycle'],
    maxControlTurnsPerSession: 1,
    warnManagementTurnsPerAssignment: 99,
    maxManagementTurnsPerAssignment: 99,
    terminalHandoffMaxTurns: 1,
  });
  const deps = guard(config, state);

  assert.equal(call(deps, 'aetheria', 'orch', 'spawn-lane successor'), null);
  assert.equal(call(deps, 'aetheria', 'orch', 'HANDOFF-WRITTEN MISER_ASSIGNMENT=A\nsafe-reap predecessor'), null);
  const block = call(deps, 'aetheria', 'orch', 'HANDOFF-WRITTEN MISER_ASSIGNMENT=A\nsafe-reap predecessor again');
  assert.equal(block.headers['x-miser-enforcement'], 'orch-control-budget');
});

test('bounded inbound Brad reply allowance is explicit', () => {
  const state = createEnforcementState({ nowMs: () => 1000 });
  const config = configFor('aetheria', {
    panels: ['orch'],
    controlClasses: ['brad_comms'],
    warnManagementTurnsPerAssignment: 99,
    maxManagementTurnsPerAssignment: 1,
    inboundBradReplyMaxTurns: 1,
  });
  const deps = guard(config, state);

  assert.equal(call(deps, 'aetheria', 'orch', 'curl http://localhost/v1/orch/aetheria/reply'), null);
  assert.equal(call(deps, 'aetheria', 'orch', 'curl http://localhost/v1/orch/aetheria/reply again'), null);
  const block = call(deps, 'aetheria', 'orch', 'curl http://localhost/v1/orch/aetheria/reply third');
  assert.equal(block.headers['x-miser-enforcement'], 'orch-assignment-budget');
});

test('repo_status and audit_monitor count against control budget without pollClass likely', () => {
  const state = createEnforcementState({ nowMs: () => 1000 });
  const config = configFor('aetheria', {
    panels: ['orch'],
    warnManagementTurnsPerAssignment: 99,
    maxManagementTurnsPerAssignment: 99,
    warnSelfWorkTurnsPerAssignment: 99,
    maxSelfWorkTurnsPerAssignment: 99,
    maxControlTurnsPerSession: 1,
  });
  const deps = guard(config, state);

  assert.equal(call(deps, 'aetheria', 'orch', 'git status && gh pr view 12', { 'x-miser-poll-class': 'unlikely' }), null);
  const block = call(deps, 'aetheria', 'orch', 'wait for result.md and builder-audit', { 'x-miser-poll-class': 'unlikely' });
  assert.equal(block.headers['x-miser-enforcement'], 'orch-control-budget');
});

test('protected orch self-work warns then blocks repo, CI, file, and plugin work continuations', () => {
  let nowMs = 1000;
  const state = createEnforcementState({ nowMs: () => nowMs });
  const config = configFor('aetheria', {
    panels: ['orch'],
    warnManagementTurnsPerAssignment: 99,
    maxManagementTurnsPerAssignment: 99,
    warnSelfWorkTurnsPerAssignment: 1,
    maxSelfWorkTurnsPerAssignment: 1,
    maxControlTurnsPerSession: 99,
  });
  const deps = guard(config, state, () => new Date(nowMs));

  const warn = call(deps, 'aetheria', 'orch', 'gh run view 33295533496 --repo bheath-atx/aetheria-phase1 --log-failed');
  assert.equal(warn.headers['x-miser-enforcement-warning'], 'orch-self-work-budget-edge');
  nowMs += 3000;
  const block = checkEnforcement('aetheria', 'orch', {
    model: 'claude',
    max_tokens: 50,
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/tmp/audit.md' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'audit text' }] },
    ],
  }, {}, 100, deps);
  assert.equal(block.headers['x-miser-enforcement'], 'orch-self-work-budget');
});

test('negated self-work instructions and pure Brad comms do not consume self-work budget', () => {
  const state = createEnforcementState({ nowMs: () => 1000 });
  const config = configFor('aetheria', {
    panels: ['orch'],
    warnManagementTurnsPerAssignment: 99,
    maxManagementTurnsPerAssignment: 99,
    warnSelfWorkTurnsPerAssignment: 1,
    maxSelfWorkTurnsPerAssignment: 1,
  });
  const deps = guard(config, state);

  assert.equal(call(deps, 'aetheria', 'orch', 'Do not run gh run view or inspect CI status.'), null);
  assert.equal(call(deps, 'aetheria', 'orch', 'curl http://localhost/v1/orch/aetheria/reply'), null);
  const st = state.snapshot().sessions[0];
  assert.equal(st.selfWorkTurns, 0);
});

test('management-like unclassified text counts when enabled', () => {
  const state = createEnforcementState({ nowMs: () => 1000 });
  const config = configFor('aetheria', {
    panels: ['orch'],
    warnManagementTurnsPerAssignment: 99,
    maxManagementTurnsPerAssignment: 1,
  });
  const deps = guard(config, state);

  assert.equal(call(deps, 'aetheria', 'orch', 'proposal routing for architect lane'), null);
  const block = call(deps, 'aetheria', 'orch', 'proposal approval gate update');
  assert.equal(block.headers['x-miser-enforcement'], 'orch-assignment-budget');
});

test('one marked DISPATCH_FINALIZE is allowed once and does not reset budget', () => {
  const state = createEnforcementState({ nowMs: () => 1000 });
  const config = configFor('aetheria', {
    panels: ['orch'],
    warnManagementTurnsPerAssignment: 99,
    maxManagementTurnsPerAssignment: 1,
  });
  const deps = guard(config, state);

  assert.equal(call(deps, 'aetheria', 'orch', 'proposal routing', {}, { 'x-miser-assignment-id': 'A' }), null);
  assert.equal(call(deps, 'aetheria', 'orch', 'DISPATCH_FINALIZE MISER_ASSIGNMENT=A CHILD_SESSION=s1 proposal final'), null);
  const st = state.snapshot().sessions[0];
  assert.equal(st.assignmentManagementTurns, 2);
  assert.equal(st.dispatchFinalizeUsed, true);
  const block = call(deps, 'aetheria', 'orch', 'DISPATCH_FINALIZE MISER_ASSIGNMENT=A CHILD_SESSION=s1 proposal final retry');
  assert.equal(block.headers['x-miser-enforcement'], 'orch-assignment-budget');
});

test('architect proposal revision cycle 3 blocks without approval', () => {
  const state = createEnforcementState({ nowMs: () => 1000 });
  const config = configFor('aetheria', {
    panels: ['architect'],
    warnManagementTurnsPerAssignment: 99,
    maxManagementTurnsPerAssignment: 99,
    maxRevisionCycles: 2,
  });
  const deps = guard(config, state);

  assert.equal(call(deps, 'aetheria', 'architect', 'PROPOSAL_REVISION MISER_ASSIGNMENT=A proposal update 1'), null);
  assert.equal(call(deps, 'aetheria', 'architect', 'PROPOSAL_REVISION MISER_ASSIGNMENT=A proposal update 2'), null);
  const block = call(deps, 'aetheria', 'architect', 'PROPOSAL_REVISION MISER_ASSIGNMENT=A proposal update 3');
  assert.equal(block.headers['x-miser-enforcement'], 'architect-revision-budget');
});

test('raw assistant turns and large context alone do not block real work in protected panels', () => {
  const state = createEnforcementState({ nowMs: () => 1000 });
  const config = configFor('aetheria', {
    panels: ['orch'],
    maxControlTurnsPerSession: 1,
  });
  const deps = guard(config, state);
  recordEnforcementUsage('aetheria', 'orch', { input_tokens: 50_000_000, output_tokens: 1 }, {}, deps);
  const body = bodyFor('edit src/enforcement.js to parse the new field and run tests', 120);
  assert.equal(checkEnforcement('aetheria', 'orch', body, { 'x-miser-poll-class': 'unlikely' }, 800000, deps), null);
});

test('unconfigured orchControl no longer live-enforces the legacy NACHO canary path', () => {
  let nowMs = Date.parse('2026-08-25T12:00:00.000Z');
  const state = createEnforcementState({ nowMs: () => nowMs });
  const config = parseEnforcement(JSON.stringify({
    '*': { mode: 'observe', override: { overrideFile: TEST_OVERRIDE_FILE } },
    'nacho-orch': { mode: 'throttle', poll: { maxLikelyPollsPer10Min: 1, minIdlePollSpacingSec: 600 } },
  }));
  const deps = guard(config, state, () => new Date(nowMs));

  assert.equal(call(deps, 'nacho-orch', 'sprints', 'curl /api/miser/stats', { 'x-miser-poll-class': 'likely' }), null);
  nowMs += 1000;
  assert.equal(call(deps, 'nacho-orch', 'sprints', 'please make the requested boot prompt wording change', { 'x-miser-poll-class': 'likely' }), null);
  nowMs += 1000;
  assert.equal(call(deps, 'nacho-orch', 'sprints', 'curl /api/miser/stats', { 'x-miser-poll-class': 'likely' }), null);
});

test('historical oversized tool_result is not blocked unless strict latest-turn block is explicitly enabled', () => {
  const state = createEnforcementState({ nowMs: () => 1000 });
  const config = parseEnforcement(JSON.stringify({
    '*': { mode: 'block', toolResults: { mode: 'alert', maxToolResultBytes: 10 } },
  }));
  const deps = guard(config, state);
  assert.equal(checkEnforcement('nacho-orch', 'sprints', toolResultBody('x'.repeat(100)), { 'x-miser-poll-class': 'unlikely' }, 100, deps), null);
});

test('redirect classifier marks ORCH gh run view as POLL_CI and shadow records without blocking', () => {
  const state = createEnforcementState({ nowMs: () => 1000 });
  const config = parseEnforcement(JSON.stringify({
    '*': { mode: 'observe', redirect: { mode: 'shadow' }, override: { overrideFile: TEST_OVERRIDE_FILE } },
  }));
  const deps = guard(config, state);
  const body = bashToolResultBody('gh run view 123 --log');
  const c = classifyRequest('aetheria', 'orch', body, { 'x-miser-poll-class': 'unlikely' }, 100);
  assert.equal(c.role, 'ORCH');
  assert.equal(c.commandClass, 'POLL_CI');
  assert.equal(c.redirectable, true);

  assert.equal(checkEnforcement('aetheria', 'orch', body, { 'x-miser-poll-class': 'unlikely' }, 100, deps), null);
  assert.equal(deps.events.length, 1);
  assert.equal(deps.events[0].decision, 'would_synthesize');
  assert.equal(deps.events[0].would_synthesize, true);
  assert.equal(deps.events[0].commandClass, 'POLL_CI');
  assert.equal(deps.events[0].role, 'ORCH');
  assert.equal(typeof deps.events[0].fingerprint, 'string');
  assert.equal(state.snapshot().redirect.wouldSynthesize, 1);
});

test('non-streaming synthetic helper emits Claude text-only response with zero usage', () => {
  const response = buildSyntheticMessageResponse({ model: 'claude-fable-5', tools: [{ name: 'Bash' }] }, 'use watcher artifact');
  assert.equal(response.type, 'message');
  assert.equal(response.role, 'assistant');
  assert.equal(response.model, 'claude-fable-5');
  assert.deepEqual(response.usage, {
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
  });
  assert.equal(response.content.length, 1);
  assert.equal(response.content[0].type, 'text');
  assert.match(response.content[0].text, /^\[MISER-SYNTHETIC\]/);
  assert.equal(response.content.some(block => block.type === 'tool_use'), false);
});

test('streaming synthetic helper emits valid Claude SSE text flow', () => {
  const sse = buildSyntheticSseResponse({ model: 'claude-fable-5', stream: true }, 'shadow text', { id: 'msg_miser_test' });
  const events = [...sse.matchAll(/^event: ([^\n]+)\ndata: (.+)$/gm)].map(match => ({
    event: match[1],
    data: JSON.parse(match[2]),
  }));
  assert.deepEqual(events.map(e => e.event), [
    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_stop',
    'message_delta',
    'message_stop',
  ]);
  assert.equal(events[0].data.message.id, 'msg_miser_test');
  assert.equal(events[0].data.message.model, 'claude-fable-5');
  assert.match(events[2].data.delta.text, /^\[MISER-SYNTHETIC\]/);
  assert.equal(events[4].data.delta.stop_reason, 'end_turn');
  assert.equal(sse.includes('tool_use'), false);
});

test('request with tools still receives synthetic text-only response with no tool_use', () => {
  const response = buildSyntheticMessageResponse({
    model: 'claude-fable-5',
    tools: [{ name: 'Bash', input_schema: { type: 'object' } }],
  }, 'no tools emitted');
  assert.deepEqual(response.content.map(block => block.type), ['text']);
  assert.equal(JSON.stringify(response).includes('tool_use'), false);
});

test('valid dispatch-only commands classify as DISPATCH_OK and are not redirectable', () => {
  for (const command of [
    '~/bin/spawn-lane.sh --project aetheria --role builder',
    'safe-reap.sh --panel old',
    'td-inject s1 payload',
    'curl -sS -X POST http://127.0.0.1:8001/v1/orch/aetheria/reply',
    'git fetch',
    'date',
  ]) {
    const c = classifyRequest('aetheria', 'orch', bashToolResultBody(command), {}, 100);
    assert.equal(c.commandClass, 'DISPATCH_OK', command);
    assert.equal(c.redirectable, false, command);
  }
});

test('negated poll instructions in user text do not classify as redirectable', () => {
  for (const text of [
    'do not poll',
    'do not run gh run view 123',
    "don't poll or run gh pr checks",
  ]) {
    const c = classifyRequest('aetheria', 'orch', promptBody(text), {}, 100);
    assert.equal(c.commandClass, 'NEUTRAL', text);
    assert.equal(c.redirectable, false, text);
  }
});

test('conversation fingerprint changes when first user message changes', () => {
  const a = promptBody('first task A');
  const b = promptBody('first task B');
  assert.notEqual(conversationFingerprint(a), conversationFingerprint(b));
  assert.equal(conversationFingerprint(a), classifyRequest('aetheria', 'orch', a, {}, 100).conversationFingerprint);
});
