'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function markdownFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...markdownFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

test('v4 D1: docs do not retain percentage-reduction compression claims', () => {
  const root = path.join(__dirname, '..');
  const bad = [];
  const claim = /([0-9]+\s*[-–]\s*[0-9]+%|[0-9]+%)[^\n]*(compression|compressed|reduction|savings)|(compression|compressed|reduction|savings)[^\n]*([0-9]+\s*[-–]\s*[0-9]+%|[0-9]+%)/i;
  for (const file of markdownFiles(root)) {
    const rel = path.relative(root, file);
    const lines = fs.readFileSync(file, 'utf8').split(/\n/);
    lines.forEach((line, i) => {
      if (claim.test(line)) bad.push(`${rel}:${i + 1}: ${line}`);
    });
  }
  assert.deepEqual(bad, []);
});

// AR21 — the README env table documents alert routing.
//
// The AC calls this a review-gate item because docs.test.js checks a different
// rule. It is cheap to make it a test result instead, and a review gate only
// holds for the review it was written for: the variable set is DERIVED from
// what src/ actually reads, so a routing env var added later fails here rather
// than silently shipping undocumented.
test('AR21: every MISER_ALERT_ROUTES* var src/ reads is documented in README.md', () => {
  const root = path.join(__dirname, '..');
  const srcDir = path.join(root, 'src');
  const referenced = new Set();
  for (const f of fs.readdirSync(srcDir).filter(n => n.endsWith('.js'))) {
    const text = fs.readFileSync(path.join(srcDir, f), 'utf8');
    for (const m of text.matchAll(/MISER_ALERT_ROUTES[A-Z_]*/g)) referenced.add(m[0]);
  }
  assert.ok(referenced.size >= 6, `expected the 6 routing vars, found ${referenced.size}`);

  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const undocumented = [...referenced].filter(v => !new RegExp(`\`${v}\``).test(readme)).sort();
  assert.deepEqual(undocumented, [], 'add these to the README env table');

  // MISER_PKACHU_* is no longer only the rollup channel — it is the default
  // alert route, and describing it as rollup-only is what made the 2026-07-29
  // misrouting incident hard to see coming.
  assert.match(readme, /`MISER_PKACHU_ENDPOINT`[^\n|]*\|[^\n]*default route/i,
    'MISER_PKACHU_ENDPOINT must be restated as the default route, not rollup-only');

  // The §2.5 operator warning and its recovery step (Codex made this a
  // condition of approving that fatality, CODEX-IQA-R3.md:39).
  assert.match(readme, /block miser from starting even when\s*\n?>?\s*`MISER_ALERT_ROUTES` is unset/,
    'the ops-route startup warning must be present');
  assert.match(readme, /unset MISER_ALERT_ROUTES_OPS/, 'the warning must carry its recovery step');

  // The §2.4a destination-class contract, so another sprint can find it here.
  for (const spelling of ["{ scope: 'fleet' }", "{ scope: 'ops' }", "{ project: 'structural360' }"]) {
    assert.ok(readme.includes(spelling), `destination-class contract must show ${spelling}`);
  }
});
