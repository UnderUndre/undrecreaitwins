# Research: Twin Engine Foundation

**Spec**: `specs/001-twin-engine-foundation/spec.md`
**Date**: 2026-05-25

## Key Decisions Resolved

### 1. HTTP Framework: Fastify over Hono

Fastify chosen for:
- Plugin ecosystem (fastify-multipart, fastify-cors, fastify-rate-limit)
- Schema-based validation via JSON Schema (integrates with OpenAPI generation)
- Lifecycle hooks for tenant middleware injection
- Proven at scale (used by Near, PostHog)

### 2. ORM: Drizzle over Prisma/TypeORM

Drizzle chosen for:
- SQL-like query builder — no abstraction leak
- Lightweight, tree-shakeable
- Native JSONB support with `$type<T>()` for typed JSON columns
- `drizzle-kit` migration generation from schema definitions
- No runtime query engine binary (unlike Prisma)

### 3. Memory: Letta as primary, in-context fallback

Letta provides:
- Best-in-class LongMemEval (83%)
- Self-editing archival/recall memory
- Per-agent memory namespaces (maps to `tenant_id/persona_id/conversation_id`)
- Open-source, self-hosted

Fallback: When Letta is unreachable, conversation uses in-context window only. Degraded mode flagged in `/health`. **Recovery**: On Letta reconnection, messages table acts as source of truth. Letta agents are resynced by replaying stored messages (from `messages` table) since last Letta checkpoint. Resync runs as background job per affected conversation, not blocking the chat path.

### 4. Channel Architecture: Redis pub/sub for decoupling

Pattern:
```
Adapter → twin.message.in.{channel_id} → Core (subscriber)
Core → twin.message.out.{channel_id} → Adapter (subscriber)
```

Benefits:
- Adapter crash ≠ core crash
- Horizontal adapter scaling (multiple workers per channel type)
- Language-agnostic (future Go/Rust adapters possible)
- Redis already required for BullMQ — no new infra dependency

### 5. Training Pipeline: BullMQ for async jobs

BullMQ provides:
- Job persistence (survives restarts)
- Progress tracking (maps to `progress_percent` field)
- Retry with exponential backoff
- Already part of `@undrestrator/infra-client` SDK

### 6. Multi-Tenant Isolation Strategy

Three layers:
1. **Application layer**: `WHERE tenant_id = :id` in every repository query
2. **Connection-level context**: `SET app.current_tenant = '<id>'` per request
3. **PostgreSQL RLS**: Defense-in-depth — `USING (tenant_id = current_setting('app.current_tenant')::uuid)`

Messages table: No direct `tenant_id` (lean). RLS via EXISTS join on parent conversation.

### 7. OpenAI Compatibility

Endpoint: `POST /v1/chat/completions`
- `model` field accepts persona slug
- Request/response shapes match OpenAI Chat Completions spec verbatim
- `stream: true` → SSE with `data: {...}\n\n` + `data: [DONE]\n\n`
- Error shapes: `{error: {message, type: "invalid_request_error", code: "model_not_found"}}`

### 8. Qdrant Collection Naming

Convention: `tenant_{tenant_id}_persona_{persona_id}`
- Cross-tenant access fails at Qdrant layer (collection doesn't exist for wrong tenant)
- Auto-created on first persona use via `@undrestrator/infra-client` SDK

## External Dependencies Resolved

| Dependency | Version | Notes |
|-----------|---------|-------|
| Fastify | 5.x | HTTP framework |
| Drizzle ORM | latest | Postgres ORM |
| drizzle-kit | latest | Migration tool |
| ioredis | 5.x | Redis client |
| Telegraf | 4.x | Telegram Bot API |
| BullMQ | 5.x | Job queue |
| Vitest | 3.x | Testing |
| testcontainers | latest | Docker-based E2E |
| Zod | 3.x | Runtime validation |
| pino | latest | Structured logging (Fastify default) |

## Open Questions (None Remaining)

All `NEEDS CLARIFICATION` items from spec resolved during clarify phase.
