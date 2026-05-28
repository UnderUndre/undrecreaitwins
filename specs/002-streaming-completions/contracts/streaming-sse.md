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
