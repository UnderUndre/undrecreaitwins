# SpecKit Review: 025-embedding-adapter

**Reviewer**: claude
**Reviewed at**: 2026-06-21T19:20:00Z
**Commit**: a1a03e2bb901b180b1a3c4e3dbc0c1a1bbf541d0
**Artifacts reviewed**: spec.md, plan.md, tasks.md, data-model.md, research.md, quickstart.md, constitution.md

## Summary

The spec is well-structured with clear priorities, sensible edge case coverage, and a clean separation of concerns. The plan correctly identifies the stateless proxy pattern and the tasks have a well-thought-out dependency graph. The headline weakness is the absence of any rate-limiting or circuit-breaker strategy for upstream providers — the adapter is a thin proxy that will pass through provider 429s directly to the engine, and the 30s default timeout is dangerously long for a chat-path dependency. Additionally, the "drop-in replacement" claim is misleading for OpenAI users due to dimension mismatch, and the spec assumes but never verifies that the engine's `EmbeddingService` graceful degradation actually works under the failure modes this adapter introduces.

## Findings

| ID | Severity | Area | Finding | Recommendation |
|---|---|---|---|---|
| F1 | HIGH | Performance & scale | `UPSTREAM_TIMEOUT_MS` default of 30,000ms is excessive for a chat-path dependency. If the engine calls `/embed` during a user-facing request (e.g., RAG for a chat response), a 30-second upstream timeout means the user waits 30 seconds for a timeout error. The spec says "engine's EmbeddingService already has graceful degradation (fail-open on embedder outage)" — but this assumes the engine's timeout is shorter than the adapter's, which is not guaranteed. | Either reduce default to 5,000–10,000ms, or document that the engine's timeout MUST be lower than `UPSTREAM_TIMEOUT_MS`. Add a startup warning if `UPSTREAM_TIMEOUT_MS` > engine's expected timeout. |
| F2 | HIGH | Failure modes | No circuit breaker or rate-limit awareness. If the upstream provider returns 429 (rate limited), the adapter blindly passes it through as 502. The engine's "graceful degradation" may not distinguish between a transient 429 and a permanent 500. Repeated 429s could cause cascading retries that worsen the rate-limit situation. | Add a simple per-provider circuit breaker (e.g., after 3 consecutive 5xx/429 in 60s, open circuit for 30s and return 503 immediately). At minimum, document that this is absent and the engine must handle 429 retry storms. |
| F3 | HIGH | Hidden assumptions | The spec assumes the engine's `EmbeddingService` graceful degradation works correctly under all failure modes the adapter introduces, but there is no test or verification of this. The adapter introduces new failure modes (upstream timeout, provider 429, dimension mismatch) that the engine may not have been designed to handle. | Add a task to verify engine behavior under adapter failure modes (T040: "Verify engine EmbeddingService graceful degradation with adapter timeouts and 502s"). This should be a cross-package integration test. |
| F4 | MEDIUM | Security & privacy | The adapter forwards `Authorization: Bearer <token>` from the engine to the upstream provider without any validation. If the engine sends a key intended for a different service (e.g., a database API key), the adapter will happily send it to OpenAI/Cohere/Jina, potentially leaking credentials. | Add a basic key format validation per provider (e.g., OpenAI keys start with `sk-`, Jina keys start with `jina_`). Log a warning if the key format doesn't match the expected provider. |
| F5 | MEDIUM | Missing edge cases | No input size limits for `/embed`. A single string of 100K+ tokens could be sent to the upstream provider, causing excessive cost, latency, or provider rejection. The spec has batch limits for `/rerank` (1000/2048 docs) but nothing for embedding input size. | Add a configurable `MAX_INPUT_CHARS` or `MAX_INPUT_TOKENS` env var (default e.g. 8192 chars per input). Reject with 400 if exceeded. |
| F6 | MEDIUM | Missing edge cases | No handling of concurrent request limits or connection pooling. If the adapter receives 100 concurrent `/embed` requests, it opens 100 concurrent connections to the upstream provider. This could exhaust local socket resources or trigger provider rate limits. | Add a configurable `MAX_CONCURRENT_REQUESTS` env var with a semaphore-based limiter. Return 503 if limit exceeded. Document that undici connection pooling should be configured. |
| F7 | MEDIUM | Stakeholder clarity | The spec uses "drop-in replacement" (spec.md line 11) but this is not accurate for OpenAI users — OpenAI returns 1536-dim vectors while the engine's pgvector index is `vector(1024)`. The clarification section (line 64) correctly notes this, but the overview still says "drop-in replacement" without qualification. | Change "drop-in replacement" to "drop-in replacement for Jina/Cohere providers; OpenAI requires re-indexing" in the overview. |
| F8 | MEDIUM | Logical consistency | plan.md §Technical Context says "No CORS required — engine-to-adapter is server-to-server inside Docker network" but T022 says "register routes, CORS, healthcheck, graceful shutdown". CORS registration is listed as a task despite being explicitly not needed. | Remove CORS from T022 description, or add a comment that CORS is disabled by default but configurable for non-Docker deployments. |
| F9 | LOW | Missing edge cases | No handling of provider response shape changes. If OpenAI changes their `/v1/embeddings` response format (e.g., adds a new wrapper field, changes `data` structure), the adapter will either crash or return malformed data. | Add response schema validation (Zod) for upstream provider responses. Log a structured error if the response doesn't match expected shape. |
| F10 | LOW | Performance & scale | SC-003 targets <50ms overhead per request, but this doesn't account for serialization/deserialization of large payloads. A rerank with 1000 documents of 512 tokens each involves serializing ~500KB of JSON, sending it over the network, deserializing the response — this alone could exceed 50ms. | Clarify SC-003: "50ms overhead for typical payloads (<100KB request body)". Add a note that large payloads may exceed this. |
| F11 | LOW | Alternative approaches | The research.md explores FastAPI/Python as an alternative but the spec chose TypeScript/Fastify. This is a reasonable choice given the existing monorepo, but the research doesn't explicitly compare the two options (development speed vs. type safety vs. ecosystem fit). | Add a brief comparison in research.md or plan.md explaining why TypeScript was chosen over Python for this proxy. |
| F12 | LOW | Security & privacy | No mention of HTTPS between engine and adapter. If the adapter is deployed on a different host (not in the same Docker network), traffic is in plaintext HTTP. | Document that the adapter should only be used within a trusted network (Docker internal network or VPN). Add a note in quickstart.md. |

