# Implementation Plan: Embedding Adapter (TEI-to-Cloud Bridge)

**Branch**: `025-embedding-adapter` | **Date**: 2026-06-21 | **Spec**: `specs/025-embedding-adapter/spec.md`
**Input**: Feature specification from `specs/025-embedding-adapter/spec.md`

**Note**: This template is filled in by the `/speckit.plan` command.

## Summary

Replace local HuggingFace TEI Docker containers (`tei-embed`, `tei-rerank` consuming ~4GB RAM) with a lightweight TypeScript/Fastify proxy service that mimics the TEI HTTP contract but forwards embeddings to cloud providers (OpenAI/Jina) and reranking to cloud providers (Cohere/Jina). Single service on port 8095, drop-in replacement in docker-compose.standalone.yml.

## Technical Context

**Language/Version**: TypeScript 5.x, Node.js >= 20 (strict ESM)
**Primary Dependencies**: Fastify (HTTP server), undici (fetch replacement, SSRF-pinning), zod (validation), pino (logging)
**Storage**: N/A (stateless proxy — no DB)
**Testing**: Vitest (unit + integration with nock/MSW for HTTP mocking)
**Target Platform**: Linux container (Docker), single microservice
**Project Type**: Web-service (thin proxy)
**Performance Goals**: <50ms overhead per request (excluding upstream network), <100MB RSS
**Constraints**: Must match existing TEI contract exactly — engine client expects raw `number[][]` for `/embed` and `Array<{index, score}>` for `/rerank`. No metadata in responses. No CORS required — engine-to-adapter is server-to-server inside Docker network. Graceful shutdown on SIGTERM for clean compose teardown. **Explicit `bodyLimit` (review-fix) — default 1MB, configurable via `BODY_LIMIT`. Adapter MUST be deployed inside a trusted network (Docker internal network or VPN) — no HTTPS termination at the adapter layer.**
**Scale/Scope**: Single container, <100 req/s sustained, stateless horizontal scaling via plain Docker. **Concurrency capped at `MAX_CONCURRENT_REQUESTS`=50 (review-fix) to prevent provider rate-limit cascading.**

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Check | Status |
|-----------|-------|--------|
| I. Source of Truth Discipline | N/A — no .claude/ changes | ✅ PASS |
| II. Transformer, Not Fork | N/A — no new AI target | ✅ PASS |
| III. Protected Slots | N/A | ✅ PASS |
| IV. SemVer Discipline | N/A — no CLI version bump | ✅ PASS |
| V. Token Economy | N/A — no new agents/skills | ✅ PASS |
| VI. Cross-AI Review Gate | Required before `/speckit.implement` | ✅ MET — analyze.md PASS + claude.md MEDIUM + cline.md MEDIUM (2 distinct external reviewers). Review findings applied via `/fix_from_review`. |
| VII. Artifact Versioning | Snapshot after each phase | ⚠️ DEFERRED — no git repo initialized for this worktree. Snapshots will be created when git is available. Zero impact on artifact quality. |
| VIII. Self-Maintaining Knowledge | N/A | ✅ PASS |

**Verdict**: PASS — no constitutional violations. New `packages/embedding-adapter` is a standard new package following existing monorepo patterns.

## Project Structure

### Documentation (this feature)

```text
specs/025-embedding-adapter/
├── plan.md              # This file
├── research.md          # Phase 0 — provider API contract comparison
├── data-model.md        # Phase 1 — env config schema, type definitions
├── quickstart.md         # Phase 1 — local dev + compose integration
├── contracts/           # Phase 1 — OpenAPI/Swagger spec, TEI contract ref
└── tasks.md             # Phase 2 — task breakdown
```

### Source Code (repository root)

```text
packages/embedding-adapter/
├── src/
│   ├── index.ts              # Fastify server bootstrap
│   ├── config.ts             # Environment config schema (Zod)
│   ├── routes/
│   │   ├── embed.ts          # POST /embed handler
│   │   ├── rerank.ts         # POST /rerank handler
│   │   └── health.ts         # GET /health handler
│   ├── providers/
│   │   ├── types.ts          # Provider interface
│   │   ├── openai-embed.ts   # OpenAI embedding adapter
│   │   ├── jina-embed.ts     # Jina embedding adapter
│   │   ├── cohere-rerank.ts  # Cohere rerank adapter
│   │   └── jina-rerank.ts    # Jina rerank adapter
│   ├── lib/
│   │   ├── auth.ts           # API key resolution (header vs env)
│   │   ├── sanitize.ts       # Response sanitization (strip metadata)
│   │   └── errors.ts         # Error handling & status mapping
│   └── types.ts              # Shared types (TEI contract)
├── test/
│   ├── embed.test.ts
│   ├── rerank.test.ts
│   ├── auth.test.ts
│   └── health.test.ts
├── package.json
├── tsconfig.json
├── Dockerfile
└── README.md
```

**Structure Decision**: Single package under `packages/embedding-adapter/` following the same layout as other engine packages (`packages/core`, `packages/api`). No new monorepo workspace group needed — registered in existing root `pnpm-workspace.yaml`.

