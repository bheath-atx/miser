'use strict';

// Shared with the real-binary admission gate: keep the actual warning paths
// that RTK 79347d5 drops, so fidelity tests cannot silently use a friendlier input.
function failingPrettierCheck() {
  const lines = [];
  for (let i = 0; i < 200; i++) lines.push(`[warn] src/file_${String(i).padStart(3, '0')}.ts`);
  lines.push('[warn] Code style issues found in the above file(s). Run Prettier to fix.');
  return lines.join('\n');
}

// Exact colored-YAML witness from CODEX-IQA-R9.md (Prettier 3.6.2).
function coloredYamlPrettierCheck() {
  const warn = '[\x1b[33mwarn\x1b[39m] ';
  return 'Checking formatting...\n'
    + Array.from({ length: 100 }, (_, i) => `${warn}config/file_${String(i).padStart(3, '0')}.yaml\n`).join('')
    + `${warn}Code style issues found in 100 files. Run Prettier with --write to fix.\n`;
}

module.exports = { failingPrettierCheck, coloredYamlPrettierCheck };
