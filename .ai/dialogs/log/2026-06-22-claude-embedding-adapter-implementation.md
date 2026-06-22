# Session Log: Embedding Adapter Implementation

## What was done / problem solved
- Implemented `packages/embedding-adapter` package from scratch (T001-T045).
- Created Fastify microservice to proxy TEI requests `/embed` and `/rerank` to cloud providers (Jina, OpenAI, Cohere).
- Fixed critical issues identified by `@gemini-code-assist` review comments (concurrency leaks, client abort circuit-breaking logic, circuit-breaker reset metrics, and style guide compliant structural error checks).
- Replaced `tei-embed` and `tei-rerank` in `docker-compose.standalone.yml` with the lightweight `embedding-adapter` proxy, reducing baseline RAM requirement by ~4GB.
- Moved `tei-embed` and `tei-rerank` containers to a conditional `local-tei` compose profile so they don't run by default.
- Added custom `OPENAI_BASE_URL` env configuration override to support any OpenAI-compatible custom provider endpoint.
- Verified everything with a Vitest suite containing 17 integration, benchmark, and cross-package degradation tests.

## Key decisions and trade-offs
- Refactored `index.ts` to export Fastify `app` configuration from `app.ts`. This allowed using Fastify `app.inject` in integration tests for instant, in-process mock runs, and spawning a real listening server during E2E engine degradation checks.
- Kept the returned shape of `/embed` as `number[][]` (even for single string input) to exactly match how the engine client processes the response (`data[0]`).
- Mapped all client aborts (`request.signal`) to be ignored by the circuit breaker to avoid false failure accumulation.

## Final artifacts
- `packages/embedding-adapter/src/app.ts` (Fastify configurations & route registrations)
- `packages/embedding-adapter/src/index.ts` (Fastify listen & graceful shutdown)
- `packages/embedding-adapter/src/config.ts` (Zod environment config validation schema)
- `packages/embedding-adapter/src/types.ts` (TEI request/response interfaces)
- `packages/embedding-adapter/src/lib/auth.ts` (API key resolver)
- `packages/embedding-adapter/src/lib/errors.ts` (Custom AppError classes and HTTP mapping)
- `packages/embedding-adapter/src/lib/sanitize.ts` (Validation and field stripping schemas)
- `packages/embedding-adapter/src/lib/circuit-breaker.ts` (Fail-fast state machine)
- `packages/embedding-adapter/src/lib/concurrency.ts` (Semaphore rate limiter)
- `packages/embedding-adapter/src/providers/` (Jina, Cohere, OpenAI adapters)
- `packages/embedding-adapter/test/integration.test.ts` (API integration tests)
- `packages/embedding-adapter/test/benchmark.test.ts` (Overhead checks)
- `packages/embedding-adapter/test/engine-degradation.test.ts` (Cross-package client fallback checks)
- `packages/embedding-adapter/Dockerfile` (Alpine runner image)
- `packages/embedding-adapter/README.md` (Quick start guide)
- `infra/docker-compose.standalone.yml` (Updated compose with profiles)
- `specs/025-embedding-adapter/quickstart.md` (Updated integration instructions)
- `specs/025-embedding-adapter/tasks.md` (Tasks marked as completed)

## Issues or follow-ups flagged
- OpenAI still returns 1536-dimensional embeddings, which requires pgvector table re-indexing inside the database if selected instead of Jina. Warning logs are printed during startup/diagnostics to alert the operators.
