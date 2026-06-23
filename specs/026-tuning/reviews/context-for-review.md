# Context for External AI Review: 026-tuning

> Используй этот файл как входной контекст для `/speckit.review`. Все ключевые артефакты перечислены ниже.

## Feature: Engine Tuning — Adaptive Configuration Pipeline

**Branch**: `spec/026-tuning`
**Engine**: `undrecreaitwins` — open-source headless multi-tenant AI-twin backend (Fastify + Drizzle + PostgreSQL + Redis)

## What This Feature Does

Продуктовый слой (`ai-twins`) реализует UI + tRPC proxy для 4 методов конфигурации AI-персоны:

- **Method A** — doc-extraction: извлекает systemPrompt, funnelConfig, validatorToggles из RAG-документов через LLM
- **Method C** — interview: адаптивное Q&A (7 вопросов) → LLM → draft
- **Method D** — self-tuner: анализ последних 20+ диалогов → proposal → accept → draft
- **Method B** — template-bootstrap: отложен до следующего spec (явно задекларировано в deferral)

Engine сейчас НЕ имеет этих endpoint'ов — все 4 метода возвращают 404.

## Artifacts for Review

| Artifact | Path | Что внутри |
|----------|------|------------|
| **spec.md** | `specs/026-tuning/spec.md` | 13 FR, 5 User Stories, Success Criteria, Edge Cases, Clarifications 2026-06-22/23 |
| **plan.md** | `specs/026-tuning/plan.md` | Technical Context, Constitution Check (PASS), Project Structure (54 tasks in monorepo) |
| **tasks.md** | `specs/026-tuning/tasks.md` | 54 tasks (T001–T054), 9 phases, 5 user stories, Dependency Graph, Parallel Lanes, Agent Dispatch Plan |
| **data-model.md** | `specs/026-tuning/data-model.md` | `tuning_drafts` table (18 columns, RLS), InterviewSession (Redis, TTL 30min), TuningProposal (Redis cache, TTL 30min) |
| **contracts/tuning-api.md** | `specs/026-tuning/contracts/tuning-api.md` | 12 endpoints: generate, poll, list, review, activate, rollback, sandbox-preview, interview (next/answer), proposals (get/accept/reject) |
| **research.md** | `specs/026-tuning/research.md` | Pipeline design, extraction prompt format, interview questions (7, Russian), proposal patterns, Redis key design, poll-time reaper |
| **quickstart.md** | `specs/026-tuning/quickstart.md` | Local dev setup, curl walkthrough for all 5 user stories |
| **analyze.md** (self-review) | `specs/026-tuning/reviews/analyze.md` | Внутренний analyze: verdict PASS, 0 CRITICAL, 0 HIGH, 2 MEDIUM, 5 LOW. Все фиксы применены. |

## Key Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Generation pipeline | **In-process fire-and-forget** (v1) | No durable queue for v1; `tuning_drafts` row = SSOT; poll-time reaper after 90s |
| Interview state | **Redis TTL 30min** (fallback in-memory Map) | Ephemeral — consistent with proposals decision |
| Proposals | **Redis cache TTL 30min** | Not persisted in DB; cache miss on accept/reject → 404 PROPOSAL_EXPIRED |
| Review verdict | **Dedicated columns, advisory** | NOT in `status` enum; does NOT gate activate (per Clarifications 2026-06-23) |
| Concurrent generate | **409 CONFLICT_DRAFT_ACTIVE** | Only one `generating` draft per persona |
| Tenant isolation | **Postgres RLS** on `app.current_tenant` | Consistent with all other engine specs |
| Extraction LLM | **`response_format: { type: 'json_object' }`** | OpenAI-compatible; timeout 55s → LLM_TIMEOUT; unparseable → partial draft with confidence=low |
| Chained activation | **LIFO** | Activate B → mark A superseded; rollback only on current active; rollback superseded → 409 |
| Method B deferral | **Follow-up spec post-v1** | Content task (templates table extension) is separate from code per clarification |

## What External Reviewers Should Check

1. **FR coverage**: Все 13 FR покрыты задачами? (Self-validation checklist в tasks.md)
2. **Agent routing**: Правильные AGENT-теги, нет orphan task IDs, dependency graph валиден
3. **Edge cases**: Все 9 edge cases из spec.md покрыты задачами (T024–T032)?
4. **Architecture consistency**: Не конфликтует ли с существующими паттернами в engine (см. `specs/main/architecture.md`):
   - Drizzle schema + RLS
   - Fastify route registration через `fastify.register`
   - `withTenantContext` для tenant isolation
   - Vitest для тестов
5. **Security**:
   - Cross-tenant → 404 (не 403 — information leakage)
   - Proposals in Redis cache with TTL — accept/reject on expired → 404
   - No hardcoded secrets
6. **Performance**:
   - SC-001: draft ready within 60s (≤5 docs, ≤50KB) — T051 benchmark
   - SC-002: activate within 3s (no LLM, pure DB writes) — T015
   - SC-003: sandbox preview within 10s — T052 benchmark
   - SC-005: no 500s on expected failures — T034–T047 tests
7. **Constitution alignment**: Principle VI (Cross-AI Review Gate) — этот review и есть второй гейт

## Repository Structure (relevant paths)

```
packages/core/src/
├── db/schema/tuning.ts           # T001 — Drizzle schema
├── types/tuning.ts               # T003 — Shared types
├── services/tuning/
│   ├── tuning-draft-repository.ts  # T004 — CRUD
│   ├── redis-helper.ts             # T005 — Redis adapter
│   ├── doc-extraction-pipeline.ts  # T008 — Method A pipeline
│   ├── extraction-prompt.ts        # T013 — LLM prompt
│   ├── activate-pipeline.ts        # T014 — Apply draft
│   ├── sandbox-draft-mode.ts       # T018 — ChatService overlay
│   ├── interview-state-machine.ts  # T020 — Method C state machine
│   ├── conversation-analyzer.ts    # T022 — Method D analysis
│   └── reaper.ts                   # T030 — Poll-time reaper

packages/api/src/
├── routes/tuning/
│   ├── index.ts                  # T007 — Route registration
│   ├── generate.ts               # T009
│   ├── drafts.ts                 # T010, T011
│   ├── review.ts                 # T017
│   ├── activate.ts               # T015
│   ├── rollback.ts               # T016
│   ├── sandbox-preview.ts        # T019
│   ├── interview.ts              # T021
│   └── proposals.ts              # T023
└── schemas/tuning.ts             # T006 — Zod validation
```

## How to Run Review

```bash
# From repo root
cd underhelpers/under-ai-helpers/undrecreaitwins
# Open each artifact listed above, verify:
# - spec.md requirements ↔ tasks.md coverage
# - plan.md structure ↔ actual file paths
# - contracts/tuning-api.md endpoints ↔ routes in tasks
```

## Summary Metrics

- **Total tasks**: 54 (T001–T054)
- **FR coverage**: 13/13 (100%)
- **US coverage**: 5/5 (100%)
- **SC coverage**: 5/5 (100%)
- **Agent tags**: [DB]=2, [SETUP]=4, [BE]=35, [E2E]=17, [OPS]=1
- **Critical path**: T001 → T003 → T004 → T007 → T009 → T008 → T024 → T033 → T051 → T050
- **Internal analyze verdict**: PASS (0 CRITICAL, 0 HIGH, 2 MEDIUM, 5 LOW — все пофикшены)
