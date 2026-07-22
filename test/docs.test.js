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
