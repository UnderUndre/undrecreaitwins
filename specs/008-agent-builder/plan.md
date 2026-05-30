# Implementation Plan: Agent Builder & Feedback Loop (008, Option C)

**Branch**: `008-agent-builder` *(untracked draft; branch/snapshot deferred)* | **Date**: 2026-05-30 | **Spec**: [spec.md](./spec.md)
**Recon**: [agent_builder_recon.md](../../../../../agent_builder_recon.md) (ground truth)

## Summary

Operators create AI assistants (wizard) and continuously correct them (thumbs-down → corrected answer → few-shot injection), measured via Langfuse. **Build the moat** (wizard + annotation→few-shot loop in the engine reply path); **adopt Langfuse** (self-host, TS) for eval/observability/analytics/prompt-mgmt. Substrate: **pgvector + TS parser + BGE-M3/reranker**. Recon verdict: embeddings, pgvector, doc-parsing, and observability are all **net-new** in the engine; BullMQ + a product assistants dashboard already exist to extend.

## Technical Context

**Language/Version**: TypeScript strict ESM (NodeNext, ES2022), Node ≥ 20
**Primary Dependencies (new)**: `pgvector` (Postgres ext + Drizzle custom type), `officeParser` (or LiteParse) for PDF/DOCX/TXT, a BGE-M3 embedding + BGE-reranker-v2-m3 inference path, `langfuse` SDK. Existing: Fastify 5, Drizzle 0.38, BullMQ, Pino, Vitest 3.
**Storage**: PostgreSQL (existing) + **pgvector** for annotation/doc vectors; Drizzle ORM; Postgres RLS for tenant isolation.
**Testing**: Vitest (integration pattern: `buildServer()` + `server.inject()` + `vi.mock` for LLM/embeddings).
**Target Platform**: Headless Fastify engine (port 8090) + Next.js 13/React 18 product UI (`ai-twins/apps/web`) + self-hosted Langfuse sidecar.
**Project Type**: Cross-repo web service + product UI + ops sidecar (3 tracks).
**Performance Goals**: annotation retrieval < 300 ms added to reply (SC-004); prefilter/non-match path adds ~0; Langfuse emission non-blocking.
**Constraints**: tenant-isolated (RLS); embeddings must be multilingual (Russian); reply-path failures from Langfuse = forbidden (fire-and-forget); new routes MUST be wired into `buildServer()`.
**Scale/Scope**: per-tenant assistants; modest vector volume (annotations + doc chunks) — pgvector comfortably in range.

## Constitution Check

*GATE: must pass before Phase 0. Re-checked after Phase 1.*

| Principle | Status | Note |
|-----------|--------|------|
| I–III (source-of-truth / transformer / protected slots) | **N/A** | Feature code, not `.claude/` config. No generated-file edits. |
| IV (SemVer 0.x) | **PASS** | Feature → MINOR bump at release time; not now. |
| V (Token economy) | **PASS** | No new `.claude/` artifacts. |
| VI (Cross-AI review gate) | **PENDING (by design)** | `/speckit.implement` will block until `analyze.md` PASS + ≥2 external reviews. Not yet reached. |
| VII (Artifact versioning) | **DEFERRED** | Snapshot tags require a commit; deferred pending user consent (repo busy w/ untracked 005–007). |
| VIII (Self-maintaining) | **PASS** | Living-spec update (`specs/main/architecture.md`) flagged below, deferred with snapshot. |

**WRAP atomicity**: tasks scoped < 500 LOC, refactor XOR feature. The `callLLM`→shared-client extraction (needed for embeddings + judge reuse, shared with 004/005) is a **refactor task isolated from feature tasks**.

**Gate result: PASS** to proceed (VI/VII are downstream/deferred, not Phase-0 blockers).

## Project Structure

### Documentation (this feature)

```text
specs/008-agent-builder/
├── plan.md              # this file
├── data-model.md        # entities (this stage)
├── tasks.md             # task breakdown (Phase 2)
├── research.md          # folded into §Phase 0 below (no separate file for MVP)
├── contracts/           # folded into §Phase 1 endpoint list below (MVP)
└── checklists/requirements.md
```

### Source Code (real paths, 3 tracks)

```text
[ENGINE] undrecreaitwins/
├── packages/core/src/
│   ├── models/
│   │   ├── personas.ts                  # EXTEND: + annotationSimilarityThreshold
│   │   ├── annotations.ts               # NEW
│   │   ├── documents.ts                 # NEW
│   │   └── document-chunks.ts           # NEW (pgvector column)
│   ├── db.ts                            # EXTEND: pgvector custom type + vector helpers
│   ├── services/
│   │   ├── chat-service.ts              # EXTEND: buildSystemPrompt (annotation few-shot inject) + complete (Langfuse emit @ emitUsageEvent)
│   │   ├── embedding-service.ts         # NEW: BGE-M3 embed + BGE-reranker
│   │   ├── annotation-service.ts        # NEW: upsert/retrieve/delete + vector
│   │   ├── document-service.ts          # NEW: parse(officeParser) + chunk + embed
│   │   ├── langfuse-service.ts          # NEW: fire-and-forget trace + dataset sync
│   │   └── (llm-client.ts)              # REUSE 004's DD-001 extraction if needed — NOT extracted by 008
├── packages/api/src/
│   ├── routes/ { annotations.ts, documents.ts, assistants.ts, sandbox.ts }  # NEW, mirror personas.ts
│   └── server.ts                        # EXTEND: wire new routes into buildServer()
├── packages/training/src/jobs/          # EXTEND: document-parse BullMQ worker
└── drizzle/                             # NEW migration: CREATE EXTENSION vector; tables; RLS; HNSW index

[PRODUCT] ai-twins/apps/web/app/(dashboard)/assistants/
├── builder/ (wizard steps)             # NEW: name/prompt/docs
├── sandbox/ (chat + thumbs-down)       # NEW
└── lib/engine-client.ts                # NEW: thin fetch (Bearer + X-Tenant-ID) — swappable

[OPS]
├── langfuse/docker-compose.yml         # NEW: self-host (Postgres+ClickHouse+Redis)
└── engine env: LANGFUSE_* keys
```

