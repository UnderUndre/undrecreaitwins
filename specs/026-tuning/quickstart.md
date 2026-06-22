# Quickstart: Engine Tuning

## Prerequisites

- Engine running locally (PostgreSQL + Redis + API)
- At least one persona with documents uploaded (for doc-extraction method)
- `X-Tenant-ID` header value for your test tenant

## Local Dev Setup

### 1. Generate DB Migration

```bash
cd underhelpers/under-ai-helpers/undrecreaitwins
pnpm db:generate
```

This creates a new migration file in `drizzle/` for the `tuning_drafts` table.

### 2. Apply Migration

```bash
pnpm db:migrate
```

### 3. Start the API

```bash
# From the monorepo root
pnpm --filter @undrecreaitwins/api dev
```

## API Walkthrough

### User Story 1: Doc Extraction → Draft → Activate

#### Step 1: Generate a draft from documents

```bash
curl -X POST http://localhost:3000/v1/personas/:personaId/tuning/generate \
  -H "Authorization: Bearer <token>" \
  -H "X-Tenant-ID: <tenantId>" \
  -H "Content-Type: application/json" \
  -d '{"method": "doc-extraction"}'
```

**Expected response** (202):

```json
{
  "draftId": "uuid-here",
  "status": "generating"
}
```

#### Step 2: Poll until ready

```bash
curl http://localhost:3000/v1/tuning/drafts/:draftId \
  -H "Authorization: Bearer <token>" \
  -H "X-Tenant-ID: <tenantId>"
```

**Expected response** (200, when ready):

```json
{
  "id": "uuid-here",
  "status": "ready",
  "method": "doc-extraction",
  "systemPrompt": "You are a sales assistant for...",
  "funnelConfig": { ... },
  "validatorToggles": { "false-promise": true, "format-injection": false },
  "confidence": "high",
  "createdAt": "2026-06-23T00:00:00Z"
}
```

#### Step 3: Review (optional, advisory)

```bash
curl -X POST http://localhost:3000/v1/tuning/drafts/:draftId/review \
  -H "Authorization: Bearer <token>" \
  -H "X-Tenant-ID: <tenantId>" \
  -H "Content-Type: application/json" \
  -d '{"verdict": "approved", "notes": "Looks good"}'
```

#### Step 4: Activate

```bash
curl -X POST http://localhost:3000/v1/tuning/drafts/:draftId/activate \
  -H "Authorization: Bearer <token>" \
  -H "X-Tenant-ID: <tenantId>"
```

**Expected response** (200):

```json
{
  "status": "activated",
  "activatedAt": "2026-06-23T00:01:00Z"
}
```

#### Step 5: Rollback (if needed)

```bash
curl -X POST http://localhost:3000/v1/tuning/drafts/:draftId/rollback \
  -H "Authorization: Bearer <token>" \
  -H "X-Tenant-ID: <tenantId>"
```

### User Story 2: Sandbox Preview

```bash
curl -X POST http://localhost:3000/v1/tuning/drafts/:draftId/sandbox-preview \
  -H "Authorization: Bearer <token>" \
  -H "X-Tenant-ID: <tenantId>" \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "Tell me about your products"}]}'
```

### User Story 3: Interview Flow

```bash
# Start interview
curl -X POST http://localhost:3000/v1/personas/:personaId/tuning/interview/next \
  -H "Authorization: Bearer <token>" \
  -H "X-Tenant-ID: <tenantId>"

# Answer question
curl -X POST http://localhost:3000/v1/personas/:personaId/tuning/interview/answer \
  -H "Authorization: Bearer <token>" \
  -H "X-Tenant-ID: <tenantId>" \
  -H "Content-Type: application/json" \
  -d '{"questionId": "q1", "answer": "We sell CRM software"}'

# Get next question
curl -X POST http://localhost:3000/v1/personas/:personaId/tuning/interview/next \
  -H "Authorization: Bearer <token>" \
  -H "X-Tenant-ID: <tenantId>"
```

### User Story 4: Self-Tuner Proposals

```bash
# Get proposals (requires ≥20 conversations)
curl http://localhost:3000/v1/personas/:personaId/tuning/proposals \
  -H "Authorization: Bearer <token>" \
  -H "X-Tenant-ID: <tenantId>"

# Accept a proposal
curl -X POST http://localhost:3000/v1/tuning/proposals/:proposalId/accept \
  -H "Authorization: Bearer <token>" \
  -H "X-Tenant-ID: <tenantId>"
```

## Testing

```bash
# Run all tuning tests
pnpm --filter @undrecreaitwins/core test -- --grep "tuning"
pnpm --filter @undrecreaitwins/api test -- --grep "tuning"
```

## Edge Cases to Verify

1. **No documents**: Generate with 0 docs → 400 `NO_DOCUMENTS`
2. **Concurrent generate**: Call generate twice for same persona → second returns 409
3. **Stalled generation**: Create draft, wait 90s, poll → status flips to `failed`
4. **Activate already-activated draft**: Returns 409 `CONFLICT`
5. **Rollback superseded draft**: Returns 409 `DRAFT_SUPERSEDED`
6. **Rollback with no snapshot**: Returns 400 `NO_PREVIOUS_SNAPSHOT`
7. **Expired proposal**: Accept after 30min → 404 `PROPOSAL_EXPIRED`
8. **Cross-tenant access**: Request with different tenant → 404
