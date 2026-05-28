# Feature Specification: Real Streaming Completions

**Feature Branch**: `specs/002-streaming-completions`
**Created**: 2026-05-27
**Status**: Clarified
**Input**: User description: "Replace fake streaming in chat-completions with real token-by-token SSE streaming from LLM provider. Currently handleStream awaits full ChatService.complete() before writing any chunks, defeating stream: true purpose. Requires ChatService/callLLM streaming variant, proper SSE piping, usage accounting via stream_options, and AbortController on client disconnect."

---

## Scope & Boundaries

### IN scope

- `ChatService.completeStream()` returning `AsyncGenerator<StreamChunk>`
- `callLLM` streaming variant consuming `response.body` ReadableStream from OpenAI-compatible provider
- `handleStream` rewrite in `chat-completions.ts` — pipe tokens as they arrive
- `stream_options: { include_usage: true }` for token counting in streaming mode
- AbortController propagation on client disconnect
- Non-streaming path (`stream: false`) unchanged — no regression
- Shared types for streaming chunks in `@undrecreaitwins/shared`

### OUT of scope

- WebSocket transport (SSE only, OpenAI-compatible)
- Streaming for channel adapters (Telegram/WhatsApp) — they use `ChatService.complete()` (non-streaming)
- Multiple concurrent stream providers — single LLM provider endpoint only
- Rate limiting / token throttling per-stream (separate concern)
- Streaming for training pipeline output

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Real-time token streaming via SSE (Priority: P1)

A developer sends `stream: true` to `/v1/chat/completions`. Tokens arrive one-by-one as SSE `data:` events with sub-second latency, matching the OpenAI streaming API format. The first token arrives within the LLM's time-to-first-token (TTFT), not after the full response completes.

**Why this priority**: This is the core value proposition — the current implementation is a "fake stream" that blocks until the full response is generated. Without real streaming, `stream: true` is a lie.

**Independent Test**: `POST /v1/chat/completions` with `{model: "persona-slug", messages: [...], stream: true}` → verify SSE chunks arrive incrementally (first chunk < TTFT + 500ms), each chunk contains a non-empty `delta.content`, and the final chunk has `finish_reason: "stop"` followed by `data: [DONE]`.

**Acceptance Scenarios**:

1. **Given** a persona exists and LLM provider is available, **When** `POST /v1/chat/completions` with `stream: true` is called, **Then** the response is `Content-Type: text/event-stream`, first SSE chunk arrives within TTFT, and chunks continue until `[DONE]`.
2. **Given** a streaming request is in progress, **When** the LLM emits 50 tokens over 2 seconds, **Then** the client receives ≥5 SSE chunks within those 2 seconds (not a single burst at the end).
3. **Given** a streaming response completes, **When** the last token is emitted, **Then** a final chunk with `finish_reason: "stop"` and `usage` data is sent before `[DONE]`.
4. **Given** `stream: false` is specified, **When** the request is processed, **Then** the response is identical to the current non-streaming behavior (no regression).

---

### User Story 2 — Accurate usage accounting in streaming mode (Priority: P1)

Token usage (prompt_tokens, completion_tokens, total_tokens) is captured even in streaming mode, persisted to `usage_events`, and included in the final SSE chunk. This matches OpenAI's `stream_options: { include_usage: true }` behavior.

**Why this priority**: Without usage accounting, streaming mode would be a billing/metering black hole. Production-critical.

**Independent Test**: Stream a completion → check the final SSE chunk contains `usage: { prompt_tokens: N, completion_tokens: M, total_tokens: N+M }` → verify `usage_events` table has a corresponding row.

**Acceptance Scenarios**:

1. **Given** a streaming request completes normally, **When** the final chunk is sent, **Then** it includes `usage` with non-zero `prompt_tokens` and `completion_tokens`.
2. **Given** a streaming request completes, **When** querying `usage_events` for the conversation, **Then** a row exists with matching token counts and latency.

---

### User Story 3 — Client disconnect aborts LLM call (Priority: P2)

If the client disconnects mid-stream (closes connection, navigates away), the server detects the disconnect and aborts the LLM fetch via AbortController. No wasted tokens, no leaked connections.

**Why this priority**: Resource hygiene — without this, every dropped connection leaks a server-side fetch to the LLM provider.

**Independent Test**: Start a streaming request → forcibly close the client connection → verify server-side fetch is aborted within 1 second (no lingering connections).

**Acceptance Scenarios**:

1. **Given** a streaming response is in progress, **When** the client disconnects (TCP close), **Then** the LLM fetch is aborted via AbortController within 1 second.
2. **Given** a streaming response is aborted, **When** the abort fires, **Then** partial usage is NOT written to `usage_events` (incomplete generation = unreliable counts).

---

### User Story 4 — Error propagation during streaming (Priority: P2)

If the LLM provider returns an error mid-stream (5xx, network timeout, malformed chunk), the server sends a structured SSE error event and cleanly closes the stream. No hanging connections.

**Why this priority**: Production resilience — LLM providers are flaky. Clients need to know something went wrong.

**Independent Test**: Mock LLM provider to return 500 mid-stream → verify client receives an SSE error event with `error.code` and the stream closes.

**Acceptance Scenarios**:

1. **Given** a streaming request is in progress, **When** the LLM provider returns a 5xx error, **Then** an SSE error chunk `{ error: { code: "provider_error", message: "..." } }` is sent and the stream closes.
2. **Given** a streaming request is in progress, **When** the LLM provider connection times out, **Then** the stream is terminated with an error event within the timeout period.

---

### Edge Cases

