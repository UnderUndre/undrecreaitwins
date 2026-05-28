# Streaming SSE Contract

OpenAI-compatible SSE wire format for `stream: true` responses.

## Request

```json
POST /v1/chat/completions
{
  "model": "persona-slug",
  "messages": [{"role": "user", "content": "Hello"}],
  "stream": true,
  "stream_options": { "include_usage": true }
}
```

- `stream`: boolean, required for streaming mode
- `stream_options.include_usage`: boolean, optional. When `true`, final chunk includes `usage`.

## Response

`Content-Type: text/event-stream`
`Cache-Control: no-cache`
`Connection: keep-alive`

### Chunk: Role assignment (first chunk)

```
data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}

```

### Chunk: Token delta (per token)

```
data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4o","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}

```

### Chunk: Finish

```
data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

```

### Chunk: Usage (optional, only when `stream_options.include_usage: true`)

```
data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4o","choices":[],"usage":{"prompt_tokens":25,"completion_tokens":15,"total_tokens":40}}

```

### Stream end

```
data: [DONE]

```

### Error event

```
data: {"error":{"code":"provider_error","message":"LLM provider returned 503"}}

```

## StreamChunk Type (internal)

```typescript
interface StreamChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: 'assistant';
      content?: string;
    };
    finish_reason: 'stop' | 'length' | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}
```

## Error handling

### Early errors (before `writeHead(200)`)

If an error occurs before the SSE stream starts (e.g., LLM provider returns 5xx immediately, auth failure, invalid request):

```
HTTP/1.1 503 Service Unavailable
Content-Type: application/json

{"error":{"code":"provider_error","message":"LLM provider returned 503"}}
```

- Return standard JSON error with appropriate HTTP status code (400, 401, 503, etc.)
- No SSE headers sent, no `data: [DONE]`

### Mid-stream errors (after `writeHead(200)`)

If an error occurs after the SSE stream has started:

```
data: {"error":{"code":"provider_error","message":"LLM provider connection lost"}}

```

- Send SSE error event as defined in §Error event above
- Terminate with `reply.raw.end()`
- HTTP status is already committed as `200 OK` — cannot change it

## Abort behavior

- Client disconnect → `request.raw` emits `'close'` → `AbortController.abort()` → LLM fetch cancelled
- On abort: no `persistMessages`, no `emitUsageEvent` — incomplete generation
- On abort: conversation record persists (created before stream) with `messageCount: 0`

## Error codes

| Code | Meaning |
|------|---------|
| `provider_error` | LLM provider returned non-200 or network error |
| `stream_timeout` | No data from provider within `TWIN_STREAM_TIMEOUT_MS` |
| `parse_error` | Malformed SSE chunk from provider |
