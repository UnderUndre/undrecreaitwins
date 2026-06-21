# Feature Specification: Embedding Adapter (TEI-to-Cloud Bridge)

**Feature Branch**: `025-embedding-adapter`  
**Created**: 2026-06-21  
**Status**: CLARIFIED (session 2026-06-21)
**Input**: User request to replace local TEI Docker containers with cloud LLM provider API routes.

## 1. Overview
The engine currently relies on HuggingFace TEI (Text Embeddings Inference) docker containers running locally (`tei-embed` and `tei-rerank`) to generate embeddings (BGE-M3) and perform reranking (BGE-reranker-v2-m3). These containers consume substantial RAM/CPU, making low-resource environments (like local development, local testing, or cheap VMs) highly constrained.

This feature introduces a lightweight proxy service (`packages/embedding-adapter` in TypeScript/Fastify) running on a single combined port (default `8095` or configured via `PORT`). It mimics the TEI API contract but translates and forwards the requests under the hood to cloud APIs (such as OpenAI for embeddings, and Cohere or Jina for rerank). It acts as a **drop-in replacement for Jina/Cohere providers** (which return 1024-dim embeddings natively matching pgvector `vector(1024)`) in `docker-compose.standalone.yml`, routing both embeddings and reranking requests to this single service. OpenAI providers require pgvector re-indexing due to dimension mismatch (see §Clarifications).

## 1.1 Tradeoffs & Privacy Warning

**This adapter transmits document content (`inputs` for `/embed`, `documents` for `/rerank`) to a third-party cloud provider.** TEI kept all data local. Ensure compliance with your data-handling policy before deploying with sensitive content (PII, proprietary code, internal documents).

The adapter trades local RAM savings for:

| Dimension | TEI (local) | Adapter (cloud proxy) |
|-----------|-------------|----------------------|
| RAM | ~4GB per container | <100MB RSS |
| Latency | ~10-50ms RTT (local) | +200-800ms cloud RTT |
| Cost | Free (self-hosted compute) | Per-request API billing (see `research.md §Cost Model`) |
| Privacy | Data stays in VPC | Data sent to cloud provider |
| Key management | None (local model) | API keys required (env or header) |
| Provider outage impact | N/A (no dependency) | Adapter degrades; engine must fail-open |

## 2. User Scenarios & Testing

### User Story 1 - Proxy Embeddings (Priority: P1)
A developer runs the engine without local GPU/heavy CPU containers by directing `EMBEDDINGS_URL` to the adapter.
- **Why this priority**: Core requirement to support text embedding generation without hosting models.
- **Independent Test**: Directly calling `POST /embed` with a single string or array of strings, getting back raw float vectors matching the input format.
- **Acceptance Scenarios**:
  1. **Given** the adapter is configured with OpenAI provider, **When** `POST /embed` is called with `{"inputs": "test string"}`, **Then** the adapter calls OpenAI `/v1/embeddings` and returns a flat `number[]` array of floats.
  2. **Given** the adapter is configured with OpenAI provider, **When** `POST /embed` is called with `{"inputs": ["one", "two"]}`, **Then** the adapter returns a `number[][]` array containing two float vectors.

---

### User Story 2 - Proxy Rerank (Priority: P1)
The engine performs document retrieval and reranks chunks without running a local reranker container.
- **Why this priority**: Required for retrieval-augmented generation (RAG) quality steps.
- **Independent Test**: Directly calling `POST /rerank` with a query and candidate list, returning sorted indices and scores.
- **Acceptance Scenarios**:
  1. **Given** the adapter is configured with Cohere provider, **When** `POST /rerank` is called with a query and 3 documents, **Then** the adapter maps this to Cohere `/v1/rerank` and returns a list of `{ "index": number, "score": number }` sorted by score.

---

### User Story 3 - API Key Resolution & Headers (Priority: P2)
The adapter resolves API keys from server environment variables or dynamically forwards keys from incoming request headers.
- **Why this priority**: Supports multi-tenant scenarios where keys might vary, or simple static configurations.
- **Independent Test**: Verifying external calls have correct headers with token passed via headers or env.
- **Acceptance Scenarios**:
  1. **Given** incoming request has `Authorization: Bearer <token>`, **When** `/embed` or `/rerank` is called, **Then** the adapter forwards `<token>` to the external API instead of using the local fallback env key.

---

### User Story 4 - Compose Swap Integration (Priority: P2)
The operator disables `tei-embed` and `tei-rerank` in Docker Compose and stands up the adapter container.
- **Why this priority**: Enables immediate memory/CPU savings in standalone deployments.
- **Independent Test**: Checking docker container footprint and memory usage.
- **Acceptance Scenarios**:
  1. **Given** standalone compose running the adapter, **When** the engine starts up, **Then** it validates healthchecks and runs embedding/reranking smoothly with <100MB RAM overhead.

