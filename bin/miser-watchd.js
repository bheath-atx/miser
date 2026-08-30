#!/usr/bin/env node
'use strict';

const { createWatcher } = require('../src/watchd.js');
const config = require('../src/config.js');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function usage() {
  console.error('usage: miser-watchd [--once [probe_id]]');
}

async function main(argv) {
  const watcher = createWatcher(config.watch || {});
  const probes = watcher.listProbes();
  if (probes.length === 0) {
    console.error('[miser-watchd] no probes configured; set MISER_WATCH_PROBES');
    process.exitCode = 1;
    return;
  }

  if (argv[0] === '--once') {
    const id = argv[1];
    const results = id ? [await watcher.refreshProbe(id)] : await watcher.refreshAll();
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    return;
  }
  if (argv.length > 0) {
    usage();
    process.exitCode = 2;
    return;
  }

  const nextRun = new Map(probes.map(probe => [probe.id, 0]));
  for (;;) {
    const now = Date.now();
    for (const probe of probes) {
      if ((nextRun.get(probe.id) || 0) > now) continue;
      nextRun.set(probe.id, now + probe.interval_s * 1000);
      watcher.refreshProbe(probe.id)
        .then(result => {
          console.log(`[miser-watchd] probe=${probe.id} status=${result.status} in_flight=${result.in_flight === true}`);
        })
        .catch(err => {
          console.warn(`[miser-watchd] probe=${probe.id} error=${err.message}`);
        });
    }
    await sleep(1000);
  }
}

main(process.argv.slice(2)).catch(err => {
  console.error(`[miser-watchd] fatal: ${err.message}`);
  process.exit(1);
});
