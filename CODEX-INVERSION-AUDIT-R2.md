# Codex INVERSION-QA R2 — verify R1 fixes on fix/miser-brick-failover

You previously reviewed this branch and returned FAIL with 4 findings. Fixes
were applied. You are STILL an adversarial reviewer whose DEFAULT is FAIL.
Verify each R1 finding is genuinely fixed (not papered over), and hunt for NEW
defects introduced by the fixes. Read the current code — do not trust this list.

## R1 findings claimed fixed

1. Expired/invalid OAuth → Codex 401/403 was streamed to client.
   Claimed fix: src/router.js forwardToCodex now rejects on ANY non-2xx
   (`statusCode < 200 || >= 300`) BEFORE writeHead, so the router fails over to
   hard-capped Ollama. Verify a 401/403/400/5xx cannot reach the client as a
   Codex "success", and that headers are not written before the reject.

2. Post-header upstream stream error left the client hung.
   Claimed fix: new `teardownResponse(res, err)` called from every transport's
   `upstream.on('error', ...)`; it res.destroy()s (or end()s) the response.
   Verify no transport still just `reject`s without tearing down after headers.

3. Translator could emit non-string content for weird `system` shapes.
   Claimed fix: src/translate-openai.js systemToText now only accepts a string
   `.text` (object or block). Verify `translateToOpenAI(..., {system:{text:{...}}})`
   and block-array with non-string `.text` cannot produce non-string content.

4. Tests missed 401/403 + post-header errors.
   Claimed fix: test/failover.test.js adds 401/403/400/502 failover cases +
   teardownResponse unit tests; test/codex-transport.test.js exercises the REAL
   forwardToCodex against a LOCAL fake upstream (ephemeral 127.0.0.1 port, never
   :20128) for 401/403/500 + Bearer-not-OPENAI_API_KEY. test/translate-openai
   adds object/block system.text cases.

## Re-attack

- Is the non-2xx failover REALLY safe, or did it introduce a regression (e.g. a
  2xx-but-error, redirect 3xx now failing over wrongly, or a success path that
  no longer records usage)?
- Does teardownResponse have any path that double-destroys, throws, or is a
  no-op when it should act?
- Does the local-fake-upstream test actually bind an ephemeral port (not :20128)
  and never connect to the live service?
- Any NEW way to still trigger the messages.0 brick or ship >32k to Ollama?

## Output
- VERDICT: PASS or FAIL
- FAIL → numbered concrete defects with file:line, trigger, observed vs required.
- Do NOT attempt any network writes or Mnestra calls; just review and report.