---

### Edge Cases
- **Missing or Empty inputs**: `POST /embed` with empty string or empty array. Adapter must return 400 Bad Request with clear JSON payload.
- **Batched limits**: Huge document lists sent to `/rerank`. Adapter rejects with `400 Bad Request` if input exceeds provider's documented max (Cohere=1000, Jina=2048). Error message includes the limit. No internal chunking — adapter is a thin proxy.
- **Embedding input size limits**: `/embed` rejects input strings exceeding `MAX_INPUT_CHARS` (default 8192 chars per string) with `400 Bad Request`. Protects against runaway cost and provider rejection on oversized payloads.
- **Upstream Failures**: OpenAI or Cohere returns 401/429/500. Adapter must log the error (without logging PII text) and pass the HTTP status back to the client as 502 Bad Gateway.
- **Upstream Timeout**: If the provider does not respond within `UPSTREAM_TIMEOUT_MS` (default 10000ms — shorter than TEI to protect chat-path latency), the adapter returns `504 Gateway Timeout`. No retry — the engine's `EmbeddingService` already has graceful degradation (fail-open on embedder outage).
- **Circuit breaker**: After `CIRCUIT_FAILURE_THRESHOLD` consecutive upstream failures (5xx/429/network errors, default 5) within a rolling 60s window, the adapter opens the circuit and returns `503 Service Unavailable` for `CIRCUIT_RESET_TIMEOUT` seconds (default 30) without calling the upstream. This prevents cascading timeouts from exhausting the engine's connection pool during a provider outage.
- **Concurrency limit**: Adapter limits concurrent in-flight upstream requests to `MAX_CONCURRENT_REQUESTS` (default 50). Requests exceeding this return `503 Service Unavailable`. Protects against burst load triggering provider rate limits and exhausting local sockets.
- **Missing Credentials**: If both the request `Authorization` header and the local env keys (`OPENAI_API_KEY`, etc.) are missing, the adapter must fail immediately and return `401 Unauthorized` back to the engine client.
- **JSON strictness**: The engine's legacy client expects ONLY raw arrays for `/embed` (no metadata, no wrapper keys). Any extra metadata returned will break the engine client.
- **Malformed upstream body**: If a provider returns 200 but with non-JSON or structurally invalid body (CDN error page, truncated JSON), the adapter catches the parse error and returns `502 Bad Gateway`.

## Clarifications

### Session 2026-06-21

- Q: Embedding dimension mismatch — BGE-M3 = 1024-dim, OpenAI text-embedding-3-small = 1536-dim. Existing pgvector index = `vector(1024)`. How to handle? → A: **Adapter warns but does NOT transform dimensions.** Operator must choose a provider returning 1024-dim (Jina `jina-embeddings-v3` with `dimensions=1024`, Cohere `embed-multilingual-v3.0`). OpenAI embedding support is documented as "requires re-indexing if used" — the adapter passes through whatever dimension the provider returns. On startup, if configured provider is known to return ≠1024, log a prominent warning.
- Q: Default embedding model ID per provider? → A: **Configurable via `EMBEDDING_MODEL` env, with defaults.** Jina: `jina-embeddings-v3` (supports `dimensions=1024` param). OpenAI: `text-embedding-3-small` (1536-dim, cheapest). Rerank model: configurable via `RERANK_MODEL`, defaults: Cohere `rerank-multilingual-v3.0`, Jina `jina-reranker-v2-base-multilingual`.
- Q: Upstream timeout behavior? → A: **Configurable via `UPSTREAM_TIMEOUT_MS` (default 10000ms — reduced from 30000 to protect chat-path latency).** On timeout → `504 Gateway Timeout` to client. No retry — engine's `EmbeddingService` already has graceful degradation. Operators with large rerank batches may increase this; the default is tuned for the dominant embedding use case.
- Q: Rerank batch limits — what if input exceeds provider's max (Cohere=1000)? → A: **Reject with 400 + provider limit in error message.** No internal chunking — adapter is a thin proxy, not a batch orchestrator. Engine handles its own batching if needed.
- Q: Health endpoint for docker-compose healthcheck? → A: **`GET /health` → `200 {"status":"ok","provider":"jina"}`** (liveness only, includes configured provider for debugging). No upstream connectivity check — keeps healthcheck fast and independent of external API availability.

