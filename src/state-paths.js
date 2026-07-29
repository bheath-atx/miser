'use strict';

const os = require('node:os');
const path = require('node:path');

function homeDefault(...parts) {
  return path.join(os.homedir(), ...parts);
}

function rejectTestHomeDefault(kind, envName, defaultPath) {
  if (process.env.MISER_TEST_STATE_GUARD === '1') {
    const err = new Error(
      `[miser/test-state-guard] ${kind} resolved to HOME default ${defaultPath}; set ${envName}`
    );
    err.code = 'MISER_TEST_HOME_DEFAULT';
    throw err;
  }
  return defaultPath;
}

function envOrHomeDefault(envName, kind, ...homeParts) {
  const configured = process.env[envName];
  if (configured) return configured;
  const fallback = homeDefault(...homeParts);
  return rejectTestHomeDefault(kind, envName, fallback);
}

module.exports = { envOrHomeDefault, homeDefault };
