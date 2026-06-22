# Implementation Plan: Engine Tuning — Adaptive Configuration Pipeline

**Branch**: `spec/026-tuning` | **Date**: 2026-06-23 | **Spec**: `specs/026-tuning/spec.md`
**Input**: Feature specification from Product `ai-twins/specs/024-adaptive-onboarding` + engine contract `tuning-api.md`

## Summary

Implement Engine-side HTTP endpoints for 4 configuration tuning methods (doc-extraction, template-bootstrap, interview, self-tuner) that the Product layer (`ai-twins`) UI + tRPC proxy expects. Engine currently has no tuning routes — all 4 methods return 404. Build `tuning_drafts` DB table (drizzle schema), Fastify routes under `/v1/personas/:personaId/tuning/*` and `/v1/tuning/drafts/*`, async doc-extraction pipeline, interview state machine (Redis TTL 30min), self-tuner conversation analysis (ephemeral proposals via Redis cache TTL 30min), sandbox draft preview overlay, and activate/rollback pipeline. Primary tracer-bullet: doc-extraction generation → poll → review → activate (P1).

## Technical Context

**Language/Version**: TypeScript 5.x, Node.js >= 20 (strict ESM, pnpm monorepo)
**Primary Dependencies**: Fastify (HTTP server + route registration via `fastify.register`), Drizzle ORM (DB schema + RLS), Zod (validation), pino (logging), undici (SSRF-pinned HTTP calls), BullMQ (existing training workers for document parse/chunk/embed), OpenAI-compatible LLM client (`core/services/llm-client.ts`) with `response_format: { type: 'json_object' }`
**Storage**: PostgreSQL 16 + pgvector (`tuning_drafts` table, RLS-scoped); Redis (interview state TTL 30min, proposal cache TTL 30min); existing `documents` + `document_chunks` tables for RAG input
**Testing**: Vitest (unit + integration), Drizzle test helpers with in-memory/transaction-rollback patterns per existing package tests
**Target Platform**: Linux container (Docker), monorepo microservices (API + core + workers)
**Project Type**: Web-service (REST API routes) + async background task (in-process fire-and-forget for v1)
**Performance Goals**: Generate 202 within 2s, draft ready within 60s for ≤5 docs (≤50KB), activate within 3s (DB writes only, no LLM), sandbox preview within 10s (includes LLM call)
**Constraints**: <200ms p95 for poll endpoint (no LLM), <3s for activate, RLS tenant isolation mandatory, in-process generation (no durable queue for v1 — poll-time reaper after 90s), Redis for ephemeral state only (interview + proposals), concurrent generate per persona → 409
**Scale/Scope**: Multi-tenant engine with persona-scoped tuning; estimated ≤100 active tuning sessions per instance

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Check | Status |
|-----------|-------|--------|
| I. Source of Truth Discipline | N/A — no `.claude/` changes (engine-only spec) | ✅ PASS |
| II. Transformer, Not Fork | N/A — no new AI target | ✅ PASS |
| III. Protected Slots | N/A | ✅ PASS |
| IV. SemVer Discipline | N/A — no CLI version bump | ✅ PASS |
| V. Token Economy | N/A — no new agents/skills in `.claude/` | ✅ PASS |
| VI. Cross-AI Review Gate | Required before `/speckit.implement` | ⚠️ DEFERRED — gate will be met after analyze + 2 external reviews |
| VII. Artifact Versioning | Snapshot after each phase | ⚠️ DEFERRED — will snapshot after plan + tasks phases |
| VIII. Self-Maintaining Knowledge | N/A | ✅ PASS |

**Verdict**: PASS — no constitutional violations. Feature extends existing engine packages (`packages/core` services + `packages/api` routes) following established monorepo patterns.

## Project Structure

### Documentation (this feature)

```text
specs/026-tuning/
├── plan.md              # This file
├── spec.md              # Feature specification (input)
├── research.md          # Phase 0 — pipeline design exploration, LLM prompt format
├── data-model.md        # Phase 1 — tuning_drafts schema, interview state shape, proposal cache key format
├── quickstart.md        # Phase 1 — local dev flow, API walkthrough
├── contracts/           # Phase 1 — OpenAPI spec for tuning endpoints
│   └── tuning-api.md    # Existing contract from Product (input)
└── tasks.md             # Phase 2 — task breakdown
```

### Source Code (repository root)

```text
packages/core/src/
├── db/
│   └── schema/
│       └── tuning.ts              # tuning_drafts drizzle schema + RLS policy
├── services/
│   ├── tuning/
│   │   ├── tuning-draft-repository.ts  # CRUD for tuning_drafts (tenant-scoped)
│   │   ├── doc-extraction-pipeline.ts  # Method A: RAG chunks → LLM → draft
│   │   ├── interview-state-machine.ts  # Method C: Q&A session → draft
│   │   ├── conversation-analyzer.ts    # Method D: recent chats → proposals
│   │   ├── sandbox-draft-mode.ts       # ChatService overlay with draft config
│   │   ├── activate-pipeline.ts        # Apply draft → persona + funnel + validators
│   │   └── reaper.ts                   # Poll-time reaper: generating >90s → failed
│   └── llm-client.ts                   # Existing — extended with structured output support
├── types/
│   └── tuning.ts                      # TuningDraft, InterviewSession, TuningProposal types

packages/api/src/
├── routes/
│   ├── tuning/
│   │   ├── index.ts                   # fastify.register entry — scopes all /v1/tuning/ routes
│   │   ├── generate.ts                # POST /v1/personas/:personaId/tuning/generate
│   │   ├── drafts.ts                  # GET /v1/tuning/drafts/:draftId, GET /v1/personas/:personaId/tuning/drafts
│   │   ├── review.ts                  # POST /v1/tuning/drafts/:draftId/review
│   │   ├── activate.ts                # POST /v1/tuning/drafts/:draftId/activate
│   │   ├── rollback.ts                # POST /v1/tuning/drafts/:draftId/rollback
│   │   ├── sandbox-preview.ts         # POST /v1/tuning/drafts/:draftId/sandbox-preview
│   │   ├── interview.ts               # POST .../tuning/interview/next, POST .../tuning/interview/answer
│   │   └── proposals.ts               # GET /v1/personas/:personaId/tuning/proposals, POST .../proposals/:id/accept, POST .../proposals/:id/reject
│   └── persona/
│       └── tuning.ts                  # Scoped under /v1/personas/:personaId/tuning/
│
├── schemas/
│   └── tuning.ts                      # Zod schemas for all tuning request/response validation

packages/core/test/
└── tuning/
    ├── tuning-draft-repository.test.ts
    ├── doc-extraction-pipeline.test.ts
    ├── activate-pipeline.test.ts
    ├── interview-state-machine.test.ts
    ├── conversation-analyzer.test.ts
    ├── sandbox-draft-mode.test.ts
    └── reaper.test.ts

packages/api/test/
└── tuning/
    ├── routes.test.ts                 # E2E route tests for all endpoints
    ├── generate.test.ts
    ├── activate.test.ts
    └── sandbox-preview.test.ts
```

**Structure Decision**: Standard engine monorepo layout — Drizzle schema + services + types in `packages/core`, Fastify routes + Zod validation in `packages/api`, tests in each package's `test/` directory. Matches existing patterns from specs 004 (validators), 005 (fact-grounding), 019 (feedback-loop).

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| *None* | — | — |
