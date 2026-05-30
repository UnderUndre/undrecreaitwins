# Boundary Ownership Audit: Engine vs Product

**ROLE**: Read-only code auditor.
**DATE**: 2026-05-29

## A. Engine /v1 API Surface
**Repository**: `C:\Repositories\underundre\underhelpers\under-ai-helpers\undrecreaitwins`
**Base URL**: `http://localhost:8090`

| Path | Method | Purpose | File:Line |
|------|--------|---------|-----------|
| `/v1/personas` | POST | Create a new persona (digital twin profile) | `api/src/routes/personas.ts:24` |
| `/v1/personas/:id` | GET | Retrieve persona configuration | `api/src/routes/personas.ts:45` |
| `/v1/personas/:id` | PATCH | Update persona configuration | `api/src/routes/personas.ts:60` |
| `/v1/personas` | GET | List personas for a tenant | `api/src/routes/personas.ts:85` |
| `/v1/chat` | POST | Send a message to a persona (stateless or session-based) | `api/src/routes/chat.ts:15` |
| `/v1/channels` | GET | List configured channels (adapters) | `api/src/routes/channels.ts:12` |
| `/v1/channels` | POST | Connect a new channel (e.g., Telegram) | `api/src/routes/channels.ts:25` |
| `/v1/chat/completions` | POST | OpenAI-compatible completions API | `api/src/routes/chat-completions.ts:23` |

**Drizzle DB Ownership**:
- `/v1/personas`: Writes to `personas` table (`core/src/models/personas.ts:4`).
- `/v1/chat`: `ChatService` writes to `conversations` (`core/src/models/conversations.ts:4`) and `messages` (`core/src/models/messages.ts:4`) via `persistMessages`.
- `/v1/channels`: Writes to `channel_instances` table.

> **Handler Signature (Chat)**:
> `fastify.post('/v1/chat', async (request, reply) => { ... return chatService.complete(...) })` (`api/src/routes/chat-completions.ts:23`)

## B. twin-client contract (product side)
**Repository**: `C:\Repositories\underundre\ai-twins`
**File**: `packages/twin-client/src/index.ts`

| Method | HTTP Call | Invoked by (Product) |
|--------|-----------|----------------------|
| `createPersona` | `POST /v1/personas` | `assistantRouter.create` (`apps/api/src/routers/assistant.ts:117`) |
| `getPersona` | `GET /v1/personas/:id` | `assistantRouter.get` (`apps/api/src/routers/assistant.ts:70`) |
| `updatePersona` | `PATCH /v1/personas/:id` | `assistantRouter.update` (`apps/api/src/routers/assistant.ts:160`) |
| `deletePersona` | `DELETE /v1/personas/:id` | `assistantRouter.delete` (`apps/api/src/routers/assistant.ts:212`) |
| `chat` | `POST /v1/chat` | (Internal use for web-chat/API proxy) |

## C. Persona <-> Assistant ownership

**Engine Drizzle `personas` model** (`core/src/models/personas.ts:4`):
```typescript
export const personas = pgTable('personas', {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    systemPrompt: text('system_prompt').notNull(),
    traits: jsonb('traits').notNull().$type<PersonaTraits>().default({}),
    modelPreferences: jsonb('model_preferences').notNull().$type<ModelPreferences>().default({}),
    // ... timestamps
});
```

**Product Prisma `Assistant` model** (`apps/api/prisma/schema.prisma:148`):
```prisma
model Assistant {
  id                  String   @id @default(cuid())
  tenantId            String   @map("tenant_id")
  twinEnginePersonaId String   @map("twin_engine_persona_id")
  name                String
  isActive            Boolean  @default(true) @map("is_active")
  version             BigInt   @default(0) @map("version")
  // ... relationships
}
```

**Source of Truth**:
- **Engine** is the source of truth for LLM configuration (`systemPrompt`, `traits`, `modelPreferences`).
- **Product** maps local `Assistant.id` to remote `twin_engine_persona_id`.
- **Creation Flow**: `assistantRouter.create` first calls `client.createPersona` and then stores the resulting `remote.id` in `Assistant.twinEnginePersonaId`.

## D. Conversation/Message ownership (THE SMELL)

**Engine Drizzle** (`core/src/models/conversations.ts:4`):
- `conversations` + `messages` are the **primary runtime store**.
- `ChatService.persistMessages` writes every turn:
```typescript
await tx.insert(messages).values(rows); // core/src/services/chat-service.ts:390
```

**Product Prisma** (`apps/api/prisma/schema.prisma:186`):
- `Conversation` + `Message` are explicitly labeled as `cache mirror from twin-engine`.
- **Writer Found?**: No direct writer found in `apps/api/src/routers/message.ts` or `assistant.ts`.
- **Verdict**: These tables are **mirrored/cached**. Since no writer exists in the TRPC routers, they are likely populated by a background sync job or incoming webhooks from the Engine (not yet implemented or hidden in workers/services).

## E. Tenancy across the boundary
- **Engine** is **tenant-aware**.
- Payloads and headers (`X-Tenant-ID`) carry `tenantId`.
- Models in Engine (`personas`, `conversations`, `usage_events`) all have a `tenant_id` column.
- Mapping: Product `Tenant.id` (cuid) is passed as `X-Tenant-ID` and stored as `uuid` in Engine.

## F. Verdict for new runtime features

| Feature | Target Placement | Reasoning |
|---------|------------------|-----------|
| **Dialog Funnels runtime** | **ENGINE** | Conversations execute here; logic needs zero-latency access to `ChatService` and `Letta` memory. |
| **Validators runtime** | **ENGINE** | Must run in the response pipeline (`ChatService.complete`) to block/rewrite assistant output before it leaves the engine. |
| **Re-engagement scanner** | **ENGINE** | Requires high-frequency scanning of the primary `conversations` table to detect staleness. |

## Ownership Ground Truth Summary
1. **Engine owns the DIALOGUE**: All stateful conversation data (Drizzle) lives in the Engine.
2. **Product owns the SHELL**: Prisma stores metadata for billing, UI, and tenant management.
3. **HTTP Coupling**: Product commands Engine via `twin-client`; Engine is headless.
4. **Mirroring**: `Conversation`/`Message` in Product are read-only mirrors for UI performance.
5. **Runtime Logic**: Any feature affecting "how the twin speaks" MUST live in the Engine.

---
Suggested output filename: `boundary_ownership_audit.md`
