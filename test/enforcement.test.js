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
const { classifyOrchIntent, promptFor, validateAdvisorJson } = require('../src/orch-intent-classifier.js');

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

function readToolResultBody(filePath, content, firstPrompt = 'You are a temporary NACHO-ORCH coordinator. First respond STARTED, then read only the minimal launcher setup file and propose the sprint.') {
  return {
    model: 'claude-sonnet-5-test',
    max_tokens: 50,
    system: 'You are the ORCH controller for this sprint.',
    messages: [
      { role: 'user', content: firstPrompt },
      { role: 'assistant', content: 'STARTED' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: filePath } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content }] },
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

function conversationBody(firstText, latestText, assistantCount = 1) {
  const messages = [{ role: 'user', content: firstText }];
  for (let i = 0; i < assistantCount; i++) {
    messages.push({ role: 'assistant', content: `assistant ${i}` });
    if (i < assistantCount - 1) messages.push({ role: 'user', content: `intermediate ${i}` });
  }
  messages.push({ role: 'user', content: latestText });
  return { model: 'claude', max_tokens: 50, messages };
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

function controlText(response) {
  assert.equal(response.status, 200);
  assert.equal(response.body.type, 'message');
  assert.equal(response.body.role, 'assistant');
  assert.equal(response.body.usage.input_tokens, 0);
  const text = response.body.content[0].text;
  assert.match(text, /miser_control_plane_error/);
  assert.match(text, /retryable=false/);
  return text;
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
    bootSetupMarkers: ['BOOT_READY'],
    bootSetupMaxAssistantTurns: 2,
    bootSetupMaxMessages: 4,
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

test('Claude Code system-reminder text does not poison orch enforcement classification', () => {
  const injected = [
    '<system-reminder>',
    'Do not poll TermDeck sessions. Check /api/miser/health.',
    'Use panel_lifecycle, audit_monitor, usage_monitor, repo_status, handoff.',
    'Run git status and gh pr view only when needed.',
    '</system-reminder>',
    '',
    'Reply exactly: OK',
  ].join('\n');
  const c = classifyRequest('provenspec', 'orch', promptBody(injected), { 'x-miser-poll-class': 'likely' }, 100);
  assert.deepEqual(c.controlClasses, []);
  assert.equal(c.managementLike, false);
  assert.equal(c.pollingCommandLike, false);
  assert.equal(c.selfWorkCommandLike, false);
  assert.equal(c.commandClass, 'NEUTRAL');
});

test('real user text after a Claude Code system-reminder still classifies', () => {
  const injected = [
    '<system-reminder>Do not poll TermDeck sessions.</system-reminder>',
    '',
    'curl http://127.0.0.1:20128/api/miser/stats',
  ].join('\n');
  const c = classifyRequest('provenspec', 'orch', promptBody(injected), { 'x-miser-poll-class': 'likely' }, 100);
  assert.ok(c.controlClasses.includes('usage_monitor'));
  assert.equal(c.pollingCommandLike, true);
  assert.equal(c.commandClass, 'POLL_MISER');
});

test('configured non-nacho project blocks repeated explicit polling commands', () => {
  let nowMs = Date.parse('2026-08-25T12:00:00.000Z');
  const state = createEnforcementState({ nowMs: () => nowMs });
  const config = configFor('aetheria', { panels: ['orch'], maxManagementTurnsPerAssignment: 99 });
  config.aetheria.poll.maxLikelyPollsPer10Min = 1;
  const deps = guard(config, state, () => new Date(nowMs));

  const warn = call(deps, 'aetheria', 'orch', 'curl http://127.0.0.1:20128/api/miser/stats', { 'x-miser-poll-class': 'likely' });
  assert.match(controlText(warn), /Do not retry/);
  assert.equal(warn.headers['x-miser-enforcement-warning'], 'poll-budget-edge');
  nowMs += 3000;
  const block = call(deps, 'aetheria', 'orch', 'curl http://127.0.0.1:20128/api/miser/stats', { 'x-miser-poll-class': 'likely' });
  assert.match(controlText(block), /poll budget exceeded/);
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
    assert.match(controlText(first), /miser_control_plane_error/);
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

test('fresh low-turn replacement panel resets stale protected counters by conversation fingerprint', () => {
  let nowMs = 1000;
  const state = createEnforcementState({ nowMs: () => nowMs });
  const config = configFor('aetheria', {
    panels: ['orch'],
    warnManagementTurnsPerAssignment: 2,
    maxManagementTurnsPerAssignment: 2,
  });
  const deps = guard(config, state, () => new Date(nowMs));

  assert.equal(checkEnforcement('aetheria', 'orch', conversationBody('old boot handoff', 'proposal routing MISER_ASSIGNMENT=A'), { 'x-miser-poll-class': 'unlikely' }, 100, deps), null);
  nowMs += 3000;
  assert.equal(checkEnforcement('aetheria', 'orch', conversationBody('old boot handoff', 'proposal mediation'), { 'x-miser-poll-class': 'unlikely' }, 100, deps).headers['x-miser-enforcement-warning'], 'orch-assignment-budget-edge');
  assert.equal(state.snapshot().sessions[0].assignmentManagementTurns, 2);

  nowMs += 3000;
  assert.equal(call(deps, 'aetheria', 'orch', 'proposal fresh follow-up after replacement'), null);
  const st = state.snapshot().sessions[0];
  assert.equal(st.assignmentManagementTurns, 1);
  assert.equal(st.currentAssignmentId, null);
});

test('fresh ORCH boot and handoff setup prompt is not counted or warned', () => {
  let nowMs = 1000;
  const state = createEnforcementState({ nowMs: () => nowMs });
  const config = configFor('termdeck-updates', {
    panels: ['orch'],
    warnManagementTurnsPerAssignment: 2,
    maxManagementTurnsPerAssignment: 2,
  });
  const deps = guard(config, state, () => new Date(nowMs));

  assert.equal(call(deps, 'termdeck-updates', 'orch', 'proposal routing MISER_ASSIGNMENT=A'), null);
  nowMs += 3000;
  assert.equal(call(deps, 'termdeck-updates', 'orch', 'proposal mediation').headers['x-miser-enforcement-warning'], 'orch-assignment-budget-edge');
  assert.equal(state.snapshot().sessions[0].assignmentManagementTurns, 2);

  nowMs += 3000;
  const bootPrompt = [
    'MISER_BOOT_SETUP',
    '# TermDeck ORCH Canary - Boot Prompt',
    'You are TermDeck-ORCH-CANARY, a live orchestration canary.',
    'Role: Coordinate only. Do not implement code. Do not edit files. Do not run local status, systemctl, curl, gh, git, test, file-reading, or watcher-poll commands.',
    'Read the handoff and reply in one short sentence: online.',
    'Then wait. Do not run tools.',
  ].join('\n');

  assert.equal(call(deps, 'termdeck-updates', 'orch', bootPrompt), null);
  const st = state.snapshot().sessions[0];
  assert.equal(st.assignmentManagementTurns, 0);
  assert.equal(st.controlTurns, 0);
  assert.equal(st.likelyPollRequests, 0);
});

test('boot setup marker does not bypass explicit polling or self-work', () => {
  const state = createEnforcementState({ nowMs: () => 1000 });
  const config = configFor('aetheria', {
    panels: ['orch'],
    warnManagementTurnsPerAssignment: 99,
    maxManagementTurnsPerAssignment: 99,
    maxControlTurnsPerSession: 99,
    poll: { maxLikelyPollsPer10Min: 1 },
  });
  config.aetheria.poll.maxLikelyPollsPer10Min = 1;
  const deps = guard(config, state);

  const pollWarn = call(deps, 'aetheria', 'orch', 'MISER_BOOT_SETUP\ncurl http://127.0.0.1:20128/api/miser/stats', { 'x-miser-poll-class': 'likely' });
  assert.equal(pollWarn.headers['x-miser-enforcement-warning'], 'poll-budget-edge');

  const workState = createEnforcementState({ nowMs: () => 1000 });
  const workConfig = configFor('aetheria', {
    panels: ['orch'],
    warnManagementTurnsPerAssignment: 99,
    maxManagementTurnsPerAssignment: 99,
    warnSelfWorkTurnsPerAssignment: 1,
    maxSelfWorkTurnsPerAssignment: 1,
  });
  const workDeps = guard(workConfig, workState);
  const selfWarn = call(workDeps, 'aetheria', 'orch', 'MISER_BOOT_SETUP\nrun npm test');
  assert.equal(selfWarn.headers['x-miser-enforcement-warning'], 'orch-self-work-budget-edge');
});

test('marker-less manual ORCH boot setup Read of spawn-lane is inferred without advisor stub', () => {
  const state = createEnforcementState({ nowMs: () => 1000 });
  const config = configFor('nacho-orch', {
    panels: ['sprints'],
    warnManagementTurnsPerAssignment: 1,
    maxManagementTurnsPerAssignment: 1,
    warnSelfWorkTurnsPerAssignment: 1,
    maxSelfWorkTurnsPerAssignment: 1,
  });
  const deps = guard(config, state);
  const firstPrompt = [
    'You are `NACHO-ORCH-LAUNCHER-UX-SPRINT-20260907`, a temporary NACHO-ORCH canary/sprint coordinator on TermDeck `:3100`.',
    '',
    'Goal: test the normal manual Claude panel spawn + pasted boot-prompt path, then coordinate a small sprint to make ORCH launches easier than the long `spawn-lane.sh` command.',
    '',
    'Hard boundaries:',
    '- You are an ORCH, not the builder.',
    '- Do not edit code, docs, hooks, settings, or scripts directly.',
    '- Do not run inline `codex exec`.',
    '- Do not inspect secrets, `~/.ssh`, `~/.termdeck`, broad `/home/nacho` searches, or unrelated transcripts.',
    '- Do not poll TermDeck, Miser, CI, GitHub, or watcher artifacts unless Brad explicitly asks for one exact fact.',
    '- If implementation is needed, dispatch a visible `:3200` builder/integrator lane using the existing safe launcher path.',
    '- Do not spawn anything until you have summarized the proposed sprint and Brad approves.',
    '',
    'First response format exactly:',
    '### [NACHO-ORCH-LAUNCHER-UX-SPRINT] STARTED',
    'Manual spawn + pasted boot prompt received.',
    'I will coordinate, not build.',
    'Next: read only the minimal launcher files and propose the smallest sprint to make ORCH launch interactive.',
  ].join('\n');
  const body = readToolResultBody('/home/nacho/bin/spawn-lane.sh', [
    '#!/usr/bin/env bash',
    'curl -sS http://127.0.0.1:3200/api/sessions',
    'git fetch',
    'gh pr view 12',
    'npm test',
  ].join('\n'), firstPrompt);

  assert.equal(checkEnforcement('nacho-orch', 'sprints', body, { 'x-miser-poll-class': 'unlikely' }, 100, deps), null);
  const st = state.snapshot().sessions[0];
  assert.equal(st.assignmentManagementTurns, 0);
  assert.equal(st.selfWorkTurns, 0);
  assert.equal(st.controlTurns, 0);
});

test('fresh setup Read inference is limited to known launcher/setup files', () => {
  const state = createEnforcementState({ nowMs: () => 1000 });
  const config = configFor('nacho-orch', {
    panels: ['sprints'],
    warnManagementTurnsPerAssignment: 99,
    maxManagementTurnsPerAssignment: 99,
    warnSelfWorkTurnsPerAssignment: 1,
    maxSelfWorkTurnsPerAssignment: 1,
  });
  const deps = guard(config, state);
  const body = readToolResultBody('/home/nacho/miser/src/enforcement.js', 'curl /api/sessions\ngit status\nnpm test');

  const response = checkEnforcement('nacho-orch', 'sprints', body, { 'x-miser-poll-class': 'unlikely' }, 100, deps);
  assert.equal(response.headers['x-miser-enforcement-warning'], 'orch-self-work-budget-edge');
});

test('non-ORCH reviewer prompt is not governed by ORCH budget or watcher redirects', () => {
  const state = createEnforcementState({ nowMs: () => 1000 });
  const config = configFor('miser', {
    panels: ['orch'],
    warnManagementTurnsPerAssignment: 1,
    maxManagementTurnsPerAssignment: 1,
    warnSelfWorkTurnsPerAssignment: 1,
    maxSelfWorkTurnsPerAssignment: 1,
  });
  config.miser.redirect = { mode: 'warn' };
  const deps = guard(config, state);
  const firstPrompt = [
    '# Claude Architecture Review Briefing: miser-smart-orch-classifier',
    'ROLE_LABEL: miser-smart-orch-classifier-CLAUDE-AUDIT-20260907',
    '',
    'You are a non-ORCH Claude architecture reviewer.',
    'Do not coordinate other panels. Review the built architecture only.',
  ].join('\n');
  const body = {
    model: 'claude',
    max_tokens: 50,
    messages: [
      { role: 'user', content: firstPrompt },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'curl http://127.0.0.1:20128/api/miser/stats' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'watcher output' }] },
    ],
  };

  const classification = classifyRequest('miser', 'orch', body, { 'x-miser-poll-class': 'likely' }, 100);
  assert.equal(classification.explicitNonOrchRole, true);
  assert.equal(classification.role, 'worker');
  assert.equal(checkEnforcement('miser', 'orch', body, { 'x-miser-poll-class': 'likely' }, 100, deps), null);
  const st = state.snapshot().sessions[0];
  assert.equal(st.assignmentManagementTurns, 0);
  assert.equal(st.selfWorkTurns, 0);
  assert.equal(st.controlTurns, 1);
});

test('clean canary boot/setup remains clean with local advisor disabled', () => {
  const state = createEnforcementState({ nowMs: () => 1000 });
  const config = configFor('termdeck-updates', { panels: ['orch'] });
  const deps = guard(config, state);
  const bootPrompt = [
    'PANEL_BOOT',
    '# TermDeck ORCH Canary Boot 3',
    'You are `termdeck-updates-ORCH-CANARY3-20260907`, a live Claude ORCH cwd-routing canary.',
    'Reply with exactly:',
    '`[MISER ORCH CANARY3 READY]`',
    'Then wait. Do not run tools. Do not inspect files. Do not poll TermDeck, Miser, watcher artifacts, git, GitHub, services, logs, or local status.',
  ].join('\n');

  assert.equal(call(deps, 'termdeck-updates', 'orch', bootPrompt), null);
  assert.equal(state.snapshot().sessions[0].assignmentManagementTurns, 0);
});

test('obvious polling and ORCH self-work remain coached without live advisor execution', () => {
  const cases = [
    ['poll', 'curl http://127.0.0.1:20128/api/miser/stats', 'poll-budget-edge'],
    ['self-work', 'run npm test', 'orch-self-work-budget-edge'],
  ];
  for (const [label, text, expected] of cases) {
    const state = createEnforcementState({ nowMs: () => 1000 });
    const config = configFor('aetheria', {
      panels: ['orch'],
      warnManagementTurnsPerAssignment: 99,
      maxManagementTurnsPerAssignment: 99,
      warnSelfWorkTurnsPerAssignment: 1,
      maxSelfWorkTurnsPerAssignment: 1,
    });
    config.aetheria.poll.maxLikelyPollsPer10Min = 1;
    const deps = guard(config, state);
    const response = call(deps, 'aetheria', 'orch', text, { 'x-miser-poll-class': label === 'poll' ? 'likely' : 'unlikely' });
    assert.equal(response.headers['x-miser-enforcement-warning'], expected, label);
  }
});

test('Bash git and rg tool-results cannot be uncounted by classifier env', () => {
  for (const command of ['git status', 'rg TODO /home/nacho']) {
    const state = createEnforcementState({ nowMs: () => 1000 });
    const config = configFor('aetheria', {
      panels: ['orch'],
      warnManagementTurnsPerAssignment: 99,
      maxManagementTurnsPerAssignment: 99,
      warnSelfWorkTurnsPerAssignment: 1,
      maxSelfWorkTurnsPerAssignment: 1,
    });
    const deps = guard(config, state);
    deps.env = { MISER_ORCH_INTENT_CLASSIFIER: '1', MISER_ORCH_INTENT_CLASSIFIER_CMD: 'false' };
    const response = checkEnforcement('aetheria', 'orch', bashToolResultBody(command), {}, 100, deps);
    assert.equal(response.headers['x-miser-enforcement-warning'], 'orch-self-work-budget-edge', command);
  }
});

test('hard ORCH safety blocks bypass smart advisor', () => {
  const state = createEnforcementState({ nowMs: () => 1000 });
  const config = configFor('aetheria', {
    panels: ['orch'],
    warnSelfWorkTurnsPerAssignment: 99,
    maxSelfWorkTurnsPerAssignment: 99,
  });
  const deps = guard(config, state);
  deps.env = { MISER_ORCH_INTENT_CLASSIFIER: '1', MISER_ORCH_INTENT_CLASSIFIER_CMD: 'false' };
  const body = {
    model: 'claude',
    max_tokens: 50,
    system: 'You are the ORCH controller.',
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/home/nacho/.ssh/id_rsa' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'not shown' }] },
    ],
  };

  const block = checkEnforcement('aetheria', 'orch', body, {}, 100, deps);
  assert.equal(block.headers['x-miser-enforcement'], 'orch-hard-safety');
});

