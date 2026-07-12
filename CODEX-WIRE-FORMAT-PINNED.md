# Codex Responses backend — wire format PINNED from live capture

Captured 2026-07-11 by routing the real `codex exec` 0.144.1 through a local
logging reverse-proxy (`chatgpt_base_url`/`openai_base_url` overridden to the
proxy; proxy forwarded to `https://chatgpt.com`). No miser/:20128 involvement.
Bearer token redacted in all persisted artifacts.

## Endpoint
`POST https://chatgpt.com/backend-api/codex/responses`
(codex prefers a WebSocket transport first; on WS failure it falls back to this
plain HTTPS POST — which is exactly the shape miser uses.)

## Request headers (real, verified)
| header | value | miser |
|---|---|---|
| `authorization` | `Bearer <subscription access_token>` (~2106 chars) | ✓ sends |
| `chatgpt-account-id` | `<account_id uuid>` | ✓ sends (from bearer.accountId) |
| `accept` | `text/event-stream` | ✓ |
| `content-type` | `application/json` | ✓ |
| `originator` | `codex_exec` (mode-dependent) | ✓ sends `codex_cli_rs` (configurable) |
| `user-agent` | `codex_exec/0.144.1 (...)` | ✓ sends (configurable) |
| `version` | `0.144.1` | ✓ sends (configurable) |
| `content-encoding` | `zstd` (request body compressed) | ✗ miser sends plain JSON (optional) |
| `openai-beta` | **NOT SENT** | ✓ removed (was a wrong assumption) |
| `x-codex-window-id`, `x-codex-turn-metadata`, `x-codex-beta-features`, `x-client-request-id`, `session-id`, `thread-id` | per-codex-session bookkeeping | ✗ miser omits (no codex session) |

## Request body (real, zstd-decoded)
Top-level keys: `model, instructions, input, tools, tool_choice,
parallel_tool_calls, reasoning, store, stream, include, prompt_cache_key, text,
client_metadata`.

- `model`: `"gpt-5.5"`
- `instructions`: system prompt string  ← **miser maps Anthropic system → instructions ✓**
- `input`: `[{ "type":"message", "role":"developer|user|assistant",
   "content":[{ "type":"input_text", "text":"..." }] }]`
   ← **byte-for-byte identical to miser's translateToResponses output ✓**
- `store: false`, `stream: true`  ← **miser matches ✓**
- `tools/tool_choice/parallel_tool_calls/reasoning/include/prompt_cache_key/text/
  client_metadata` — OPTIONAL enrichments codex adds; miser omits them (a minimal
  request is valid Responses API). miser degrades tools → text.

**Conclusion: miser's request BODY is correct against ground truth.**

## Response SSE (real, verified — uncompressed `text/event-stream`, status 200)
Event sequence:
```
response.created
response.in_progress
response.output_item.added      (reasoning item — content:[], encrypted_content only)
response.output_item.done       (reasoning)
response.output_item.added      (message item, role assistant)
response.content_part.added     (part type output_text)
response.output_text.delta      ← data.delta is a STRING ("ok")   ← miser streams this ✓
response.output_text.done
response.content_part.done
response.output_item.done        (message)
response.completed              ← data.response.usage.{input,output}_tokens
```

**miser's `translateResponsesStream` verified against this exact sequence:**
- reads `data.delta` (string) from `response.output_text.delta` ✓
- ignores reasoning items → encrypted_content never leaks to the client ✓
- ends on `response.completed`, reads usage ✓
Locked by test "matches the real captured Responses event sequence".

## RESOLVED by live probe (2026-07-11, Brad-approved)
Sent miser-shaped requests (real token) directly to the backend with 3 header
sets: `full-mimic` (synthesized codex-session headers), `miser-now`, and `bare`
(authorization + chatgpt-account-id + accept + content-type only).

Result: **ALL THREE returned `200` with `response.created` SSE.**
- The backend does NOT require `x-codex-*` / `session-id` / `thread-id` headers.
- It does NOT require `content-encoding: zstd`, `originator`, `user-agent`, or
  `version`. Miser's minimal header set is sufficient.
- BODY FIX found: the backend `400`s on `max_output_tokens` ("Unsupported
  parameter"). Removed from translateToResponses (codex omits it too). After
  removal → 200.

**Miser's Codex Responses request is now proven end-to-end against the real
backend** (auth + headers + body + SSE). The only step not exercised is running
it through miser itself on :20128 — i.e. the actual cutover, which still awaits
Brad's go.
