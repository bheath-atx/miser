#!/usr/bin/env node
'use strict';

const { reviewPanels, markdownReport } = require('../src/panel-review.js');

function usage() {
  console.error('usage: miser-panel-review [--json] [--no-llm] [--output-dir DIR] [--bases URLS]');
}

async function main(argv) {
  const opts = {};
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') {
      json = true;
    } else if (arg === '--no-llm') {
      opts.llmEnabled = false;
    } else if (arg === '--output-dir') {
      opts.outputDir = argv[++i];
    } else if (arg === '--bases') {
      opts.bases = argv[++i];
    } else if (arg === '-h' || arg === '--help') {
      usage();
      return;
    } else {
      usage();
      process.exitCode = 2;
      return;
    }
  }

  const result = await reviewPanels(opts);
  process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : markdownReport(result));
  if (result.status !== 'ok') process.exitCode = 1;
}

main(process.argv.slice(2)).catch(err => {
  console.error(`[miser-panel-review] fatal: ${err.message}`);
  process.exit(1);
});
