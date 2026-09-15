'use strict';

// miser RTK pre-context output filter (PROPOSAL-RTK-ONLY.md).
//
// Before miser forwards a request upstream, eligible `tool_result` blocks are
// replaced by RTK's structured summary of the same output. RTK is a local Rust
// binary invoked as `rtk pipe --filter <id>`: it reads raw output on stdin and
// writes a filtered summary on stdout. No daemon, no network, no persistent
// state, no runtime dependency added to miser.
//
// THE PRECONDITION (§3, INV-DET). Prompt caching requires the forwarded prefix
// to be byte-identical across requests, and miser is stateless per request —
// Claude Code resends the full raw history every time and proxy.js reparses it.
// So any transform applied here must be a TOTAL FUNCTION OF THE BLOCK'S OWN
// BYTES, recomputed identically on every request:
//
//     forwarded = f(content, filterId, rtkVersion, epoch)
//
// Two env-level controls establish that against RTK's own hidden state (§3):
//   Control 1 — RTK_RECALL=0 / RTK_TEE=0. tee.rs:7-13 short-circuits BEFORE
//     Config::load(), so every recovery-hint path returns None unconditionally.
//     This removes the SQLite store (retriever.rs:478-480 maps a write failure
//     to Unavailable, which DROPS the hint → same input, different bytes) and
//     the wall-clock-timestamped tee filenames (tee_file.rs:143-144,252-254).
//   Control 2 — an absolute, empty, READ-ONLY XDG_CONFIG_HOME plus a
//     SEPARATELY PINNED neutral cwd. config.rs:458-460 resolves the config path
//     from dirs::config_dir(); Config::load() (:278-285) returns
//     Config::default() when it does not exist, so Config::load() becomes a
//     constant on every spawn. cwd is pinned separately rather than assumed to
//     follow (IQA-R4).
//
// `epoch` changes at most once per process lifetime: the first filter fault of
// any kind latches the whole feature off (§6.2). It is one observable, alerted,
// one-way transition — not a per-block coin flip.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ---------------------------------------------------------------------------
// §4 Phase 1 filter allowlist.
//
// Derived by sweep, not asserted. The disqualifying pattern is a NON-TOTAL SORT
// — sorting on a count or length with no tiebreak leaves tied entries in
// randomized HashMap order, which differs per process and therefore differs on
// every `rtk pipe` spawn. Excluded for that reason: log, ruff-check,
// ruff-format, tsc, mypy, cargo-test. Excluded for other reasons: go-test
// (fidelity, §5), pint (reads current_dir), sqlfluff-lint/phpstan (multiple
// uncleared maps), vitest (config read on the JSON-parse-failure branch), and
// `find` (a deliberate scope choice, not a non-total-sort exclusion — IQA-R4
// MINOR F1).
//
// `signature` is the §5.1 FIDELITY GATE: a filter runs only if the raw output
// matches that filter's declared input signature. It is a pure function of the
// raw bytes, so it cannot weaken INV-DET. It exists because RTK's own
// `never_worse` guard protects SIZE, never FIDELITY — go_cmd.rs:405-406 reports
// "Go test: No tests found" for ordinary non-JSON output from a FAILING build,
// and prefers that answer because it is smaller.
//
// `heads` are the shell command heads that map to this filter id. They are
// matched against the PAIRED tool_use's command, never against output.

// One anchored attempt per line, including every ECMAScript line terminator.
// Multiline ^ with a class that consumes those terminators retries overlapping
// suffixes on rejection (SG1). These patterns have no /m or overlapping
// quantifiers, so each attempt is bounded by this one line's length.
function lineSignature(pattern) {
  return {
    test(text) {
      return text.split(/\r\n|[\n\r\u2028\u2029]/).some(line => pattern.test(line));
    },
  };
}

