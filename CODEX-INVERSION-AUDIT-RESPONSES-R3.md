# Codex INVERSION-QA R3 — final convergence, Responses backend, fix/miser-brick-failover

Prior Responses-leg findings fixed: empty-input rejected, CRLF SSE normalized,
and now stream is FORCED true in translateToResponses (src/translate-responses.js
~line 52) because the Codex transport only consumes SSE and re-emits Anthropic
SSE (same as the Ollama leg, which always streams regardless of client flag).

You remain adversarial; DEFAULT FAIL, but do not invent inputs no real Anthropic
client sends just to force FAIL. Verify the stream-forced fix, then make a FINAL
determination of the Codex Responses failover leg against charter:
1. No Anthropic input yields a malformed/empty Responses request reaching Codex.
2. Stream translator: no hang/double-end/pre-message_start emit/raw-event leak;
   handles CRLF, split frames, [DONE], missing response.completed, failed events.
3. forwardToCodex: non-2xx never writes headers (fails over to Ollama incl.
   401/403); 2xx re-emits Anthropic SSE; subscription bearer, never OPENAI_API_KEY;
   codex headers (authorization/chatgpt-account-id/openai-beta/originator/accept).
4. No require cycle; nothing touches :20128 / live services / real secrets at
   import or in tests (ephemeral 127.0.0.1 fake upstream is sanctioned).

If a REAL reachable defect remains, VERDICT FAIL with file:line + trigger. If the
Responses leg meets its charter (style/nitpicks not FAIL), VERDICT PASS. No
network writes / Mnestra.