test('staged advisor invalid and low-confidence output are rejected before use', () => {
  const outputs = [
    'not json',
    JSON.stringify({
      intent: 'boot_setup',
      confidence: 0.2,
      should_count: false,
      action: 'allow',
      operator_message: 'too unsure',
      reason: 'low',
    }),
  ];
  for (const output of outputs) {
    const result = classifyOrchIntent({ project: 'nacho-orch' }, { advisorText: output });
    assert.equal(result.ok, false);
  }
});

test('configured local advisor env does not execute in live enforcement fallback path', () => {
  const state = createEnforcementState({ nowMs: () => 1000 });
  const config = configFor('nacho-orch', {
    panels: ['sprints'],
    warnManagementTurnsPerAssignment: 99,
    maxManagementTurnsPerAssignment: 99,
    warnSelfWorkTurnsPerAssignment: 1,
    maxSelfWorkTurnsPerAssignment: 1,
  });
  const deps = guard(config, state);
  deps.env = { MISER_ORCH_INTENT_CLASSIFIER: '1', MISER_ORCH_INTENT_CLASSIFIER_CMD: 'sleep 5' };

  const response = checkEnforcement('nacho-orch', 'sprints',
    readToolResultBody('/home/nacho/miser/src/enforcement.js', 'curl /api/sessions\ngh pr view 1'),
    { 'x-miser-poll-class': 'unlikely' }, 100, deps);
  assert.equal(response.headers['x-miser-enforcement-warning'], 'orch-self-work-budget-edge');
});

