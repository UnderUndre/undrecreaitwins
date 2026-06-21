# Context for External Review: 025-embedding-adapter

You are an independent AI reviewer. Run `/speckit.review` for this feature.

## Provider Self-Identification

Identify yourself. Use the **first applicable** rule:

| Signal | Tag |
|--------|-----|
| Codex Desktop / Codex CLI | `codex` |
| Google Antigravity IDE | `antigravity` |
| Gemini CLI / `gemini -p` | `gemini` |
| GitHub Copilot Chat | `copilot` |
| Claude variant (fallback) | `claude` |
| Unknown | Ask user |

Write review to `specs/025-embedding-adapter/reviews/<provider>.md`. Strictly read-only — never edit spec/plan/tasks.

## Feature Summary

**What**: Lightweight TypeScript/Fastify proxy (`packages/embedding-adapter`) that replaces local HuggingFace TEI Docker containers (`tei-embed`, `tei-rerank`, ~4GB RAM each) with cloud API calls.

**Contract**: Mimics TEI HTTP contract exactly (raw `number[] | number[][]` for `/embed`, `Array<{index, score}>` for `/rerank`). No metadata wrapping.

**Endpoints**: `POST /embed`, `POST /rerank`, `GET /health` — single service on port 8095.

**Providers**: Jina (recommended, 1024-dim embeddings), OpenAI (1536-dim, needs re-indexing), Cohere (rerank), Jina (rerank).

## Artifacts to Review

| Artifact | Path | Required |
|----------|------|----------|
| **spec.md** | `specs/025-embedding-adapter/spec.md` | ✅ |
| **plan.md** | `specs/025-embedding-adapter/plan.md` | ✅ |
| **tasks.md** | `specs/025-embedding-adapter/tasks.md` | ✅ |
| **data-model.md** | `specs/025-embedding-adapter/data-model.md` | Optional |
| **research.md** | `specs/025-embedding-adapter/research.md` | Optional |
| **contracts/** | `specs/025-embedding-adapter/contracts/openapi.yaml` | Optional |
| **quickstart.md** | `specs/025-embedding-adapter/quickstart.md` | Optional |
| **analyze.md** | `specs/025-embedding-adapter/reviews/analyze.md` | Optional (prior review) |
| **constitution** | `.specify/memory/constitution.md` | ✅ |

## Review Lenses

Apply each:

1. **Logical consistency** — requirements → plan → tasks traceability
2. **Hidden assumptions** — what's assumed but unspecified (e.g., network latency between adapter and engine)
3. **Missing edge cases** — concurrency, partial failures, retries, idempotency
4. **Failure modes** — what breaks when OpenAI/Cohere/Jina is down, slow, or returns garbage
5. **Security & privacy** — API key leakage, PII in logs, SSRF on upstream URLs, auth bypass between engine ↔ adapter
6. **Performance & scale** — `UPSTREAM_TIMEOUT_MS`=30000 is long for a chat path; no circuit breaker
7. **Alternative approaches** — was embedding adapter even the right call vs. lightweight ONNX runtime?
8. **Stakeholder clarity** — is "drop-in replacement" actually true given dimension mismatch?
9. **Constitution alignment** — violation → CRITICAL

## Previous Analysis Verdict

Internal analyze: **PASS** (all 4 findings fixed, 100% coverage, 39 tasks, 0 CRITICAL, 0 HIGH).

## Output Format

Write verdict block at end of review file:

```yaml
verdict: PASS | MEDIUM | HIGH | CRITICAL
reviewer: <your-tag>
reviewed_at: <ISO timestamp>
commit: <git SHA if available>
critical_count: <N>
high_count: <N>
medium_count: <N>
low_count: <N>
```
