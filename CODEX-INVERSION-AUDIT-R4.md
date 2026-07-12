# Codex INVERSION-QA R4 — final convergence on fix/miser-brick-failover

Third re-review. R3 found 2 defects (null/malformed blocks in content arrays
throwing in compress.js messageTokens and translate.js content map). Claimed
fixes:
- src/compress.js: new safeBlockText() guards null/string/circular blocks.
- src/translate.js: content map guards `!block || typeof block !== 'object'`,
  string-checks block.text, and uses a non-throwing safeJson() for tool payloads.

You remain adversarial; DEFAULT FAIL. Read current code. Verify these two fixes,
then make a FINAL determination on the whole change set against its charter:

1. The recovered messages.0 brick cannot recur (Anthropic->OpenAI/Codex
   translation: system extracted, all content non-empty strings, no anthropic-only
   keys / output_config / content:[] reach Codex).
2. Failover order is Anthropic 429 -> Codex (subscription OAuth, non-2xx fails
   over) -> hard-capped Ollama; OPENAI_API_KEY never used as bearer; fail-closed
   on missing/invalid token.
3. Ollama leg cannot receive >~32k rough tokens NOR an unbounded num_predict.
4. No unhandled throw bricks the proxy on malformed system/content shapes.
5. Nothing in changed files touches :20128 / live services / real secrets at
   import or during offline tests.

If you still find a REAL defect, VERDICT FAIL with file:line + trigger. If the
change set is sound for its charter (nitpicks/style are not FAIL), VERDICT PASS.
Do NOT attempt network writes or Mnestra calls.