test('staged advisor prompt includes boot evidence and not provider API environment values', () => {
  const classification = classifyRequest('nacho-orch', 'sprints',
    readToolResultBody('/home/nacho/bin/spawn-lane.sh', 'curl /api/sessions'),
    {}, 100);
  const prompt = promptFor({
    project: 'nacho-orch',
    panel: 'sprints',
    classification,
    tool: { name: 'Read', command: '', filePath: '/home/nacho/bin/spawn-lane.sh' },
  });
  const result = classifyOrchIntent({
    project: 'nacho-orch',
    panel: 'sprints',
    classification,
    tool: { name: 'Read', command: '', filePath: '/home/nacho/bin/spawn-lane.sh' },
  }, {
    advisorText: JSON.stringify({
      intent: 'boot_setup',
      confidence: 0.95,
      should_count: false,
      action: 'allow',
      operator_message: 'setup allowed',
      reason: 'setup',
    }),
  });

  assert.equal(result.ok, true);
  assert.match(prompt, /first_user/);
  assert.match(prompt, /tool_name/);
  assert.match(prompt, /tool_file_path/);
  assert.match(prompt, /spawn-lane\.sh/);
  assert.ok(!prompt.includes('anthropic-secret-value'));
  assert.ok(!prompt.includes('openai-secret-value'));
  assert.ok(!prompt.includes('gemini-secret-value'));
});

