# Data Model: Embedding Adapter

## 1. Environment Configuration (Zod Schema)

```typescript
import { z } from 'zod';

const EmbeddingProvider = z.enum(['openai', 'jina']);
const RerankProvider = z.enum(['cohere', 'jina']);

export const AdapterConfig = z.object({
  // Server
  PORT: z.coerce.number().default(8095),
  HOST: z.string().default('0.0.0.0'),

  // Embedding provider
  EMBEDDING_PROVIDER: EmbeddingProvider.default('jina'),
  EMBEDDING_MODEL: z.string().optional(), // defaults per provider in code

  // Rerank provider
  RERANK_PROVIDER: RerankProvider.default('jina'),
  RERANK_MODEL: z.string().optional(), // defaults per provider in code

  // API Keys (at least one required if not using header-based auth)
  OPENAI_API_KEY: z.string().optional(),
  COHERE_API_KEY: z.string().optional(),
  JINA_API_KEY: z.string().optional(),

  // Upstream timeout (reduced from 30000 per review — protects chat-path latency)
  UPSTREAM_TIMEOUT_MS: z.coerce.number().default(10_000),

  // Circuit breaker (review-fix)
  CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().default(5),
  CIRCUIT_RESET_TIMEOUT: z.coerce.number().default(30),

  // Concurrency limit (review-fix)
  MAX_CONCURRENT_REQUESTS: z.coerce.number().default(50),

  // Input size guard (review-fix)
  MAX_INPUT_CHARS: z.coerce.number().default(8192),

  // Fastify body limit in bytes (increased to support max rerank payload of ~8MB: 1000 docs × 8192 chars)
  BODY_LIMIT: z.coerce.number().default(9_000_000),

  // Logging
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type AdapterConfig = z.infer<typeof AdapterConfig>;
```

## 2. Type Definitions

### TEI Contract Types (Adapter's External Contract)

```typescript
// POST /embed
interface EmbedRequest {
  inputs: string | string[];
}

// POST /rerank
interface RerankRequest {
  query: string;
  documents: string[];
}

interface RerankResult {
  index: number;
  score: number;
}

// GET /health
interface HealthResponse {
  status: 'ok';
  provider: string;
}
```

### Internal Provider Abstraction

```typescript
interface EmbedProvider {
  readonly name: string;
  embed(
    inputs: string | string[],
    model: string,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<number[] | number[][]>;
}

interface RerankProvider {
  readonly name: string;
  rerank(
    query: string,
    documents: string[],
    model: string,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<RerankResult[]>;
}
```

### PII/Sensitive Header Redaction (review-fix)

Pino logger MUST redact the following paths from ALL log levels (not just error payloads):

```typescript
const redactPaths = [
  'req.headers.authorization',
  'req.headers["x-api-key"]',
  // Wildcard for any provider key header
  'req.headers["openai-api-key"]',
  'req.headers["cohere-api-key"]',
  'req.headers["jina-api-key"]',
  // Request body PII
  'req.body.inputs',
  'req.body.documents',
  'req.body.query',
  // Error log payload PII
  'err.inputs',
  'err.documents',
  'inputs',
  'documents',
];
```

Authorization header = Bearer token = cloud API key. Without redaction, pino's default request serializer leaks API keys to log aggregators (Datadog/Loki/CloudWatch).
```

## 3. API Key Resolution

```
Incoming Request
  ├── Authorization: Bearer <token>  → use <token> (dynamic, per-request)
  └── No Authorization header
       ├── EMBEDDING_PROVIDER=openai  → process.env.OPENAI_API_KEY
       ├── EMBEDDING_PROVIDER=jina    → process.env.JINA_API_KEY
       ├── RERANK_PROVIDER=cohere     → process.env.COHERE_API_KEY
       └── RERANK_PROVIDER=jina       → process.env.JINA_API_KEY
```

If no key resolved → `401 Unauthorized`.

## 4. Error Response Shape

```typescript
interface ErrorResponse {
  error: string;
  message: string;
}

// Examples:
// 400 — { error: "BAD_REQUEST", message: "inputs must be a non-empty string or array" }
// 400 — { error: "BAD_REQUEST", message: "inputs[0] exceeds MAX_INPUT_CHARS (8192)" }
// 401 — { error: "UNAUTHORIZED", message: "No API key provided" }
// 502 — { error: "UPSTREAM_ERROR", message: "Provider returned 500" }
// 502 — { error: "UPSTREAM_ERROR", message: "Provider response malformed: expected array, got string" }
// 503 — { error: "CIRCUIT_OPEN", message: "Circuit breaker open: 5 consecutive failures, retrying in 30s" }
// 503 — { error: "RATE_LIMITED", message: "Max concurrent requests (50) reached, retry later" }
// 504 — { error: "GATEWAY_TIMEOUT", message: "Provider did not respond within 10000ms" }
```

### HTTP Status Mapping (exhaustive, per review-fix)

| Scenario | Trigger | Adapter Response |
|----------|---------|------------------|
| Bad request (invalid input, oversized) | Zod validation fails | `400 BAD_REQUEST` |
| Missing credentials | No `Authorization` header AND no env key | `401 UNAUTHORIZED` |
| Upstream auth error | Provider returns 401 | `502 UPSTREAM_ERROR` (don't expose upstream 401 — avoid credential oracle) |
| Upstream rate limited | Provider returns 429 | `502 UPSTREAM_ERROR` |
| Upstream server error | Provider returns 5xx | `502 UPSTREAM_ERROR` |
| Upstream bad request | Provider returns 400 (bad model etc.) | `502 UPSTREAM_ERROR` |
| Upstream malformed body | `JSON.parse` throws or Zod response validation fails | `502 UPSTREAM_ERROR` |
| Network error | `fetch()` throws (`ENOTFOUND`, `ECONNREFUSED`, etc.) | `502 UPSTREAM_ERROR` |
| Circuit breaker open | `CIRCUIT_FAILURE_THRESHOLD` exceeded in 60s window | `503 CIRCUIT_OPEN` + `Retry-After` header |
| Concurrency limit hit | `MAX_CONCURRENT_REQUESTS` in-flight | `503 RATE_LIMITED` + `Retry-After: 1` |
| Upstream timeout | `AbortController` fires at `UPSTREAM_TIMEOUT_MS` | `504 GATEWAY_TIMEOUT` |

## 5. Model Defaults

| Provider | Role | Default Model | Dim | Notes |
|----------|------|---------------|-----|-------|
| Jina | embed | jina-embeddings-v3 | 1024 | Pass `dimensions: 1024` |
| OpenAI | embed | text-embedding-3-small | 1536 | Warning logged on startup. **Response-side dim-check log (review-fix)**: if response vector dimension ≠ 1024, log a structured warning with provider name and actual dimension for faster diagnostics. |
| Cohere | rerank | rerank-multilingual-v3.0 | — | Max 1000 docs. **Pass `top_n: documents.length` explicitly (review-fix).** |
| Jina | rerank | jina-reranker-v2-base-multilingual | — | Max 2048 docs. **Pass `top_n: documents.length` explicitly (review-fix).** |

## 6. Initial Package Version (review-fix)

T001 scaffolds `packages/embedding-adapter/package.json` with initial version `0.1.0` (0.x convention per constitution Principle IV — pre-1.0, MINOR for breaking/feature).
