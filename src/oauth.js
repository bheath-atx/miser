'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Subscription OAuth bearer provider for the Codex/OpenAI failover path.
//
// User decision (locked): Anthropic-429 failover must use the Codex/OpenAI
// SUBSCRIPTION OAuth token, NOT the metered OPENAI_API_KEY. The Codex CLI stores
// its subscription session at ~/.codex/auth.json:
//   { auth_mode, OPENAI_API_KEY, tokens: { id_token, access_token,
//     refresh_token, account_id }, last_refresh }
// We read ONLY tokens.access_token (+ tokens.account_id). OPENAI_API_KEY is
// deliberately ignored — reading it here would defeat the whole decision.
//
// Fail closed: if the file is missing, unreadable, malformed, or has no
// access_token, we throw. Callers treat that as "Codex unavailable" and fall
// through to the hard-capped Ollama path. We never emit a request with no /
// bogus bearer.
//
// Testability: the reader is injected. Tests pass a fake readFile and NEVER
// touch the real ~/.codex/auth.json. The real path is only ever read through
// the default production provider.

const DEFAULT_AUTH_PATH = process.env.CODEX_AUTH_PATH
  || path.join(os.homedir(), '.codex', 'auth.json');

class OAuthUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OAuthUnavailableError';
    this.statusCode = 401; // treated as transient-unavailable → Ollama fallback
  }
}

// Pure extractor — no I/O. Given parsed auth.json contents, returns the bearer
// or throws OAuthUnavailableError. Exported for direct unit testing.
function extractBearer(auth) {
  if (!auth || typeof auth !== 'object') {
    throw new OAuthUnavailableError('codex auth: empty/invalid auth object');
  }
  const tokens = auth.tokens;
  if (!tokens || typeof tokens !== 'object') {
    throw new OAuthUnavailableError('codex auth: no tokens object');
  }
  const token = tokens.access_token;
  if (!token || typeof token !== 'string' || token.trim() === '') {
    throw new OAuthUnavailableError('codex auth: no access_token (fail closed)');
  }
  return { token: token.trim(), accountId: tokens.account_id || null };
}

// Build a bearer provider. opts.readFile lets tests inject a fake reader; it is
// called as readFile(pathString) and must return the file contents as a string
// (or throw to simulate a missing file). Production uses fs.readFileSync.
function makeBearerProvider(opts = {}) {
  const authPath = opts.authPath || DEFAULT_AUTH_PATH;
  const readFile = opts.readFile || ((p) => fs.readFileSync(p, 'utf8'));

  return function getBearer() {
    let raw;
    try {
      raw = readFile(authPath);
    } catch (e) {
      throw new OAuthUnavailableError(`codex auth: cannot read ${authPath}: ${e.code || e.message}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new OAuthUnavailableError(`codex auth: malformed JSON at ${authPath}`);
    }
    return extractBearer(parsed);
  };
}

// Default production provider (reads the real ~/.codex/auth.json). This is the
// ONLY place the real file is ever read.
const getCodexBearer = makeBearerProvider();

module.exports = { getCodexBearer, makeBearerProvider, extractBearer, OAuthUnavailableError, DEFAULT_AUTH_PATH };