### Functional Requirements
- **FR-001**: Implement `/embed` matching the TEI contract: `inputs: string | string[]` returning `number[] | number[][]`. **Dimension policy (clarif. 2026-06-21)**: adapter returns whatever dimension the provider yields — NO truncation/padding. Startup warning logged if provider is known to return ≠1024 (engine's pgvector is `vector(1024)`). Operators using OpenAI (1536/3072-dim) must re-index pgvector data. Jina/Cohere can return 1024 natively.
- **FR-002**: Implement `/rerank` matching the TEI contract: `query: string`, `documents: string[]` returning `Array<{ index: number, score: number }>`. **Contract requirement (clarif. 2026-06-21)**: adapter MUST pass `top_n: documents.length` explicitly to Cohere/Jina upstream APIs to prevent silent truncation (some providers default `top_n` to 10 if omitted).
- **FR-003**: Provider routing logic configurable via env: `EMBEDDING_PROVIDER` (`openai` | `jina`), `RERANK_PROVIDER` (`cohere` | `jina`). Model IDs configurable via `EMBEDDING_MODEL` (defaults: `jina-embeddings-v3` for Jina, `text-embedding-3-small` for OpenAI) and `RERANK_MODEL` (defaults: `rerank-multilingual-v3.0` for Cohere, `jina-reranker-v2-base-multilingual` for Jina). Jina embedding requests MUST pass `dimensions: 1024` parameter when model supports it.
- **FR-004**: Read incoming `Authorization` headers for API keys dynamically, fallback to `OPENAI_API_KEY`, `COHERE_API_KEY`, or `JINA_API_KEY` from local environment variables. If no key is resolved, the adapter MUST return a `401 Unauthorized` response to the client.
- **FR-005**: Strictly sanitize responses to remove cloud metadata (such as token usage or wrapper objects) before returning payload. **Response validation (clarif. 2026-06-21)**: sanitizer MUST validate upstream response shape via Zod schema and return `502 Bad Gateway` if shape doesn't match expected structure (protects against silent provider API drift).
- **FR-006** *(clarif. 2026-06-21)*: Implement `GET /health` returning `200 {"status":"ok","provider":"<EMBEDDING_PROVIDER>"}`. Liveness check only — no upstream connectivity test. Used by docker-compose healthcheck.
- **FR-007** *(review-fix 2026-06-21)*: Implement circuit breaker per embedding provider. After `CIRCUIT_FAILURE_THRESHOLD` (default 5) consecutive upstream failures within 60s, return `503 Service Unavailable` for `CIRCUIT_RESET_TIMEOUT` (default 30s) without calling upstream. Resets after timeout with a half-open probe. Protects the engine's connection pool from cascading timeouts during provider outages.
- **FR-008** *(review-fix 2026-06-21)*: Implement concurrency limiter (`MAX_CONCURRENT_REQUESTS`, default 50) via semaphore. Requests exceeding the limit return `503 Service Unavailable` with `Retry-After: 1` header. Prevents burst load from triggering provider rate limits and exhausting local sockets.
- **FR-009** *(review-fix 2026-06-21)*: Enforce `MAX_INPUT_CHARS` (default 8192) per string in `/embed` inputs. Reject with `400 Bad Request` if exceeded. Protects against runaway API cost and provider rejection on oversized payloads.
- **FR-010** *(review-fix 2026-06-21)*: Configure undici `Agent` with `keepAliveTimeout` for TLS connection reuse across requests to the same upstream provider. Required to meet SC-003 (<50ms overhead) by amortizing TLS handshake cost.

### Key Entities
- **Config**: Adapter service config containing environment configurations (providers, endpoints, default keys).
- **TEI Payload**: Request payload matching the HuggingFace TEI schema.

## Success Criteria

### Measurable Outcomes
- **SC-001**: Standalone docker-compose RAM footprint drops by at least 2GB by removing `tei-embed` and `tei-rerank`.
- **SC-002**: Verification test suite for `@undrecreaitwins/core` `EmbeddingService` passes cleanly using the adapter.
- **SC-003**: Proxy processing overhead remains under 50ms per request for typical payloads (<100KB request body) (excluding external API network flight). Large batch payloads may exceed this due to serialization cost.
- **SC-004**: No PII (user input or documents) is printed to the adapter logs.

## Out of Scope
- Support for hosting local ML models in the adapter (use standard TEI for that).
- Web dashboard or UI for config.
- Caching layer (relies on downstream clients or upstream proxies).
- Authentication logic *inside* the adapter (the adapter is trusted inside the local VPC, same as TEI was).
- **Full TEI contract fidelity**: adapter implements only the minimal TEI fields the engine uses (`inputs`, `query`, `documents`). TEI's extended params (`truncate`, `pooling`, `normalize`) are silently ignored — if the engine ever requires them, this is a known limitation, not a bug.
- **HTTPS termination at the adapter**: the adapter listens on plain HTTP and MUST be deployed inside a trusted network (Docker internal network or VPN). TLS termination is the responsibility of a reverse proxy or the container orchestration layer.
