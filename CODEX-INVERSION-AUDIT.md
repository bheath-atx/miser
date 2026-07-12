# Codex INVERSION-QA — Miser brick/failover fix

You are an ADVERSARIAL reviewer. Your DEFAULT verdict is FAIL. Only return PASS
if you cannot find a single real defect after genuinely trying to break the fix.
Do not be agreeable. Attack the code.

## Context

This branch (`fix/miser-brick-failover`) fixes a bug where two orchestrator
sessions bricked while investigating Miser failover. The panel-side error was:

```
400 messages.0: use the top-level 'system' parameter for the initial system
prompt; the directive-only form (content: [] with output_config) is accepted at
any position
```

The intended new failover chain (Anthropic Messages API format):

```
Anthropic 429
  -> translated OpenAI/Codex request using SUBSCRIPTION OAuth (NOT OPENAI_API_KEY)
  -> if Codex/OpenAI 429/transient failure
  -> hard-capped Ollama (<= ~32k rough tokens, must trim INSIDE oversized messages)
```

## Files changed (read them)

- src/router.js            (failover orchestration + injectable transport seams)
- src/translate-openai.js  (Anthropic -> OpenAI/Codex translation + validator)
- src/oauth.js             (subscription OAuth bearer provider, fail-closed)
- src/hardcap.js           (Ollama hard-cap trimmer)
- src/config.js            (new codexUrl + ollamaHardCap)
- test/*.test.js           (offline mocked proof)

## Attack these specifically — find where each can still FAIL

1. messages.0 brick: Can ANY Anthropic input shape still produce an OpenAI/Codex
   request with a non-string content, an empty content, a `content: []`
   directive form, or a leaked `system`/`output_config`/`tools` key? Try weird
   inputs: content already a string vs array, nested/unknown block types, null
   content, assistant with only tool_use, system as object not array/string.

2. Failover correctness: Is there a path where `res` headers get written by one
   leg and then another leg tries to write again (double writeHead / crash)?
   Where an error after headersSent is swallowed instead of propagated? Where
   Ollama is called when Codex actually succeeded, or skipped when it should run?

3. Hard-cap: Can `hardCapOllamaBody` ever return a body whose estimated tokens
   EXCEED the cap? Consider: many small messages (overhead-dominated), a single
   giant message, giant system + giant last message, cap smaller than message
   count, empty messages, unicode/surrogate-pair chars vs `.length`. Prove or
   break the `<= cap` guarantee.

4. OAuth: Can OPENAI_API_KEY ever be used as the bearer? Can a missing/expired/
   empty token silently pass through instead of failing closed? Does the
   production default path read the real ~/.codex/auth.json only where intended?

5. Tests: Are the tests actually proving the claims, or are they tautological /
   mock-only theater? Does any test bind or connect to :20128? Would the offline
   tests still pass if the real bug were reintroduced (i.e. are they load-bearing)?

6. Guardrail check: Does any code path in the CHANGED files send traffic to
   :20128, call server.listen, or read live secrets during import/test?

## Output format

Return:
- VERDICT: PASS or FAIL
- For FAIL: a numbered list of concrete defects, each with file:line, the exact
  input/scenario that triggers it, and the observed vs required behavior.
- For anything you suspect but cannot confirm: list under "UNVERIFIED SUSPICIONS".
- Be specific. Cite line numbers. No vague hand-waving.