## Alternative approaches considered

1. **ONNX Runtime Web**: Running a lightweight ONNX model (e.g., all-MiniLM-L6-v2) directly in Node.js via `onnxruntime-node` would eliminate network dependency entirely and provide deterministic latency (~10ms per embedding). The trade-off is lower quality vs. cloud models and ~200MB model download. Worth considering for development/CI environments where absolute quality isn't needed.

2. **LiteLLM as backend**: Using LiteLLM as the upstream provider router (adapter → LiteLLM → OpenAI/Cohere/Jina) would give free rate-limiting, retry logic, and cost tracking. The adapter would still need the TEI→LiteLLM mapping layer, but LiteLLM handles the provider complexity. Worth considering if multi-provider routing becomes more complex.

3. **Sidecar pattern**: Instead of a separate service, the adapter could be a library loaded by the engine's `EmbeddingService` directly. This would eliminate network hop overhead and simplify deployment (no separate container). Trade-off: tighter coupling and language constraint (TypeScript only).

## VERDICT

```yaml
verdict: MEDIUM
reviewer: claude
reviewed_at: 2026-06-21T19:20:00Z
commit: a1a03e2bb901b180b1a3c4e3dbc0c1a1bbf541d0
critical_count: 0
high_count: 3
medium_count: 5
low_count: 4
