# Quickstart: Real Streaming Completions

## Prerequisites

- PR #2 merged (monorepo foundation)
- LLM provider running with `stream: true` support
- `LLM_PROVIDER_URL` env var set

## Run locally

```bash
# Start dependencies (Postgres, Redis)
docker compose up -d

# Start API
cd packages/api && pnpm run dev
```

## Test streaming

```bash
# Create persona
curl -X POST http://localhost:3000/v1/personas \
  -H "Content-Type: application/json" \
  -H "X-Tenant-ID: test-tenant" \
  -d '{"name":"Test Twin","slug":"test-twin","system_prompt":"You are a helpful assistant."}'

# Stream a completion
curl -N http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-Tenant-ID: test-tenant" \
  -d '{
    "model": "test-twin",
    "messages": [{"role": "user", "content": "Say hello"}],
    "stream": true,
    "stream_options": {"include_usage": true}
  }'
```

Expected: tokens arrive one-by-one as SSE events, final chunk includes usage, then `data: [DONE]`.

## Run tests

```bash
# Unit tests (mock LLM provider)
pnpm run test:unit

# Integration tests (requires running LLM provider)
TWIN_STREAM_TIMEOUT_MS=5000 pnpm run test:integration
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TWIN_STREAM_TIMEOUT_MS` | `30000` | Max wait for next LLM chunk before abort |
| `LLM_PROVIDER_URL` | `http://localhost:4000` | OpenAI-compatible provider URL |
| `LLM_API_KEY` | — | Optional auth key for provider |
| `LLM_DEFAULT_MODEL` | `gpt-4o` | Fallback model when persona has no preference |
