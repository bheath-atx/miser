# Codex INVERSION-QA — Codex Responses-backend failover on fix/miser-brick-failover

New work since the PASS: the Codex failover leg now targets the ChatGPT Codex
backend Responses API (chatgpt.com/backend-api/codex/responses) using the
subscription OAuth token, because that OAuth cannot auth against api.openai.com.
You are an adversarial reviewer; DEFAULT FAIL. Read current code.

## What changed
- NEW src/translate-responses.js:
  - translateToResponses(): Anthropic → Responses request. system→`instructions`,
    messages→`input:[{type:'message',role,content:[{type:'input_text'|'output_text',text}]}]`,
    tools degraded to text, max_tokens→max_output_tokens, store:false.
  - validateResponsesRequest(): rejects anthropic-only keys, empty/non-string
    content parts, bad roles/part-types.
  - translateResponsesStream(): Responses-API SSE → Anthropic SSE (message_start
    → content_block_delta text_delta → message_delta/message_stop), SSE framed on
    blank lines, tolerant of split frames / unknown events / malformed data.
- src/config.js: codexUrl → chatgpt.com/backend-api/codex/responses; codexFormat
  ('responses'|'chat'); codexBeta; codexOriginator.
- src/router.js forwardToCodex: sends authorization Bearer + chatgpt-account-id +
  openai-beta + originator + accept:text/event-stream; on 2xx runs
  translateResponsesStream (NOT raw pipe) so the client gets Anthropic SSE; on any
  non-2xx rejects before writeHead (fail over to Ollama). Router leg-2 picks
  translateToResponses+validateResponsesRequest by default.

## Attack
1. Can any Anthropic input still yield a malformed Responses request (non-string
   text part, empty content, leaked system/messages/output_config, wrong role)?
2. Stream translator: can it hang the client (never end), double-end, emit
   content before message_start, mis-handle a split multi-line data field, or
   leak raw Responses events to the client? What if the upstream ends mid-stream
   with no response.completed? What about [DONE]?
3. forwardToCodex: any path where a non-2xx still writes headers / streams to
   client? Any where 2xx with an immediate upstream error hangs? Is the
   subscription bearer ever replaced by OPENAI_API_KEY? Are codex headers correct?
4. Did adding translate-responses create a require cycle (it imports
   systemToText/contentToText from translate-openai)?
5. Anything touching :20128 / live services / real secrets at import or in tests?
   (Note: transport tests intentionally bind an ephemeral 127.0.0.1 fake upstream
   — that is sanctioned "fake/local upstream", not :20128.)

## Output
- VERDICT: PASS or FAIL. FAIL → numbered defects with file:line + trigger +
  observed vs required. Style/nitpicks are not FAIL. No network writes / Mnestra.