**Structure Decision**: Extend the engine's existing `packages/core` (models/services) + `packages/api` (routes) + `packages/training` (jobs); extend the existing product `assistants` dashboard; add Langfuse as an ops sidecar. No new package needed.

## Phase 0 — Research (decisions, resolved)

| Unknown | Decision | Rationale |
|---------|----------|-----------|
| Embeddings (NOT FOUND) | **Decided: TEI sidecar** serving **BGE-M3** + **BGE-reranker-v2-m3** over HTTP (route via the model proxy only if it is confirmed to expose `/embeddings` — recon found it chat-only, so default to the sidecar). | Multilingual incl. Russian; two-stage embed→rerank stabilizes recall at volume. **Net-new — biggest scope item, de-risk first.** |
| Vector store (NOT FOUND) | **pgvector** on existing Postgres + Drizzle custom `vector` type + **HNSW** index; cosine distance. | No new service (Langfuse already adds ClickHouse). 50M-vector headroom. pgvectorscale = later upgrade lane. |
| Doc parsing | **officeParser** (TS, strict types, RAG-chunk output, OCR flag) primary; LiteParse alt. PaddleOCR sidecar deferred. | TS-native, covers PDF/DOCX/TXT; OCR only if scanned docs appear. |
| Letta reuse | **No** — per-conversation namespace, dead-end for assistant-level RAG. Use pgvector. | Recon §3. |
| Async jobs | Reuse **BullMQ** (`packages/training`) for doc parse/embed. | Recon §4 — already present. |
| Langfuse hook | Emit trace at `ChatService.emitUsageEvent` (chat-service.ts:109), **fire-and-forget**. Corrections → Langfuse dataset **one-way**. | Recon §7; FR-010/FR-012. |
| Prompt injection site | `ChatService.buildSystemPrompt` (:315); annotation few-shot section after KB context, before (future) script fragments. 003 funnels not implemented → first scripted injection. | Recon §6; FR-003/FR-017. |

## Phase 1 — Design (overview)

- **Data model**: see [data-model.md](./data-model.md). New: `annotations`, `documents`, `document_chunks` (vector), `personas.annotationSimilarityThreshold`. All tenant-scoped + RLS.
- **Contracts (endpoint list, mirror `personas.ts`, wire into `buildServer()`):**
  - `POST /v1/assistants` (or extend `/v1/personas`) — create/update assistant core (name, prompt) + `annotationSimilarityThreshold`.
  - `POST /v1/assistants/:id/documents` — upload (enqueues BullMQ parse+embed); `GET`/`DELETE`.
  - `POST /v1/assistants/:id/annotations` — upsert correction (normalized); `GET`/`DELETE`.
  - `POST /v1/sandbox/chat` — real reply path, `isTestThread`, side-effects gated.
  - (Langfuse: no engine route — SDK emit only.)
- **Reply-path change**: `buildSystemPrompt` retrieves top-k annotations (embed query → pgvector cosine → rerank → threshold) and injects a few-shot block; `complete()` emits a Langfuse trace fire-and-forget.

## Risks & Complexity Tracking

| Risk | Severity | Mitigation |
|------|----------|------------|
| **Embeddings net-new** — recon: proxy is chat-only | HIGH | **Resolved direction:** TEI sidecar (T002) serves BGE-M3 + reranker; `embedding-service.ts` (T006) calls it over HTTP. De-risk first (long pole). Gates US1/US2 RAG. |
| **005↔008 split-brain RAG** — RESOLVED | ~~HIGH~~ | **Aligned (2026-05-30, user decision):** 005-fact-grounding edited onto the shared **pgvector + embedding-service**; Qdrant client dropped. The 005-owning session must pull the change. |
| `callLLM` extraction — RESOLVED | ~~MED~~ | Extraction owned by **004 (DD-001)**; 008 reuses it. 008's model calls are embeddings/rerank (separate `embedding-service.ts`) — no shared-seam refactor in 008. |
| Langfuse ops (+ClickHouse) | MED | Self-host compose; emission fire-and-forget so engine never hard-depends. |
| 003-funnels lands later and also injects into prompt | LOW | Inject order documented (annotation before fragments); coexist by design. |
| `buildServer()` route-registration gap | LOW | Known — wire new routes explicitly (T-task). |

## Post-Design Constitution Re-check

No new violations. Complexity (embeddings service, pgvector, Langfuse sidecar) is **justified** — each is a net-new capability the feature genuinely requires, not gold-plating; no simpler alternative (Letta rejected with evidence; native-analytics rejected in favor of adopting Langfuse). **PASS.**

## Deferred

- `specs/main/architecture.md` update (add pgvector / BGE-M3 / Langfuse / officeParser + 008 reference) — deferred with snapshot (no commit without consent).
- `contracts/` per-endpoint files + `quickstart.md` — endpoint list above suffices for tasks; expand on request.
