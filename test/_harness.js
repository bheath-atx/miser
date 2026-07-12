'use strict';

// Offline test harness for the failover router. Provides a fake `res` and
// mock transport factories so the whole chain runs with ZERO sockets — no
// binding to or connecting through :20128, api.anthropic.com, api.openai.com,
// or Ollama. Nothing here opens a network handle.

// Minimal ServerResponse stand-in. writeHead() flips headersSent (mirrors Node),
// which is exactly the signal the router uses to decide whether it may fail over.
function makeRes() {
  const res = {
    headersSent: false,
    statusCode: null,
    headers: null,
    chunks: [],
    ended: false,
    writableEnded: false,
    writeHead(code, headers) {
      if (this.headersSent) throw new Error('writeHead called twice (headers already sent)');
      this.headersSent = true;
      this.statusCode = code;
      this.headers = headers || {};
      return this;
    },
    write(chunk) { this.chunks.push(String(chunk)); return true; },
    end(chunk) {
      if (chunk != null) this.chunks.push(String(chunk));
      this.ended = true;
      this.writableEnded = true;
      return this;
    },
    body() { return this.chunks.join(''); },
  };
  return res;
}

// A mock transport that "succeeds": writes headers + a marker body, resolves.
function successTransport(name, calls) {
  return function (...args) {
    const res = findRes(args);
    calls.push({ name, args });
    res.writeHead(200, { 'x-miser-provider': name });
    res.write(`ok:${name}`);
    res.end();
    return Promise.resolve();
  };
}

// A mock transport that "429s": rejects with statusCode without touching res
// (so the router sees headersSent=false and may fail over).
function failTransport(name, calls, statusCode = 429) {
  return function (...args) {
    calls.push({ name, args });
    const err = new Error(`${name} ${statusCode}`);
    err.statusCode = statusCode;
    return Promise.reject(err);
  };
}

// The router calls transports with different signatures; the `res` object is
// whichever argument is our fake res. Locate it structurally.
function findRes(args) {
  for (const a of args) {
    if (a && typeof a === 'object' && typeof a.writeHead === 'function' && 'headersSent' in a) return a;
  }
  throw new Error('mock transport: no res in args');
}

module.exports = { makeRes, successTransport, failTransport, findRes };