- What happens when the LLM returns an empty stream (0 tokens)? → Send role chunk + finish_reason: "stop" + usage with completion_tokens: 0.
- What happens when the LLM returns malformed SSE chunks? → Catch parse errors, terminate stream with error event.
- What happens when the LLM stream stalls (no data for >30s)? → AbortController timeout, emit error event.
- What happens when `stream_options` is not sent by client? → Default to NOT including usage in stream (match OpenAI default). Only include usage when explicitly requested.
- What happens when non-streaming path is used with a persona that has no model preferences? → Unchanged (uses default model).

---

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: `ChatService` MUST expose a `completeStream()` method returning `AsyncGenerator<StreamChunk>` that yields tokens as they arrive from the LLM provider.
- **FR-002**: `callLLM` MUST support a streaming mode that sends `stream: true` to the provider and parses the SSE response body as a ReadableStream.
- **FR-003**: `handleStream` in `chat-completions.ts` MUST write SSE chunks to `reply.raw` as each token arrives, NOT after the full response completes.
- **FR-004**: The SSE format MUST be OpenAI-compatible: `data: {"id":"...","object":"chat.completion.chunk","choices":[{"delta":{"content":"token"},"finish_reason":null}]}`.
- **FR-005**: When `stream_options: { include_usage: true }` is in the request, usage data MUST be included in the final chunk.
- **FR-006**: An `AbortController` MUST be created per streaming request, with `request.raw.on('close', ...)` triggering `controller.abort()`.
- **FR-007**: Token usage from streaming responses MUST be persisted to `usage_events` after stream completion.
- **FR-008**: Messages MUST be persisted to the `messages` table after stream completion (same as non-streaming).
- **FR-009**: Error events during streaming MUST be sent as structured SSE error payloads before closing the stream.
- **FR-010**: The non-streaming path (`stream: false` or absent) MUST remain unchanged in behavior and response shape.

### Key Entities

- **StreamChunk**: `{ id, object, created, model, choices: [{ delta, finish_reason }], usage? }` — SSE wire format, matches OpenAI `chat.completion.chunk`.
- **LLMStreamParams**: Extension of current `callLLM` params with `stream: true` and optional `stream_options`.
- **AbortHandle**: Wrapper tying `AbortController.signal` to the client connection lifecycle.

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: First SSE chunk arrives within TTFT + 200ms of the LLM provider's first token (measured via integration test with mock provider).
- **SC-002**: A 100-token streaming response produces ≥10 SSE chunks (not a single burst).
- **SC-003**: Client disconnect aborts the LLM fetch within 1 second (verified by no pending connections in test).
- **SC-004**: Token usage in streaming mode matches non-streaming mode (±2 tokens tolerance) for the same input.
- **SC-005**: Non-streaming path passes all existing tests with zero changes to test expectations.
- **SC-006**: No memory leaks — streaming response with 10,000 tokens completes without unbounded buffer growth.

---

## Non-Functional Requirements

- **NFR-001**: Streaming MUST NOT block the Node.js event loop. Token processing must yield to the event loop between chunks. Satisfied by design: `AsyncGenerator` yields per chunk, inherently non-blocking.
- **NFR-002**: Memory usage during streaming MUST be bounded — streaming buffer MUST NOT exceed 64KB per request. No buffering the entire response. Backpressure via `reply.raw.write()` return value handling. Accumulated content for persistence grows at 1:1 with response tokens (no intermediate copies).
- **NFR-003**: SSE chunk size SHOULD be ≤16KB per `reply.raw.write()` call to avoid TCP send buffer issues. Large token deltas MUST be split or concatenated only up to this limit before flushing.
- **NFR-004**: The implementation MUST work with any OpenAI-compatible provider (OmniRoute, LiteLLM, vLLM, etc.) that supports `stream: true`.

---

## Dependencies & Constraints

- **Depends on**: PR #2 (`001-twin-engine-foundation`) merged — this spec builds on the existing `ChatService`, `callLLM`, and `chat-completions.ts`.
- **Provider requirement**: LLM provider endpoint MUST support `stream: true` in chat completions API (OpenAI-compatible).
- **Node.js**: Requires Node.js ≥20 for `ReadableStream` from `fetch` response body.

---

## Files to Modify

| File | Change |
|------|--------|
| `packages/core/src/services/chat-service.ts` | Add `completeStream()` method, add `callLLMStream()` private method |
| `packages/api/src/routes/chat-completions.ts` | Rewrite `handleStream()` to use `completeStream()`, add AbortController |
| `packages/shared/src/types.ts` (or new file) | Add `StreamChunk`, `StreamDelta` types |
| `packages/core/src/services/chat-service.ts` | Extract usage + persist after stream completion |

**Estimated LOC**: ~200 added, ~80 removed/rewritten.

---

## Resolved Clarifications

- **[Q1] Yield format**: `completeStream()` yields **parsed `StreamChunk` objects**. Route layer formats to SSE. Rationale: separation of concerns, testable, reusable for non-SSE consumers.
- **[Q2] Persistence**: **Accumulate tokens in generator** — concatenate `delta.content` as they arrive, persist after stream completes. No full-response buffering. Bounded memory.
- **[Q3] Stream timeout**: **`TWIN_STREAM_TIMEOUT_MS` env var**, default 30000. Configurable per deployment.
- **[Q4] Memory + TTFT**: **Fetch Letta memory before stream starts**. Consistent with non-streaming behavior. Accept ~50-100ms TTFT overhead for full context fidelity.
- **[Q5] Conversation lifecycle**: **Create conversation BEFORE stream starts**. `conversation_id` available immediately for logging/correlation. On abort, conversation persists with partial message count — this is acceptable (matches non-streaming behavior for aborted requests).

---

## Open Questions

_None remaining._
