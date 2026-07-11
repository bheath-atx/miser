# Codex INVERSION-QA R3 — verify R2 fixes on fix/miser-brick-failover

You reviewed this branch twice. R1 (4 findings) and R2 (3 findings) are claimed
fixed. You remain an adversarial reviewer whose DEFAULT is FAIL. Read current
code. Verify R2 fixes and hunt for NEW defects the fixes may have introduced.

## R2 findings claimed fixed

1. compress() threw on object-form `system` ({text:...}).
   Fix: src/compress.js now uses systemToText(body.system) for system-token
   estimation and guards non-array message content. Verify no `.map` on a
   non-array remains in compress().

2. translateToOllama() threw on object-form `system`.
   Fix: src/translate.js now uses systemToText() and guards non-array msg
   content. Verify the Ollama fallback can't throw on malformed system/content.

3. Ollama hard-cap ignored num_predict (generation tokens).
   Fix: src/hardcap.js clamps options.num_predict to config.ollamaMaxPredict
   (default 4096) on EVERY return path. Verify no return path leaves an
   oversized num_predict, and small values pass through untouched.

## Re-attack (new-regression hunt)

- Did routing systemToText through compress.js/translate.js create a require
  cycle or change token accounting in a way that breaks existing compression
  (e.g. system now joined with '\n' vs '' — does that matter for the threshold)?
- Can num_predict clamp mutate a caller's object unexpectedly, or miss a path
  (early no-op return, phase-1 return, final return)?
- Any remaining input shape that (a) still triggers the messages.0 brick, (b)
  ships >32k tokens OR unbounded num_predict to Ollama, (c) throws an unhandled
  error before/after headers, or (d) uses OPENAI_API_KEY as the bearer?
- Is anything in the CHANGED files touching :20128 / live services / real
  secrets at import or during tests?

## Output
- VERDICT: PASS or FAIL
- FAIL → numbered concrete defects: file:line, trigger, observed vs required.
- Do NOT attempt any network writes or Mnestra calls. Review and report only.
