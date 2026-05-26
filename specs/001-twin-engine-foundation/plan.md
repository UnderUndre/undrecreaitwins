# Implementation Plan: Twin Engine Foundation

**Branch**: `001-twin-engine-foundation` | **Date**: 2026-05-25 | **Spec**: spec.md
**Input**: Feature specification from `specs/001-twin-engine-foundation/spec.md`

## Summary

Headless open-source AI-clone/digital-twin backend. Multi-tenant from day one: persona CRUD in Postgres via Drizzle ORM, conversation loop through OmniRoute LLM gateway + Letta memory + Qdrant RAG. Channel adapters (Telegram via Telegraf, WhatsApp via Evolution API) run as separate processes, communicate with core through Redis Streams (durable consumer groups) — adapter crash ≠ API crash. Twin training ingests chat exports (Telegram JSON, WhatsApp TXT, JSONL) in streaming fashion to avoid OOM on large dumps. OpenAI-compatible `/v1/chat/completions` endpoint so every LangChain-wielding startup can plug in without reading docs. CLI tool `twin` for power users. Apache 2.0 license. Consumers: Dvoiniki SaaS shell, third-party self-hosters, CLI users.

## Technical Context

**Language/Version**: TypeScript 5+ / Node 20+ (ESM)
**Primary Dependencies**: Fastify (HTTP), Drizzle ORM (Postgres), ioredis (Redis Streams), Telegraf (Telegram), @undrestrator/infra-client (LLM/Vector/Queue), Letta client (memory)
**Storage**: PostgreSQL ≥15 (JSONB, Drizzle ORM), Qdrant (vectors, per-tenant collections), Redis (pub/sub + BullMQ)
**Testing**: Vitest + Supertest (API integration), testcontainers (Docker-based E2E)
**Target Platform**: Linux server (Docker Compose), dev on macOS/Windows
**Project Type**: Monorepo (library + web-service + CLI + channel-adapters)
**Performance Goals**: ≥100 concurrent conversations on 4vCPU/8GB; p95 <5s channel E2E; OpenAI-compat 1:1
**Constraints**: Multi-tenant isolation by construction; stream-parse training files; Redis pub/sub for channel ↔ core decoupling
**Scale/Scope**: 7 packages, ~60-80 tasks

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **Principle VI (Cross-AI Review)**: Plan requires ≥2 external AI reviewers before implement. NEW repo — `specs/main/architecture.md` created as part of Phase 1.
- **Principle VII (Artifact Versioning)**: All spec artifacts version-controlled in `specs/`. Snapshot via `snapshot-stage.ps1`.
- **Principle VIII (Living Spec)**: Spec is source of truth. Plan/tasks downstream. Spec change → regenerate affected artifacts.
- **License**: Apache 2.0 for all code. No AGPL dependencies in code (only as infrastructure services). Per spec FR-032.

## Project Structure

### Documentation (this feature)

```
specs/001-twin-engine-foundation/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── rest-api.openapi.yaml
│   ├── channel-adapter.interface.ts
│   ├── pubsub-events.md
│   └── cli-commands.md
└── tasks.md
```

### Source Code (repository root)

```
packages/
├── core/                  # Persona CRUD, conversation orchestration, tenant middleware
│   ├── src/
│   │   ├── models/        # Drizzle schema definitions
│   │   ├── services/      # Business logic
│   │   ├── middleware/     # Tenant context, auth
│   │   └── routes/        # Fastify route handlers
│   └── tests/
├── api/                   # HTTP server (Fastify) exposing /v1/* + OpenAI-compat
│   ├── src/
│   │   ├── routes/
│   │   ├── middleware/
│   │   └── server.ts
│   └── tests/
├── channel-telegram/      # @undrecreaitwins/channel-telegram (Telegraf adapter)
│   ├── src/
│   └── tests/
├── channel-whatsapp/      # @undrecreaitwins/channel-whatsapp (Evolution API client)
│   ├── src/
│   └── tests/
├── training/              # Training pipeline (Telegram JSON, WhatsApp TXT, JSONL parsers)
│   ├── src/
│   │   ├── parsers/
│   │   ├── extractors/
│   │   └── jobs/
│   └── tests/
├── cli/                   # @undrecreaitwins/cli — `twin` command
│   ├── src/
│   └── tests/
├── memory/                # Letta integration + in-context fallback
│   ├── src/
│   └── tests/
└── shared/                # Shared types, errors, constants
    └── src/

infra/
├── docker-compose.standalone.yml
├── docker-compose.with-orchestra.yml
└── .env.example

drizzle.config.ts
pnpm-workspace.yaml
package.json (root, private)
```

**Structure Decision**: Monorepo with pnpm workspaces. Each channel is a separate package for independent versioning and optional installation. Core + API split keeps HTTP concerns separate from business logic. Training is its own package because parsers are large and independently testable.

## Operational Defaults

| Component | Timeout | Retries | Backoff | Circuit Breaker |
|-----------|---------|---------|---------|-----------------|
| Letta | 2s | 3 | 100ms / 300ms / 1s | Opens after 5 failures in 30s; half-open probe every 60s |
| OmniRoute (LLM) | 30s | 2 | 500ms / 2s | Opens after 5 failures in 30s; half-open probe every 60s |
| Qdrant (RAG) | 1s | 1 | 200ms | Fail-open: chat continues without RAG; `rag_unavailable: true` in response metadata |
| Redis | 1s | 3 | 100ms / 500ms / 2s | N/A (connection-level) |
| Evolution API | 5s | 5 (exponential) | 1s / 2s / 4s / 8s / 16s (max 5 min) | Opens after 10 failures in 60s |

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Channel-as-separate-process (Redis Streams) | Horizontal scaling, crash isolation, independent adapter worker scaling | In-process adapter: can't scale independently, adapter crash = API crash, different languages/runtimes for future adapters |
| OpenAI-compat surface area (full /v1/chat/completions parity) | Distribution unlock — any tool that speaks OpenAI speaks to twin-engine | Custom API: requires custom SDK, Dvoiniki devs learn proprietary API, LangChain/LlamaIndex need OpenAI compat anyway |
| Letta as external memory service | Best LongMemEval bench (83%), self-editing memory, OS-like agent model | In-context only: degrades over long conversations, no cross-session persistence. In-DB memory: no intelligent retrieval, no archival/recall distinction |
