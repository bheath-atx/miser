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

## THE ONE REMAINING UNKNOWN (before live cutover)
Does the backend REQUIRE the codex-session headers (`x-codex-*`, `session-id`,
`thread-id`) and/or `content-encoding: zstd`, or will it accept miser's minimal
header set (authorization + chatgpt-account-id + accept + content-type +
originator + user-agent + version)?

The capture proves the FULL codex request works; it does not prove a MINIMAL one
does. Resolve with a one-shot minimal-request probe (miser-shaped body + minimal
headers, real token) against the backend, observing 200-vs-4xx — an explicit,
Brad-approved step. Everything else is pinned.
