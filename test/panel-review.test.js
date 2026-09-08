'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  deterministicClassify,
  markerHits,
  normalizeClassification,
  reviewPanels,
  __test,
} = require('../src/panel-review.js');

function tmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `miser-panel-review-${label}-${process.pid}-`));
}

test('markerHits recognizes completion, blocker, handoff, and tests evidence', () => {
  const markers = markerHits('VERDICT: APPROVE\nnpm test passed\nORCH-RESULT written\nHANDOFF ready');
  assert.ok(markers.includes('complete'));
  assert.ok(markers.includes('tests'));
  assert.ok(markers.includes('handoff'));
  assert.ok(markerHits('VERDICT: REVISE\nBLOCKER one').includes('blocked'));
});

test('deterministic classifier treats result plus tests as complete', () => {
  const review = deterministicClassify({
    id: 'sid-1',
    label: 'T1-CODEX',
    status: 'idle',
    lastActivity: new Date().toISOString(),
    lastCommands: [],
    transcript: { tail: 'assistant: VERDICT: APPROVE. npm test passed.', errors: [] },
    artifacts: [{ path: '/tmp/ORCH-RESULT.md', preview: 'ORCH-RESULT\nVERDICT: COMPLETE\nTests passed.' }],
    git: { isRepo: true, status: '## branch\n M file' },
  });
  assert.equal(review.state, 'complete');
  assert.equal(review.source, 'deterministic');
  assert.ok(review.confidence >= 0.7);
});

test('deterministic classifier ignores git status marker text', () => {
  const review = deterministicClassify({
    id: 'sid-1',
    label: 'T1-CODEX',
    status: 'idle',
    lastActivity: new Date().toISOString(),
    lastCommands: [],
    transcript: { tail: '', errors: [] },
    artifacts: [],
    git: { isRepo: true, status: '?? old-BLOCKER-note.md' },
  });
  assert.equal(review.state, 'running');
});

test('deterministic classifier treats errored panels as blocked', () => {
  const review = deterministicClassify({
    id: 'sid-err',
    label: 'T1-GROK',
    status: 'errored',
    lastActivity: new Date().toISOString(),
    lastCommands: [],
    transcript: { tail: '', errors: [] },
    artifacts: [],
    git: { isRepo: false },
  });
  assert.equal(review.state, 'blocked');
  assert.ok(review.confidence >= 0.8);
});

test('normalizeClassification accepts bounded local LLM JSON and preserves fallback for bad state', () => {
  const fallback = {
    state: 'running',
    confidence: 0.5,
    evidence: ['baseline'],
    missing: [],
    message_for_orch: 'baseline',
    source: 'deterministic',
  };
  const parsed = normalizeClassification(JSON.stringify({
    state: 'needs_human',
    confidence: 0.91,
    evidence: ['manual approval requested'],
    missing: ['approval'],
    message_for_orch: 'Needs Brad approval before merge.',
  }), fallback, 'local-llm');
  assert.equal(parsed.state, 'needs_human');
  assert.equal(parsed.source, 'local-llm');
  assert.equal(parsed.confidence, 0.91);

  const bad = normalizeClassification('{"state":"invented","confidence":2}', fallback, 'local-llm');
  assert.equal(bad.state, 'running');
  assert.equal(bad.confidence, 1);
});

test('normalizeClassification falls back from contradictory LLM messages', () => {
  const fallback = {
    state: 'blocked',
    confidence: 0.8,
    evidence: ['termdeck status errored'],
    missing: [],
    message_for_orch: 'grok: blocked',
    source: 'deterministic',
  };
  const parsed = normalizeClassification(JSON.stringify({
    state: 'blocked',
    confidence: 0.9,
    evidence: ['termdeck status errored'],
    message_for_orch: 'grok: running',
  }), fallback, 'local-llm');
  assert.equal(parsed.state, 'blocked');
  assert.equal(parsed.message_for_orch, 'grok: blocked');
});

