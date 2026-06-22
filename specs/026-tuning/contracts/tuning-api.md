# Contract: Tuning API (Product ↔ Engine)

Shared between Product spec `ai-twins/specs/024-adaptive-onboarding` and Engine spec `026-tuning`.

Copied from `ai-twins/specs/024-adaptive-onboarding/contracts/tuning-api.md` — canonical source of truth.

## Endpoints

### Generate
`POST /v1/personas/:personaId/tuning/generate`
Body: `{ method: 'doc-extraction' | 'template-bootstrap' | 'interview' | 'self-tuner', options?: { templateId?, conversationIds? } }`
Response: 202 `{ draftId: string, status: 'generating' }`
Error: 400 (no docs), 409 (concurrent generate)

### Poll Draft
`GET /v1/tuning/drafts/:draftId`
Response: full draft object (see TuningDraft entity)
Status transitions: `generating → ready | failed`

### List Drafts
`GET /v1/personas/:personaId/tuning/drafts?status=ready`
Response: `{ drafts: TuningDraft[] }` (latest first)

### Review Draft
`POST /v1/tuning/drafts/:draftId/review`
Body: `{ verdict: 'approved' | 'rejected', notes?: string }`

### Activate Draft
`POST /v1/tuning/drafts/:draftId/activate`
Synchronous (1-3s). Response: 200 `{ status: 'activated', activatedAt }` | 409 CONFLICT

### Rollback Draft
`POST /v1/tuning/drafts/:draftId/rollback`
Response: 200 `{ status: 'rolled-back' }` | 400 (no previousSnapshot)

### Sandbox Preview
`POST /v1/tuning/drafts/:draftId/sandbox-preview`
Body: `{ messages: [{ role: 'user' | 'assistant', content: string }] }`
Response: `{ reply: string, metadata: { draftApplied: boolean, overriddenParts: string[], ragEmpty?: boolean } }`

### Interview Flow
`POST /v1/personas/:personaId/tuning/interview/next`
Response: `{ question: string, questionId: string, total: number, current: number }` | `{ draftId: string, status: 'ready' }`

`POST /v1/personas/:personaId/tuning/interview/answer`
Body: `{ questionId: string, answer: string }`
Response: `{ acknowledged: true }`

### Self-Tuner Proposals
`GET /v1/personas/:personaId/tuning/proposals`
Response: `{ proposals: TuningProposal[] }`

`POST /v1/tuning/proposals/:proposalId/accept` → `{ draftId: string }`
`POST /v1/tuning/proposals/:proposalId/reject` → `{ dismissed: true }`

## Auth

All requests require:
- `Authorization: Bearer <token>`
- `X-Tenant-ID: <tenantId>` (or `X-Tenant-Claim: <base64url>`)

Engine resolves tenant from header, NOT from URL params. Draft queries scoped by resolved tenantId.
