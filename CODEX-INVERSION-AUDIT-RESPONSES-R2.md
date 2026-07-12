# Codex INVERSION-QA R2 — verify Responses-backend fixes on fix/miser-brick-failover

You found 2 defects in the Codex Responses backend. Claimed fixes:
1. Empty translated `input`: src/translate-responses.js validateResponsesRequest
   now rejects `input.length === 0` (router then fails closed to Ollama).
2. CRLF SSE: translateResponsesStream now strips ALL '\r' from each chunk before
   `\n\n` framing, so `\r\n\r\n` frames (incl. split across chunk boundaries)
   parse correctly.

You remain adversarial; DEFAULT FAIL. Verify both fixes in current code and hunt
for NEW regressions. Also re-confirm the whole Responses leg against charter:
- No Anthropic input yields a malformed/empty Responses request that reaches Codex.
- Stream translator never hangs, double-ends, emits before message_start, or
  leaks raw Responses events; handles missing response.completed, [DONE], CRLF.
- forwardToCodex: non-2xx never writes headers; 2xx re-emits Anthropic SSE;
  bearer is subscription token not OPENAI_API_KEY; codex headers present.
- No require cycle; nothing touches :20128 / live services / real secrets at
  import or in tests (ephemeral 127.0.0.1 fake upstream is sanctioned).

VERDICT: PASS or FAIL. FAIL → numbered file:line + trigger + observed vs required.
Style/nitpicks are not FAIL. No network writes / Mnestra.
