# Project Requirements

## 1. Vision
Open-source headless AI-clone (digital twin) backend. Multi-tenant primitives.

## 2. Technical Stack

### 2.1 Core
- **Language**: TypeScript (Node.js >= 20)
- **Framework**: Fastify
- **Database**: PostgreSQL (via Drizzle ORM)
- **Cache/Queue**: Redis (ioredis + BullMQ)
- **Logging**: Pino
- **Validation**: Zod

### 2.2 AI/Memory
- **Memory**: Letta
- **RAG**: Qdrant
- **LLM Gateway**: OmniRoute (internal)

### 2.3 Quality
- **Testing**: Vitest
- **Linting**: ESLint/Prettier
- **Typing**: Strict TypeScript

## 3. Constraints
- Multi-tenant isolation is mandatory (tenant_id scoping).
- Optimistic locking for state mutations (versioning).
- No sensitive data (API keys, secrets) in logs or code.
