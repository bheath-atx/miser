'use strict';

const ECS_SUCCESS = '✓ ecs: no issues';
const ECS_CLEAN = '[OK] No errors found. Great job - your code is shiny in style!\n';

// Exact 3,808-byte CODEX-IQA-R14 witness (ecs-failing-dry-run.txt).
// ECS 2f32f1c ConsoleOutputFormatter emits numbered diffs and this warning;
// a quote fix can legitimately carry RTK's success literal in application data.
function failingEcsDryRun() {
  return [
    '1) src/Status.php', '', '    ---------- begin diff ----------', '@@ -1,49 +1,49 @@', ' <?php',
    ...Array.from({ length: 48 }, (_, i) => `-echo "No errors found for item ${i}";`),
    ...Array.from({ length: 48 }, (_, i) => `+echo 'No errors found for item ${i}';`),
    '    ----------- end diff -----------', '', 'Applied checkers:',
    ' * PhpCsFixer\\Fixer\\StringNotation\\SingleQuoteFixer', '',
    '[WARNING] 1 error is fixable! Just add "--fix" to console command and rerun to apply.', '',
  ].join('\n');
}

// Source-derived runner, NOT execution of ECS or RTK. This projects RTK
// 79347d5 src/cmds/php/{ecs_cmd.rs,utils.rs} for these fixtures, including the
// faulty unconditional success-literal branch. Miser must reject its output.
function sourceDerivedEcs(raw) {
  const cleaned = raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  if (cleaned.includes('No errors found')) return ECS_SUCCESS;
  const kept = cleaned.split('\n').map(line => line.trim()).filter(line =>
    line && ['.php', 'ERROR', 'FAIL', 'Fixed', 'checked', 'files'].some(marker => line.includes(marker)));
  return kept.length ? kept.join('\n') : cleaned.trim() || 'ok';
}

module.exports = { ECS_SUCCESS, ECS_CLEAN, failingEcsDryRun, sourceDerivedEcs };