test('staged advisor module has no synchronous process or curl live inference path', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'orch-intent-classifier.js'), 'utf8');
  assert.ok(!src.includes('spawnSync'));
  assert.ok(!src.includes("spawnSync('curl'"));
  assert.ok(!src.includes('child_process'));
});

test('smart advisor strict JSON validation rejects malformed schema', () => {
  assert.equal(validateAdvisorJson('{"intent":"boot_setup","confidence":0.9,"should_count":false,"action":"allow","operator_message":"ok","reason":"boot"}').ok, true);
  assert.equal(validateAdvisorJson('{"intent":"boot","confidence":0.9,"should_count":false,"action":"allow","operator_message":"ok","reason":"boot"}').reason, 'invalid_intent');
  assert.equal(validateAdvisorJson('{"intent":"boot_setup","confidence":0.9,"should_count":"no","action":"allow","operator_message":"ok","reason":"boot"}').reason, 'invalid_should_count');
  assert.equal(validateAdvisorJson('{"intent":"boot_setup","confidence":0.9,"should_count":false,"action":"allow","operator_message":"ok","reason":"has spaces"}').reason, 'invalid_reason');
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
  const config = configFor('aetheria', {
    panels: ['orch'],
    warnSelfWorkTurnsPerAssignment: 99,
    maxSelfWorkTurnsPerAssignment: 99,
  });
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
  assert.match(controlText(warn), /miser_control_plane_error/);
  assert.equal(call(deps, 'aetheria', 'orch', 'proposal approval gate status'), null);
  const block = call(deps, 'aetheria', 'orch', 'proposal revision routing again');
  assert.equal(block.status, 200);
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

test('marked DISPATCH_FINALIZE bypasses stale control-loop cap once', () => {
  const state = createEnforcementState({ nowMs: () => 1000 });
  const config = configFor('aetheria', {
    panels: ['orch'],
    controlClasses: ['repo_status', 'audit_monitor'],
    warnManagementTurnsPerAssignment: 99,
    maxManagementTurnsPerAssignment: 99,
    warnSelfWorkTurnsPerAssignment: 99,
    maxSelfWorkTurnsPerAssignment: 99,
    maxControlTurnsPerSession: 1,
  });
  const deps = guard(config, state);

  assert.equal(call(deps, 'aetheria', 'orch', 'git status && gh pr view 351'), null);
  assert.equal(call(deps, 'aetheria', 'orch', [
    'DISPATCH_FINALIZE MISER_ASSIGNMENT=A CHILD_SESSION=pending',
    'Dispatch Grok audit for PR351',
    'CI run 33345975040 status=success',
  ].join('\n')), null);
  const block = call(deps, 'aetheria', 'orch', [
    'DISPATCH_FINALIZE MISER_ASSIGNMENT=A CHILD_SESSION=pending',
    'Dispatch Grok audit for PR351 retry',
  ].join('\n'));
  assert.equal(block.headers['x-miser-enforcement'], 'orch-control-budget');
});

test('explicit Brad approval boundary bypasses stale control-loop cap', () => {
  const state = createEnforcementState({ nowMs: () => 1000 });
  const config = configFor('aetheria', {
    panels: ['orch'],
    controlClasses: ['repo_status', 'audit_monitor'],
    warnManagementTurnsPerAssignment: 99,
    maxManagementTurnsPerAssignment: 99,
    warnSelfWorkTurnsPerAssignment: 99,
    maxSelfWorkTurnsPerAssignment: 99,
    maxControlTurnsPerSession: 1,
  });
  const deps = guard(config, state);

  assert.equal(call(deps, 'aetheria', 'orch', 'git status && gh pr view 351'), null);
  assert.equal(call(deps, 'aetheria', 'orch', 'BRAD_APPROVED_CONTINUE MISER_ASSIGNMENT=A dispatch the bounded PR351 fix'), null);
});

test('operator-generated dispatch prompt bypasses stale control-loop state', () => {
  const state = createEnforcementState({ nowMs: () => 1000 });
  const config = configFor('aetheria', {
    panels: ['orch'],
    controlClasses: ['repo_status', 'audit_monitor'],
    warnManagementTurnsPerAssignment: 99,
    maxManagementTurnsPerAssignment: 99,
    warnSelfWorkTurnsPerAssignment: 99,
    maxSelfWorkTurnsPerAssignment: 99,
    maxControlTurnsPerSession: 1,
  });
  const deps = guard(config, state);

  assert.equal(call(deps, 'aetheria', 'orch', 'gh pr view 351 --json statusCheckRollup'), null);
  const dispatch = [
    '# Aetheria-Concierge orch-dispatch Prompt',
    'Task: Dispatch Grok audit for PR #351',
    'Project: Aetheria-Concierge',
    'MISER_ASSIGNMENT=aetheria-dispatch-grok-audit-for-pr-351-20260831t184132z',
    '',
    'DISPATCH_FINALIZE MISER_ASSIGNMENT=aetheria-dispatch-grok-audit-for-pr-351-20260831t184132z CHILD_SESSION=pending',
    'BRAD_APPROVED_CONTINUE MISER_ASSIGNMENT=aetheria-dispatch-grok-audit-for-pr-351-20260831t184132z',
    '',
    'PR state: OPEN; mergeStateStatus: CLEAN; mergeable: MERGEABLE',
    'CI run 33426015052 CI: status=completed conclusion=success',
    'Matching audit artifact: /tmp/aetheria-lanes/builder-sprint19-pr4-voice-handoff/GROK-AUDIT-R1.md (VERDICT: REVISE)',
  ].join('\n');

  assert.equal(call(deps, 'aetheria', 'orch', dispatch), null);
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
  const config = configFor('aetheria', {
    panels: ['orch'],
    warnSelfWorkTurnsPerAssignment: 99,
    maxSelfWorkTurnsPerAssignment: 99,
  });
  config.aetheria.redirect = { mode: 'shadow' };
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
