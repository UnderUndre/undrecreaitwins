# Research: Provider API Contracts for Embedding Adapter

## 1. TEI Contract (Current — Must Match)

### POST /embed
```json
// Request
{ "inputs": "single string" }
{ "inputs": ["string one", "string two"] }

// Response (single)
[0.0123, -0.0456, ...]  // number[] — flat float array

// Response (batch)
[[0.0123, ...], [0.0789, ...]]  // number[][] — array of float arrays
```

### POST /rerank
```json
// Request
{ "query": "search query", "documents": ["doc1", "doc2", "doc3"] }

// Response
[
  { "index": 2, "score": 0.95 },
  { "index": 0, "score": 0.42 },
  { "index": 1, "score": 0.13 }
]
```

### GET /health
```json
// Response
{ "status": "ok" }
// (TEI returns version info — adapter returns simpler liveness)
```

## 2. Provider APIs

### OpenAI Embeddings — POST /v1/embeddings

**Base URL**: `https://api.openai.com/v1`
**Auth**: `Authorization: Bearer <key>`
**Model**: `text-embedding-3-small` (1536-dim) / `text-embedding-3-large` (3072-dim)
**Price**: $0.02/1M tokens (3-small), $0.13/1M tokens (3-large)

```json
// Request
{
  "model": "text-embedding-3-small",
  "input": "single string" | ["string one", "string two"]
}

// Response
{
  "object": "list",
  "data": [
    { "object": "embedding", "index": 0, "embedding": [0.0123, ...] },
    ...
  ],
  "model": "text-embedding-3-small",
  "usage": { "prompt_tokens": 8, "total_tokens": 8 }
}
```

**Key observation**: OpenAI does NOT support `dimensions` parameter for `text-embedding-3-small` via the standard API — it always returns 1536-dim. Must strip `object`, `model`, `usage` from response.

### Jina Embeddings — POST /v1/embeddings

**Base URL**: `https://api.jina.ai/v1`
**Auth**: `Authorization: Bearer <key>`
**Model**: `jina-embeddings-v3` (1024-dim with `dimensions=1024`, up to 2048-dim)
**Price**: $0.02/1M tokens (1024-dim), $0.04/1M tokens (2048-dim)

```json
// Request
{
  "model": "jina-embeddings-v3",
  "input": "single string" | ["string one", "string two"],
  "dimensions": 1024
}

// Response (same OpenAI-compatible format)
{
  "object": "list",
  "data": [
    { "object": "embedding", "index": 0, "embedding": [0.0123, ...] },
    ...
  ],
  "model": "jina-embeddings-v3",
  "usage": { "total_tokens": 8 }
}
```

**Key observation**: Jina supports `dimensions` param. Default if omitted varies by model. Must pass `dimensions: 1024` explicitly to match pgvector index.

### Cohere Rerank — POST /v1/rerank

**Base URL**: `https://api.cohere.com/v1`
**Auth**: `Authorization: Bearer <key>`
**Model**: `rerank-multilingual-v3.0`
**Max docs**: 1000 per request
**Price**: $1.00/1K units (~$0.001/document)

```json
// Request
{
  "model": "rerank-multilingual-v3.0",
  "query": "search query",
  "documents": ["doc1", "doc2", "doc3"],
  "top_n": 3
}

// Response
{
  "results": [
    { "index": 2, "relevance_score": 0.95 },
    { "index": 0, "relevance_score": 0.42 },
    { "index": 1, "relevance_score": 0.13 }
  ],
  "meta": { "api_version": { "version": "1" } }
}
```

**Key observation**: Field name is `relevance_score` (not `score`). Must rename to `score` in response. Must strip `meta`. **`top_n` must be passed explicitly (review-fix)**: if omitted, Cohere may default to returning fewer results than `documents.length`, silently truncating the rerank contract. Adapter passes `top_n: documents.length` always.

### Jina Rerank — POST /v1/rerank

**Base URL**: `https://api.jina.ai/v1`
**Auth**: `Authorization: Bearer <key>`
**Model**: `jina-reranker-v2-base-multilingual`
**Max docs**: 2048 per request
**Price**: $0.02/1K documents

```json
// Request
{
  "model": "jina-reranker-v2-base-multilingual",
  "query": "search query",
  "documents": ["doc1", "doc2", "doc3"],
  "top_n": 3
}

// Response
{
  "model": "jina-reranker-v2-base-multilingual",
  "results": [
    { "index": 2, "relevance_score": 0.95, "document": { "text": "doc3" } },
    ...
  ],
  "usage": { "total_tokens": 50 }
}
```

**Key observation**: Same field rename needed (`relevance_score` → `score`). Jina returns `document.text` in results — must strip. Must strip `model`, `usage` from response. **`top_n` must be passed explicitly (review-fix)**: same rationale as Cohere — adapter passes `top_n: documents.length` to prevent silent truncation.

## 3. Provider Interface Design

All providers differ in response shape. The adapter needs a unified abstraction:

```typescript
interface EmbedProvider {
  embed(inputs: string | string[], model: string, apiKey: string, signal: AbortSignal): Promise<number[] | number[][]>;
}

interface RerankProvider {
  rerank(query: string, documents: string[], model: string, apiKey: string, signal: AbortSignal): Promise<RerankResult[]>;
}
```

Each concrete provider handles:
1. Request translation (adapt TEI-shaped inputs to provider's API)
2. Response extraction (unwrapping metadata, extracting raw vectors/scores)
3. Field normalization (`relevance_score` → `score`)
4. Error mapping (HTTP status → appropriate error code)

## 4. Upstream Error Codes

| Scenario | Provider Response | Adapter Response |
|----------|------------------|------------------|
| Unauthorized | 401 | 401 (passthrough) |
| Rate limited | 429 | 502 (upstream failure) |
| Server error | 500 | 502 (upstream failure) |
| Timeout | no response | 504 (Gateway Timeout) |
| Bad request (invalid model etc.) | 400 | 502 (upstream failure) |

Exception: missing credential (`Authorization` header AND all env keys absent) → 401 immediately, before upstream call.

## 5. Dimensions Compatibility

| Provider | Model | Default Dim | Configurable Dim | pgvector 1024 Match |
|----------|-------|-------------|------------------|-------------------|
| OpenAI | text-embedding-3-small | 1536 | No | ❌ Re-index needed |
| OpenAI | text-embedding-3-large | 3072 | No | ❌ Re-index needed |
| Jina | jina-embeddings-v3 | 1024 | Yes (up to 2048) | ✅ Pass `dimensions=1024` |
| Cohere | embed-multilingual-v3.0 | 1024 | No | ✅ Native |

**Recommendation**: Default provider = Jina (embeddings + rerank). It offers 1024-dim embedding natively, multilingual support, and both embedding + reranking from one API key.

## 6. Docker Compose Integration

Replace in `docker-compose.standalone.yml`:

```yaml
# REMOVE:
#   tei-embed:        ~4GB RAM, BGE-M3
#   tei-rerank:       ~4GB RAM, BGE-reranker-v2-m3

# ADD:
services:
  embedding-adapter:
    build: ./packages/embedding-adapter
    expose:
      - "8095"
    environment:
      EMBEDDING_PROVIDER: jina
      RERANK_PROVIDER: jina
      JINA_API_KEY: ${JINA_API_KEY}
      PORT: 8095
    healthcheck:
      test: ["CMD", "wget", "-q", "-O-", "http://localhost:8095/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 5s
```

Update engine env: `EMBEDDINGS_URL=http://embedding-adapter:8095`

## 7. Alternatives Considered (review-fix)

### LiteLLM as backend
[LiteLLM](https://github.com/BerriAI/litellm) provides multi-provider embedding/rerank proxying with built-in rate-limiting, retry, and cost tracking. **Evaluated; rejected** because: (a) LiteLLM is Python — adds a second runtime to a TypeScript monorepo, complicating Docker image and dev workflow; (b) the adapter needs only 3 endpoints and 4 providers — LiteLLM's 100+ provider support is overkill; (c) TEI contract fidelity (raw `number[]` response, no wrapper) requires a custom translation layer anyway, negating LiteLLM's value proposition. Worth reconsidering IF multi-provider routing becomes significantly more complex.

### TypeScript vs Python (for the adapter itself)
TypeScript/Fastify chosen over Python/FastAPI because: (a) the adapter lives in a TypeScript monorepo (`packages/`) — same toolchain, same `pnpm`, same CI; (b) Node.js undici provides best-in-class HTTP client with SSRF-pinning and connection pooling; (c) type safety aligns with the engine's TypeScript codebase for contract validation. Python would require a separate Docker base image and dual-language maintenance burden.

### ONNX Runtime (local model)
Running BGE-M3 via `onnxruntime-node` locally would eliminate network dependency entirely (~10ms latency). **Trade-off rejected** for this feature because the goal is RAM reduction — ONNX still uses ~1-2GB RAM for the model weights, vs <100MB for the cloud proxy. ONNX remains a valid option for CI/development environments where absolute latency matters more than RAM.

## 8. Cost Model (review-fix)

Rough estimates for typical RAG workloads:

| Provider | Operation | Price | Est. daily cost (10K docs) | Monthly |
|----------|-----------|-------|---------------------------|---------|
| Jina | embed (1024-dim) | $0.02/1M tokens | ~$1/day (5K tokens × 10K) | ~$30 |
| Jina | embed (2048-dim) | $0.04/1M tokens | ~$2/day | ~$60 |
| OpenAI | embed (1536-dim) | $0.02/1M tokens | ~$1/day | ~$30 |
| Cohere | rerank | $1.00/1K searches | varies by volume | — |
| Jina | rerank | $0.02/1K docs | ~$0.20/day (10K docs) | ~$6 |

**Note**: TEI was free (self-hosted compute). The adapter introduces per-request API costs. Operators deploying at scale should budget accordingly and consider `MAX_INPUT_CHARS` to prevent runaway costs on oversized payloads.
