# Project Architecture

## 1. Monorepo Structure

- `packages/shared`: Common types, errors, utilities.
- `packages/core`: Business logic, database models, core services.
- `packages/api`: REST API implementation.
- `packages/memory`: Memory management (Letta).
- `packages/training`: Training pipeline (BullMQ).
- `packages/cli`: `twin` CLI tool.
- `packages/channel-*`: Real-time channel adapters (Telegram, WhatsApp).

## 2. Core Service Patterns

- **Repositories**: Drizzle-based CRUD with tenant isolation.
- **Services**: Complex business logic orchestration.
- **Middleware**: Authentication, tenant resolution, error handling.
- **Vector Search**: pgvector via Drizzle, hybrid search capabilities.

## 3. Data Flow

1. Request arrives at `packages/api`.
2. Tenant resolved via middleware.
3. Controller delegates to `packages/core` services.
4. Services interact with `core` models and `packages/memory/RAG`.
5. Response returned to client.

## 4. Feature Tracking

- [001-twin-engine-foundation]: Persona CRUD, chat completions, isolation.
- [002-streaming-completions]: SSE streaming for chat.
- [003-script-funnels]: Scripted dialog runtime (Deterministic matching, stages, slots).
- [004-validators]: Response and input validators (false-promise, format-injection) via synchronous pipeline.
- [005-fact-grounding]: RAG runtime using pgvector, BGE-M3 embeddings, and TS-native parsing (shared substrate with 008).
- [006-mtproto-channel]: MTProto Telegram Userbot adapter (GramJS) with rate-limiting and typing indicators.
