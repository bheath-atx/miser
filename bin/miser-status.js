#!/usr/bin/env node
'use strict';

const { createWatcher } = require('../src/watchd.js');
const config = require('../src/config.js');

const watcher = createWatcher(config.watch || {});
process.stdout.write(`${JSON.stringify({ watch: watcher.status() }, null, 2)}\n`);
