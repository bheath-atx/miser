# Codex INVERSION-QA R5 — final convergence on fix/miser-brick-failover

Fourth re-review. R4 found 2 defects, claimed fixed:
1. Null-block guards added: src/compress.js hasToolUse now `b && b.type`, and
   validateMessageIntegrity now guards `block && block.type` in both loops.
2. src/hardcap.js num_predict clamp now bounds into [1, ollamaMaxPredict]:
   non-finite / <=0 / >max all map to maxPredict (so -1 "infinite" is clamped).

You remain adversarial; DEFAULT FAIL, but do NOT invent purely-hypothetical
inputs no Anthropic client could send just to force a FAIL. Judge against the
charter:
1. messages.0 brick cannot recur.
2. Failover: Anthropic 429 -> Codex (subscription OAuth, non-2xx fails over,
   fail-closed on bad token, never OPENAI_API_KEY) -> hard-capped Ollama.
3. Ollama never gets >~32k rough tokens nor an unbounded/negative num_predict.
4. No malformed system/content shape throws an unhandled error that bricks the
   proxy before failover.
5. Changed files never touch :20128 / live services / real secrets at import or
   during offline tests.

Read current code. Verify the R4 fixes. If a REAL, reachable defect remains,
VERDICT FAIL with file:line + trigger. If the change set meets its charter
(style/nitpicks are not FAIL), VERDICT PASS. No network writes, no Mnestra calls.