test('reviewPanels writes index artifacts from mocked TermDeck sessions without LLM', async () => {
  const cwd = tmpDir('cwd');
  const out = tmpDir('out');
  fs.writeFileSync(path.join(cwd, 'ORCH-RESULT.md'), 'VERDICT: COMPLETE\nnpm test passed\n');
  const result = await reviewPanels({
    outputDir: out,
    token: 'test-token',
    bases: ['http://td'],
    llmEnabled: false,
    fetchJson: async (url, opts) => {
      assert.equal(url, 'http://td/api/sessions');
      assert.equal(opts.headers.Authorization, 'Bearer test-token');
      return [{
        id: '12345678-aaaa-bbbb-cccc-123456789abc',
        pid: 123,
        meta: {
          type: 'codex',
          project: 'pkachu',
          label: 'T1-CODEX',
          cwd,
          status: 'idle',
          lastActivity: new Date().toISOString(),
          lastCommands: [{ command: 'done', timestamp: new Date().toISOString() }],
        },
      }];
    },
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.panels.length, 1);
  assert.equal(result.panels[0].review.state, 'complete');
  assert.ok(fs.existsSync(path.join(out, 'index.json')));
  assert.match(fs.readFileSync(path.join(out, 'index.md'), 'utf8'), /PANEL_SUMMARY/);
});

test('reviewPanels skips Claude transcript lookup for non-Claude panels', async () => {
  const cwd = tmpDir('non-claude-cwd');
  const out = tmpDir('non-claude-out');
  const result = await reviewPanels({
    outputDir: out,
    token: 'test-token',
    bases: ['http://td'],
    llmEnabled: false,
    claudeProjectsRoot: path.join(cwd, 'missing-claude-root'),
    fetchJson: async () => [{
      id: 'sid-codex',
      meta: {
        type: 'codex',
        project: 'pkachu',
        label: 'T1-CODEX',
        cwd,
        status: 'idle',
        lastActivity: new Date().toISOString(),
      },
    }],
  });

  assert.equal(result.panels[0].transcript.skipped, 'non-claude-panel');
  assert.equal(result.panels[0].transcript.found, false);
});

test('reviewPanels ignores Claude transcripts older than panel creation', async () => {
  const cwd = tmpDir('claude-cwd');
  const out = tmpDir('claude-out');
  const claudeRoot = tmpDir('claude-root');
  const projectDir = path.join(claudeRoot, cwd.replace(/\//g, '-'));
  fs.mkdirSync(projectDir, { recursive: true });
  const createdAt = new Date(Date.now() - 10_000).toISOString();
  const lastActivity = new Date().toISOString();
  const oldTranscript = path.join(projectDir, 'old.jsonl');
  fs.writeFileSync(oldTranscript, JSON.stringify({
    timestamp: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    type: 'assistant',
    message: { role: 'assistant', content: 'API Error 429 blocked old panel' },
  }) + '\n');
  const oldTime = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(oldTranscript, oldTime, oldTime);

  const result = await reviewPanels({
    outputDir: out,
    token: 'test-token',
    bases: ['http://td'],
    llmEnabled: false,
    claudeProjectsRoot: claudeRoot,
    fetchJson: async () => [{
      id: 'sid-claude',
      meta: {
        type: 'claude-code',
        project: 'provenspec',
        label: 'ProvenSpec-ORCH-CANARY',
        cwd,
        status: 'active',
        createdAt,
        lastActivity,
      },
    }],
  });

  assert.equal(result.panels[0].transcript.skipped, 'no-transcript-after-panel-created');
  assert.equal(result.panels[0].review.state, 'running');
});

test('collectArtifacts only recurses into result-oriented directories', () => {
  const cwd = tmpDir('artifacts');
  fs.mkdirSync(path.join(cwd, 'random-sprint'), { recursive: true });
  fs.mkdirSync(path.join(cwd, '.sprint'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'random-sprint', 'ORCH-RESULT.md'), 'VERDICT: COMPLETE\nnpm test passed\n');
  fs.writeFileSync(path.join(cwd, '.sprint', 'ORCH-RESULT.md'), 'VERDICT: COMPLETE\nnpm test passed\n');

  const artifacts = __test.collectArtifacts(cwd, { minMtimeMs: 0 });
  assert.equal(artifacts.length, 1);
  assert.match(artifacts[0].path, /\.sprint\/ORCH-RESULT\.md$/);
});