const FILTER_SPECS = Object.freeze({
  // rtk resolve_filter: `pytest`
  pytest: {
    heads: ['pytest', 'py.test'],
    // A fixed === prefix leaves all remaining equals/text to ONE scan. Using
    // ={3,}.* would repartition a failed equals run quadratically on one line.
    signature: lineSignature(/^(?:===.*(?:test session starts|FAILURES|ERRORS|short test summary info)|platform \w+ -- Python |collected \d+ item)/),
  },
  // rtk resolve_filter: `prettier`
  prettier: {
    heads: ['prettier'],
    signature: /^(?:\[(?:warn|error)\]|Checking formatting|Code style issues found)/m,
    // RTK 79347d5 excludes [warn] paths and can report success on a failing
    // --check. Preserve these raw signals and recognize its faithful summary.
    // Applied to one normalized, left-trimmed line at a time.
    failureSignature: /^(?:\[(?:warn|error)\]|Code style issues found\b|Prettier:\s+[1-9]\d* files? need formatting\b)/,
  },
  // rtk resolve_filter: `phpunit`
  phpunit: {
    heads: ['phpunit'],
    signature: /^(?:PHPUnit \d|OK \(\d+ test|FAILURES!|ERRORS!|Tests:\s+\d)/m,
  },
  // rtk resolve_filter: `pest` | `paratest` | `php-test` are ALIASES of one
  // filter upstream, but they are distinct allowlist entries here so an
  // operator can admit them independently (§4: the allowlist is config).
  pest: {
    heads: ['pest'],
    signature: /^(?:PHPUnit \d|OK \(\d+ test|FAILURES!|ERRORS!|Tests:\s+\d)/m,
  },
  paratest: {
    heads: ['paratest'],
    signature: /^(?:PHPUnit \d|OK \(\d+ test|FAILURES!|ERRORS!|Tests:\s+\d)/m,
  },
  'php-test': {
    heads: ['php-test'],
    signature: /^(?:PHPUnit \d|OK \(\d+ test|FAILURES!|ERRORS!|Tests:\s+\d)/m,
  },
  // rtk resolve_filter: `ecs`
  ecs: {
    heads: ['ecs'],
    signature: lineSignature(/^(?:\[ERROR\]|Found \d+ error|\s*\d+\) )/),
    // RTK 79347d5 treats "No errors found" anywhere (even in a diff) as
    // success. ECS ConsoleOutputFormatter's numbered diffs, error counts and
    // fixable warnings must survive that branch. Match one normalized,
    // left-trimmed line at a time; zero counts and clean [OK] output are safe.
    failureSignature: /^(?:\[(?:ERROR|WARNING)\]|\d+\) |Found [1-9]\d* errors?\b|(?:Good news is that )?[1-9]\d* errors? (?:is|are) fixable!|---------- begin diff ----------)/,
  },
  // rtk resolve_filter: `grep` | `rg`. grep_wrapper (pipe_cmd.rs:88-123) splits
  // each line with splitn(3, ':') and only counts it when part 2 parses as a
  // usize — i.e. it needs `path:line:text`, which is grep -n / rg default form.
  // Without line numbers RTK returns the input VERBATIM, so the signature gate
  // encodes exactly that precondition rather than spawning for a guaranteed
  // no-op.
  grep: {
    heads: ['grep', 'egrep', 'fgrep'],
    signature: lineSignature(/^[^:]+:\d+:/),
  },
  rg: {
    heads: ['rg'],
    signature: lineSignature(/^[^:]+:\d+:/),
  },
});

const PHASE1_FILTERS = Object.freeze(Object.keys(FILTER_SPECS));

// Version declared by the source pin (the commit itself is a build-time pin):
// https://github.com/rtk-ai/rtk/blob/79347d5/Cargo.toml#L3
const PINNED_RTK_VERSION = '0.48.0';

// §5.2 failure-signal preservation. If raw carries any of these and the
// filtered output carries none, the filtered output is DISCARDED and raw is
// forwarded. A filter may shrink output; it may never make a failure look like
// a success.
const FAILURE_MARKERS = Object.freeze([
  'FAIL', 'panic:', 'Error', 'error:', 'exit status', 'Traceback', '✗',
]);

// F2 (CODEX-IQA-RTK-ONLY.md:52-58). RTK's own filter-panic handling
// (pipe_cmd.rs:244-249,281-284) catches the panic with catch_unwind, prints
// this warning to stderr, and returns the RAW input with SUCCESS — main.rs
// returns exit code 0, and pipe_cmd.rs:606-612 asserts that passthrough is
// intended behaviour. So a panicking filter is NOT visible in the exit code,
// and the proposal's §6.1 claim that "non-zero exit, timeout, missing binary
// and non-UTF8 output are all directly observable" is true only for those four.
// This adapter therefore treats the named stderr warning as a FIFTH fault kind
// so a panicking filter still trips the latch instead of silently degrading to
// an unfiltered no-op on every request. Matched loosely (the upstream string
// carries an em dash) so an encoding difference cannot defeat detection.
const RTK_PANIC_WARNING = /\[rtk\]\s*warning:\s*filter\s+panicked/i;

// ---------------------------------------------------------------------------
// §2.3 Identity — adopted from compress.js BY COPY, NOT BY IMPORT.
//
// compress.js exports neither `canonicalize` nor `dedupKey` (compress.js
// module.exports), and §7 of this sprint RETIRES `dedupKey` outright. Copying
// rather than importing is deliberate beyond mere access: the forwarded bytes
// of a cached prefix must not change because an unrelated edit to compress.js's
// dedup identity changed a key. RTK owns its own identity.
//
// Recursively sort object keys so two semantically-equal values stringify to
// the SAME canonical string (block field order can differ between turns).
function canonicalize(v) {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canonicalize(v[k]);
    return out;
  }
  return v;
}

// Memo/identity key for one filtered block: paired tool name + canonicalized
// paired input + the block MINUS `tool_use_id` + filterId + rtkVersion.
//
// `tool_use_id` is only a pairing pointer and legitimately varies between two
// otherwise-identical results, so it is excluded. EVERY other semantic field
// participates: a differing field → a different key → both computed
// separately. A false-distinct is safe; a false-identical is impossible.
function memoKeyFor(pairedName, pairedInput, block, filterId, rtkVersion) {
  const { tool_use_id, ...semantic } = block;
  return 'rtk:' + JSON.stringify(canonicalize([pairedName, pairedInput, semantic, filterId, rtkVersion]));
}

// ---------------------------------------------------------------------------
// Eligibility (§2.2)

// Command-head extraction is deliberately CONSERVATIVE and total. Any command
// carrying shell metacharacters is ineligible: in `grep -n foo | head -20` the
// tool_result holds head's output, not grep's, so the paired command head is
// not a sound claim about what produced the bytes. Same for redirection,
// substitution, and leading `VAR=x` env assignments.
const SHELL_META = /[|;&<>`$(){}\n\\]/;

function commandHeadOf(pairedInput) {
  if (!pairedInput || typeof pairedInput !== 'object') return null;
  const cmd = pairedInput.command;
  if (typeof cmd !== 'string') return null;
  const trimmed = cmd.trim();
  if (!trimmed) return null;
  if (SHELL_META.test(trimmed)) return null;
  const first = trimmed.split(/\s+/)[0];
  if (!first || first.includes('=')) return null;
  const base = path.basename(first);
  return base || null;
}

function buildHeadIndex(allowedFilters) {
  const index = new Map();
  for (const filterId of allowedFilters) {
    const spec = FILTER_SPECS[filterId];
    if (!spec) continue;
    for (const head of spec.heads) {
      // First allowlisted filter claiming a head wins; iteration order is the
      // configured allowlist order, which is config, so this stays total.
      if (!index.has(head)) index.set(head, filterId);
    }
  }
  return index;
}

// A tool_result's content is filterable only when replacing it is provably
// shape-preserving: a plain string, or an array holding exactly one text block.
// Collapsing a multi-block or image/document array would change the block TYPE
// (the same boundary compress.js draws at isStubbableToolResult).
function readableContent(block) {
  if (typeof block.content === 'string') {
    return { kind: 'string', text: block.content };
  }
  if (Array.isArray(block.content) && block.content.length === 1) {
    const only = block.content[0];
    if (only && only.type === 'text' && typeof only.text === 'string') {
      return { kind: 'block', text: only.text, block: only };
    }
  }
  return null;
}

function writeContent(block, shape, text) {
  if (shape.kind === 'string') return { ...block, content: text };
  return { ...block, content: [{ ...shape.block, text }] };
}

function hasFailureMarker(text, filterId) {
  // Strip CSI controls, including Prettier's SGR colors inside [warn]/[error],
  // only for detection; forwarding and memo identity retain the original bytes.
  // The disjoint byte ranges cannot consume another escape introducer, so even
  // interrupted/unterminated controls take linear time to scan.
  const normalized = text.replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, '');
  for (const marker of FAILURE_MARKERS) {
    if (normalized.includes(marker)) return true;
  }
  const signature = FILTER_SPECS[filterId]?.failureSignature;
  if (!signature) return false;
  // Never combine multiline ^ with \s*: blank lines would retry every newline
  // suffix. Each line has exactly one anchored attempt, bounded by its length.
  return normalized.split(/\r\n|[\n\r\u2028\u2029]/).some(line => signature.test(line.trimStart()));
}

// ---------------------------------------------------------------------------
// §9 config surface

function truthy(v) {
  return /^(1|true|on|yes)$/i.test(String(v == null ? '' : v));
}

function intFromEnv(raw, fallback) {
  const n = parseInt(raw == null || raw === '' ? String(fallback) : String(raw), 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseFilterList(raw) {
  if (raw == null || String(raw).trim() === '') return [...PHASE1_FILTERS];
  const out = [];
  for (const piece of String(raw).split(',')) {
    const id = piece.trim();
    if (!id) continue;
    if (!FILTER_SPECS[id]) {
      console.warn(`[miser] rtk: ignoring unknown filter id "${id}" in MISER_RTK_FILTERS`);
      continue;
    }
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

// The jail: an absolute, empty, read-only XDG_CONFIG_HOME and a SEPARATELY
// pinned neutral cwd (§3 Control 2, §9 spawn contract). Both are created
// lazily, on first spawn only — config.js is loaded by every test and every
// CLI entry point and must never touch the filesystem at module load.
function parseRtkConfig(env = process.env) {
  const jailBase = env.MISER_RTK_JAIL_DIR || path.join(os.tmpdir(), 'miser-rtk-jail');
  return {
    // Both switches must be ON. MISER_TIER_B_OUTPUT_TRIM is the umbrella kill
    // switch (§9, §11: "unset MISER_RTK_FILTER *or* the MISER_TIER_B_OUTPUT_TRIM
    // umbrella"), so unsetting EITHER disables the feature. This also makes the
    // umbrella flag actually read, which config.js:80 declared but never was.
    enabled: truthy(env.MISER_RTK_FILTER) && truthy(env.MISER_TIER_B_OUTPUT_TRIM),
    bin: env.MISER_RTK_BIN || 'rtk',
    // Empty/unset keeps the source pin's version; verification is mandatory.
    version: String(env.MISER_RTK_VERSION || '').trim() || PINNED_RTK_VERSION,
    filters: parseFilterList(env.MISER_RTK_FILTERS),
    minBytes: intFromEnv(env.MISER_RTK_MIN_BYTES, 2048),
    maxBytes: intFromEnv(env.MISER_RTK_MAX_BYTES, 1048576),
    minGainBytes: intFromEnv(env.MISER_RTK_MIN_GAIN_BYTES, 256),
    timeoutMs: intFromEnv(env.MISER_RTK_TIMEOUT_MS, 5000),
    memoEntries: intFromEnv(env.MISER_RTK_MEMO_ENTRIES, 2048),
    // pipe_cmd.rs exposes `-f`; main.rs defines the long form. Kept as config
    // so a flag-surface change at a different RTK pin is an env change rather
    // than a code change.
    filterFlag: env.MISER_RTK_FILTER_FLAG || '--filter',
    configHome: env.MISER_RTK_CONFIG_HOME || path.join(jailBase, 'config'),
    cwd: env.MISER_RTK_CWD || path.join(jailBase, 'cwd'),
  };
}

// ---------------------------------------------------------------------------
// §6.2 The latch — PROCESS-WIDE, one-way, alerted.
//
// IQA-R3 MAJOR C1 was against RTK: a per-block raw fallback on fault meant a
// block could forward raw on one request and filtered on the next,
// indefinitely. The fix is that the FIRST fault of any kind disables the
// feature for the remainder of the process. Forwarded bytes are then
// f(content, filter, rtkVersion, epoch) where epoch changes AT MOST ONCE per
// process lifetime. This does not make the transition free; it makes it
// bounded and observable.
const _latch = { tripped: false, reason: null, trips: 0 };

function latchState() {
  return { tripped: _latch.tripped, reason: _latch.reason, trips: _latch.trips };
}

function tripLatch(reason, onAlert) {
  if (_latch.tripped) return false;
  _latch.tripped = true;
  _latch.reason = reason;
  _latch.trips += 1;
  console.warn(`[miser] rtk: filter fault (${reason}) — RTK output filtering DISABLED for this process`);
  if (typeof onAlert === 'function') {
    try { onAlert({ reason }); } catch (e) {
      console.warn('[miser] rtk: latch alert error:', e.message);
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Default spawn runner. Injected through the `deps` seam in tests, so the whole
// suite runs offline with zero subprocesses.

let _jailReady = false;
function ensureJail(cfg) {
  if (_jailReady) return;
  fs.mkdirSync(cfg.configHome, { recursive: true, mode: 0o700 });
  fs.mkdirSync(cfg.cwd, { recursive: true, mode: 0o700 });
  // Read-only AFTER creation: mkdir with 0o500 would forbid creating the dir's
  // own contents on a later recursive call.
  try { fs.chmodSync(cfg.configHome, 0o500); } catch (_) { /* best effort */ }
  _jailReady = true;
}

// §9 spawn contract — FIXED, not tunable.
function spawnEnv(cfg) {
  return {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: cfg.cwd,
    XDG_CONFIG_HOME: cfg.configHome,
    RTK_RECALL: '0',
    RTK_TEE: '0',
    RTK_TELEMETRY_DISABLED: '1',
    RTK_NO_TOML: '1',
    LANG: 'C',
    LC_ALL: 'C',
  };
}

function runProcess(cfg, args, input) {
  return new Promise(resolve => {
    let child;
    try {
      ensureJail(cfg);
      child = spawn(cfg.bin, args, {
        cwd: cfg.cwd,
        env: spawnEnv(cfg),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ spawnError: err.message, code: null, stdout: '', stderr: '', timedOut: false });
      return;
    }

    const outChunks = [];
    const errChunks = [];
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch (_) { /* already gone */ }
    }, cfg.timeoutMs);

    const finish = payload => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(payload);
    };

    child.stdout.on('data', c => outChunks.push(c));
    child.stderr.on('data', c => errChunks.push(c));
    child.on('error', err => finish({ spawnError: err.message, code: null, stdout: '', stderr: '', timedOut }));
    child.on('close', code => {
      const stdoutBuf = Buffer.concat(outChunks);
      // Non-UTF8 output is a fault, not a lossy decode: a replacement character
      // would be forwarded upstream as real content.
      const stdout = stdoutBuf.toString('utf8');
      const invalidUtf8 = Buffer.compare(Buffer.from(stdout, 'utf8'), stdoutBuf) !== 0;
      finish({
        code,
        stdout,
        stderr: Buffer.concat(errChunks).toString('utf8'),
        timedOut,
        invalidUtf8,
      });
    });

    child.stdin.on('error', () => { /* EPIPE when the child exits early */ });
    child.stdin.end(input, 'utf8');
  });
}

function defaultRunFilter(cfg, filterId, input) {
  return runProcess(cfg, ['pipe', cfg.filterFlag, filterId], input);
}

function defaultRunVersion(cfg) {
  return runProcess(cfg, ['--version'], '');
}

// ---------------------------------------------------------------------------
// The filter

// §6.3 The memo is a PURE IN-MEMORY LATENCY OPTIMIZATION: LRU, no durability,
// no single-flight, no tombstones. A miss recomputes the same bytes.
//
// Equivalence claim, precisely scoped: with ZERO filter faults, memo on and
// memo off produce byte-identical forwarded output. Under a fault they are NOT
// equivalent — a warm hit returns compressed bytes while a cold path can fault,
// return raw, and trip the latch. The latch bounds that divergence; it does not
// erase it. Both halves are pinned by test (§10.2(6) and (7)).
//
// Only DETERMINISTIC decisions are memoized. A fault-derived "raw" is never
// stored, because it is not a function of the input.
function createMemo(maxEntries) {
  const map = new Map();
  return {
    get(key) {
      if (maxEntries <= 0) return undefined;
      if (!map.has(key)) return undefined;
      const v = map.get(key);
      map.delete(key);
      map.set(key, v); // LRU touch
      return v;
    },
    set(key, value) {
      if (maxEntries <= 0) return;
      if (map.has(key)) map.delete(key);
      map.set(key, value);
      while (map.size > maxEntries) map.delete(map.keys().next().value);
    },
    get size() { return map.size; },
  };
}

function emptyStats() {
  return {
    blocksFiltered: 0,
    blocksRawPinned: 0,
    memoHits: 0,
    latchTrips: 0,
    bytesRemoved: 0,
    estRemovedTokens: 0,
  };
}

function createOutputFilter(cfg, deps = {}) {
  const runFilter = deps.runFilter || ((filterId, input) => defaultRunFilter(cfg, filterId, input));
  const runVersion = deps.runVersion || (() => defaultRunVersion(cfg));
  const onAlert = deps.onAlert || null;
  const memo = createMemo(cfg.memoEntries);
  const headIndex = buildHeadIndex(cfg.filters);
  const expectedVersion = String(cfg.version || '').trim() || PINNED_RTK_VERSION;
  let versionCheck = null;

  // §9: MISER_RTK_VERSION participates in the memo key and a mismatch refuses
  // to enable. DEVIATION, flagged: the check is LAZY (first spawn) rather than
  // at process startup, because config.js is required by every test file and
  // every CLI entry point and must not spawn a subprocess at module load. The
  // guarantee is the same — no filtered bytes are ever produced by an
  // unverified binary — it is only the moment of discovery that moves.
  async function ensureVersion() {
    if (_latch.tripped) return false;
    // All concurrent requests share the probe, including its unresolved state.
    // Starting verification must never be mistaken for completing it.
    if (!versionCheck) {
      versionCheck = (async () => {
        let result;
        try {
          result = await runVersion();
        } catch (_) {
          tripLatch('version-probe-failed', onAlert);
          return false;
        }
        if (faultReason(result)) {
          tripLatch('version-probe-failed', onAlert);
          return false;
        }
        if (result.stdout.trim() !== `rtk ${expectedVersion}`) {
          tripLatch('version-mismatch', onAlert);
          return false;
        }
        return true;
      })();
    }
    return (await versionCheck) && !_latch.tripped;
  }

  // Classify a completed run. Returns a fault reason, or null on success.
  // The FIFTH kind (rtk-panic) is the F2 fold-in: a caught filter panic exits 0
  // with the raw input on stdout and only a stderr warning to show for it.
  function faultReason(result) {
    if (!result || typeof result !== 'object') return 'runner-contract';
    if (result.spawnError) return 'spawn-error';
    if (result.timedOut) return 'timeout';
    if (result.code !== 0) return 'nonzero-exit';
    if (result.invalidUtf8) return 'non-utf8';
    if (typeof result.stdout !== 'string') return 'runner-contract';
    if (RTK_PANIC_WARNING.test(String(result.stderr || ''))) return 'rtk-panic';
    return null;
  }

  // Decide the forwarded text for ONE eligible block. Returns
  // { text } for a filtered result, or null to forward raw.
  // Every rejection here is a pure function of the raw/filtered pair.
  function accept(raw, filtered, filterId) {
    if (typeof filtered !== 'string' || filtered.length === 0) return null;
    const rawBytes = Buffer.byteLength(raw, 'utf8');
    const outBytes = Buffer.byteLength(filtered, 'utf8');
    // §8: MISER_RTK_MIN_GAIN_BYTES is a heuristic that avoids worthless
    // rewrites and the tie-inflation window — NOT token evidence. miser has no
    // tokenizer, so a byte gain does not prove fewer provider tokens.
    if (rawBytes - outBytes < cfg.minGainBytes) return null;
    // §5.2 failure-signal preservation.
    if (hasFailureMarker(raw, filterId) && !hasFailureMarker(filtered, filterId)) return null;
    return { text: filtered };
  }

  // Apply to a message array. Returns a NEW array when anything changed; the
  // input array and every object in it are treated as immutable (proxy.js
  // deep-freezes originalBody, and compress() may hand back the client's own
  // message objects on its §3.5 revert path).
  async function applyToMessages(messages) {
    const stats = emptyStats();
    if (!Array.isArray(messages) || messages.length === 0) {
      return { messages, changed: false, stats };
    }

    let changed = false;
    const out = messages.slice();

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg || msg.role !== 'user' || !Array.isArray(msg.content)) continue;

      // §2.2(1): pairing is adjacency-based, exactly as compress.js requires it
      // — the answering tool_use must be in the IMMEDIATELY PRECEDING assistant
      // turn. An unpaired tool_result is NEVER filtered (same fail-safe).
      const prev = messages[i - 1];
      const useById = new Map();
      if (prev && prev.role === 'assistant' && Array.isArray(prev.content)) {
        for (const b of prev.content) {
          if (b && b.type === 'tool_use') useById.set(b.id, { name: b.name, input: b.input });
        }
      }
      if (useById.size === 0) continue;

      let msgChanged = false;
      const newContent = msg.content.slice();

      for (let j = 0; j < msg.content.length; j++) {
        const block = msg.content[j];
        if (!block || block.type !== 'tool_result') continue;

        const pair = useById.get(block.tool_use_id);
        if (!pair) continue; // un-locatable pairing → forward raw, no lookup

        const head = commandHeadOf(pair.input);
        if (!head) continue;
        const filterId = headIndex.get(head);
        if (!filterId) continue;

        const shape = readableContent(block);
        if (!shape) continue;

        const raw = shape.text;
        const rawBytes = Buffer.byteLength(raw, 'utf8');
        if (rawBytes < cfg.minBytes || rawBytes > cfg.maxBytes) continue;

        // §5.1 signature gate — before any spawn.
        if (!FILTER_SPECS[filterId].signature.test(raw)) continue;

        // Everything below this line is an ELIGIBLE block: it either gets
        // filtered or is explicitly pinned raw, and both outcomes are counted.
        if (_latch.tripped) {
          stats.blocksRawPinned += 1;
          continue;
        }

        const key = memoKeyFor(pair.name, pair.input, block, filterId, expectedVersion);
        let decision = memo.get(key);
        if (decision !== undefined) {
          stats.memoHits += 1;
        } else {
          if (!(await ensureVersion()) || _latch.tripped) {
            stats.latchTrips = _latch.trips;
            stats.blocksRawPinned += 1;
            continue;
          }
          let result;
          try {
            result = await runFilter(filterId, raw);
          } catch (err) {
            result = { spawnError: err.message, code: null, stdout: '', stderr: '', timedOut: false };
          }
          const fault = faultReason(result);
          if (fault) {
            tripLatch(fault, onAlert);
            stats.latchTrips = _latch.trips;
            stats.blocksRawPinned += 1;
            continue; // fault-derived raw is NEVER memoized
          }
          // Another request may have disabled RTK while this subprocess ran.
          // A late success belongs to the old epoch: never accept or memoize it.
          if (_latch.tripped) {
            stats.blocksRawPinned += 1;
            continue;
          }
          decision = accept(raw, result.stdout, filterId);
          memo.set(key, decision);
        }

        if (!decision) {
          stats.blocksRawPinned += 1;
          continue;
        }

        newContent[j] = writeContent(block, shape, decision.text);
        stats.blocksFiltered += 1;
        stats.bytesRemoved += rawBytes - Buffer.byteLength(decision.text, 'utf8');
        msgChanged = true;
      }

      if (msgChanged) {
        out[i] = { ...msg, content: newContent };
        changed = true;
      }
    }

    // A later block (or another request) can fault after earlier blocks were
    // rewritten, including memo hits. Return the entire original transcript
    // once disabled so no partial rewrite escapes after the one-way transition.
    if (_latch.tripped && changed) {
      stats.blocksRawPinned += stats.blocksFiltered;
      stats.blocksFiltered = 0;
      stats.bytesRemoved = 0;
      return { messages, changed: false, stats };
    }

    // Mirrors compress.js's estimate contract: ~4 chars/token, OBSERVABILITY
    // ONLY. §8 is explicit that this is not proof of a provider-token delta.
    stats.estRemovedTokens = Math.ceil(stats.bytesRemoved / 4);
    return { messages: changed ? out : messages, changed, stats };
  }

  return {
    applyToMessages,
    latch: latchState,
    memoSize: () => memo.size,
    config: cfg,
  };
}

// ---------------------------------------------------------------------------
// §10.4 ADMISSION GATE (load-bearing).
//
// A filter may be admitted to the allowlist ONLY if it is proven, by
// cross-process fixture, to be a total function of its input bytes. This runs
// the filter `rounds` times in SEPARATE PROCESSES under the §9 spawn contract
// and requires byte equality. Separate processes is the whole point: the
// disqualifying pattern (§4) is a non-total sort leaving tied entries in
// randomized HashMap order, which is stable WITHIN one process and differs
// BETWEEN them.
//
// Determinism is enforced HERE, at admission — never observed at runtime.
// IQA-R3 was right that a runtime divergence detector storing its comparison
// digest inside the very entry it evicts has no independent history to compare
// against.
//
// `runner` is injectable so the gate's own logic is testable offline; the
// production default really does spawn.
async function runAdmissionProbe(cfg, filterId, input, rounds = 3, runner = null) {
  const run = runner || ((id, text) => defaultRunFilter(cfg, id, text));
  const outputs = [];
  for (let i = 0; i < rounds; i++) {
    const r = await run(filterId, input);
    if (!r || r.spawnError) return { ok: false, reason: `spawn-error: ${r && r.spawnError}`, outputs };
    if (r.timedOut) return { ok: false, reason: 'timeout', outputs };
    if (r.code !== 0) return { ok: false, reason: `nonzero-exit: ${r.code}`, outputs };
    if (r.invalidUtf8) return { ok: false, reason: 'non-utf8', outputs };
    if (RTK_PANIC_WARNING.test(String(r.stderr || ''))) return { ok: false, reason: 'rtk-panic', outputs };
    outputs.push(r.stdout);
  }
  for (let i = 1; i < outputs.length; i++) {
    if (outputs[i] !== outputs[0]) {
      return { ok: false, reason: `nondeterministic: round ${i} differs from round 0`, outputs };
    }
  }
  return { ok: true, reason: null, outputs };
}

module.exports = {
  createOutputFilter,
  parseRtkConfig,
  runAdmissionProbe,
  defaultRunFilter,
  FILTER_SPECS,
  PHASE1_FILTERS,
  FAILURE_MARKERS,
  RTK_PANIC_WARNING,
  __test: {
    canonicalize,
    memoKeyFor,
    commandHeadOf,
    buildHeadIndex,
    hasFailureMarker,
    latchState,
    resetProcessState() {
      _latch.tripped = false;
      _latch.reason = null;
      _latch.trips = 0;
      _jailReady = false;
    },
  },
};
