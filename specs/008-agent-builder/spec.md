# Feature Specification: Agent Builder & Feedback Loop (Option C — build the moat, adopt Langfuse for the commodity)

**Feature Branch**: `008-agent-builder` *(untracked draft — branch/snapshot deferred; repo busy with parallel 005–007 specs)*
**Created**: 2026-05-30
**Status**: Draft
**Input**: Brainstorm Option C — let non-technical operators easily **create** AI assistants and **feedback-loop** them. Build the differentiator (builder wizard + annotation→few-shot loop) on the new stack; **adopt Langfuse** (MIT, self-host, TS) for the commodity layer (eval, human annotation review, analytics, prompt management, observability). Supersedes legacy ideas in `ai-digital-twins/specs/149-agent-builder` + `150-agent-builder-v2`, re-targeted onto Stack #2 (`undrecreaitwins` engine + `ai-twins` product).

## Overview

Today, configuring and improving an assistant needs a developer. We want operators (managers/methodologists) to **create** an assistant and **continuously correct** it from a UI, with measurable quality — without touching code.

**Strategy (Option C = port-the-moat / OSS-the-commodity):**
- **BUILD (the moat):** the **agent builder wizard** and the **annotation → few-shot feedback loop** wired into the engine's reply path (`ChatService` / run-assistant). No OSS platform does "human correction → few-shot injection into *our* persona runtime."
- **ADOPT (the commodity):** **Langfuse** (self-hosted, TS) as the **observability + evaluation + human-annotation-review + analytics + prompt-management** substrate. The engine emits traces/scores via SDK; operators review, curate datasets, see "top failing questions", run LLM-as-judge evals, and version prompts in Langfuse — instead of us rebuilding all of `150-agent-builder-v2`.

**Repo split (cross-repo, like 003-script-funnels):**
- `[ENGINE]` `undrecreaitwins` — annotation storage + vectorization + retrieval/injection on the reply path; Langfuse trace/score emission; assistant config.
- `[PRODUCT]` `ai-twins/apps/web/app/(dashboard)/assistants` — the builder wizard UI, the sandbox chat, the "thumbs-down + correction" capture (extends the existing assistants dashboard). → **specced & owned by `ai-twins/010-agent-builder-admin`** (FE de-bundled from this engine spec; T021/T024 here are delegated, not executed in-engine).
- `[OPS]` self-hosted **Langfuse** sidecar (Postgres — exists; ClickHouse — **new**; Redis — exists) + a **TEI** embedding sidecar (BGE-M3 + reranker).

**Glossary:** "Assistant" (product/UI term) **==** "persona" (engine entity) — one concept, two names; mapping in data-model §1.

## Clarifications

### Session 2026-05-30

- **Q (FR-005, vector substrate):** Engine has no vector store (Letta for memory; legacy 149 used Qdrant). What to build on? → **A:** **pgvector** on the existing Postgres (no new service — Langfuse already adds ClickHouse), a **TS-native parser** (officeParser / LiteParse) for doc ingestion, **BGE-M3** embeddings + **BGE-reranker-v2-m3** (multilingual incl. Russian) via the model proxy. One store serves annotations + doc-RAG. *Rejected:* Qdrant (overkill at this volume), QAnything (Python whole-app, competes with the engine), BCEmbedding (ZH/EN only — no Russian); PaddleOCR = optional OCR sidecar only if scanned/complex docs dominate.
- **Q (MVP scope):** How to cut the first plan? → **A:** **Thin end-to-end** — all four stories at thin depth (create → test → correct → measure), loop demonstrable from day one.
- **Q (FR-012, corrections↔Langfuse):** → **A:** **One-way engine→Langfuse dataset.** Corrections are the engine-owned inference-time source of truth AND are pushed to Langfuse as a labeled dataset for eval/regression (unifying the eval spine with 004-validators + the harness).
- **Resolved by default:** Langfuse tenancy = **project-per-tenant** (single instance); trace emission = **fire-and-forget, non-blocking**; streaming reply path = **out of scope** (consistent with 004).

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Annotation feedback loop `[ENGINE]` (Priority: P1)

An operator testing an assistant sees a wrong answer, clicks **thumbs-down**, and types the **correct** answer. The correction is stored, vectorized by its normalized question, and from then on, when a semantically similar question arrives, the engine injects the correction as a **few-shot example** into the prompt so the assistant answers correctly.

**Why this priority**: This is the differentiator and the headline "feedback-loop" value. It is independently valuable even without a polished wizard.

**Independent Test**: Submit a correction for a failing question via API; ask the same question; verify the corrected answer is produced and a matching annotation was retrieved and injected.

**Acceptance Scenarios**:
1. **Given** an operator flags a reply and submits a corrected answer, **When** saved, **Then** the annotation persists (normalized-query upsert) and is vectorized for semantic match.
2. **Given** an existing annotation, **When** a semantically similar question arrives above the similarity threshold, **Then** the top match is injected as a few-shot example before generation, leading to the corrected answer.
3. **Given** a match below the assistant's configured similarity threshold (default 0.70), **When** retrieving, **Then** it is ignored (no prompt poisoning).
4. **Given** an annotation is deleted, **When** cleanup runs, **Then** its vector is removed from the store.

---

### User Story 2 — Agent builder wizard `[PRODUCT]` (Priority: P1)

A non-technical manager creates an assistant through a step-by-step UI: set **name**, **system prompt**, and **upload documents** (parsed and vectorized for RAG). Advanced fields use sane defaults; "Advanced Settings" is deferred.

**Why this priority**: "Easy creation" is the user's headline desire; it is the entry point operators touch first.

**Independent Test**: In the admin UI, run the wizard, upload a PDF, save; verify the assistant config persists and the document embeddings are stored.

**Acceptance Scenarios**:
1. **Given** a manager in the admin dashboard, **When** they run the create-assistant wizard, **Then** they set name + system prompt + upload docs and save a working assistant.
2. **Given** documents uploaded, **When** submitted, **Then** they are parsed and vectorized asynchronously and associated with the assistant.

---

### User Story 3 — Sandbox testing `[PRODUCT]`+`[ENGINE]` (Priority: P2)

The manager tests the assistant in an in-admin chat that hits the **real** reply path, so behavior matches production. Test threads are tagged so they never trigger production side-effects (CRM, billing, re-engagement). The sandbox is where corrections (US1) are captured.

**Why this priority**: Testing is the precondition for generating annotations, but depends on the assistant existing first.

**Independent Test**: Send messages in the sandbox; verify replies come from the real run-assistant path and the thread is excluded from production side-effects.

**Acceptance Scenarios**:
1. **Given** a configured assistant, **When** the manager opens the sandbox, **Then** they chat against the real reply path with `isTestThread` set and side-effects gated off.

---

### User Story 4 — Langfuse eval & analytics substrate `[OPS]`+`[ENGINE]` (Priority: P2)

The engine emits a **trace** (and optional scores) to Langfuse for each reply. Operators use Langfuse to: review/annotate traces, build **golden datasets**, see analytics ("top questions the bot answers wrong"), run **LLM-as-judge** evals, and version/iterate **prompts** in the playground — instead of us building those screens.

**Why this priority**: Replaces ~80% of `150-agent-builder-v2` (analytics, export/import, auto-suggest, scoring) and unifies the eval spine with `004-validators` and the regression-harness work. Lower priority than the loop+wizard because it is observability/measurement, not the core flow.

**Independent Test**: Generate sandbox replies; verify each produces a Langfuse trace; create a dataset + an LLM-as-judge eval in Langfuse against it; confirm "top failing" is visible.

**Acceptance Scenarios**:
1. **Given** the engine processes a reply, **When** it completes, **Then** a Langfuse trace (model, prompt, latency, tenant/assistant tags) is recorded.
2. **Given** traces exist, **When** an operator scores or annotates them in Langfuse, **Then** those become a curated dataset usable for evals.

---

### Edge Cases
- Document limits: max 10 MB/file, PDF/DOCX/TXT only, ≤10 files per assistant; oversized/unsupported rejected at the UI.
- Conflicting corrections for the same normalized question → normalized exact upsert (lowercase, trim, collapse whitespace); newest wins.
- Partial multi-annotation match → inject only the single highest-scoring match above threshold (no merging in MVP).
- Langfuse unavailable → trace emission is **fire-and-forget / non-blocking** and fails open (never breaks or delays the reply path). Implementation MUST attach an internal `.catch()` so a network failure never becomes an `UnhandledPromiseRejection` (gemini F5).
- Embedding/TEI service unavailable **during a reply** → annotation retrieval **fails open**: skip few-shot injection and generate normally, under a strict timeout (~500 ms). Core chat MUST survive a TEI outage (gemini F1).
- Assistant with **zero annotations** → reply path skips embed+retrieve entirely via the `hasAnnotations` guard — no wasted embedding call per message (gemini F2).
- Document/persona **deleted while its parse job is queued/running** → the BullMQ worker treats the resulting Postgres FK violation (CASCADE, code `23503`) as a graceful abort, not a retryable failure (gemini F6).
- Sandbox vs production side-effects → all production effects gated on `isTestThread`/`source`.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001** `[ENGINE]`: The system MUST persist operator corrections as **Annotations** linked to an assistant, performing a normalized-exact upsert on the question (lowercase, trim, collapse whitespace) to avoid conflicting rules.
- **FR-002** `[ENGINE]`: Each annotation's normalized question MUST be vectorized for semantic retrieval, isolated from knowledge-base document vectors (separate namespace/filter).
- **FR-002a** `[ENGINE]`: The persona MUST carry a `hasAnnotations` flag (default `false`), toggled `true` on the first annotation upsert and re-evaluated on delete. The reply path uses it as a hot-path guard to skip embedding/retrieval for assistants with zero annotations (gemini F2).
- **FR-003** `[ENGINE]`: Before generation, the reply path MUST retrieve relevant annotations above a configurable similarity threshold (default 0.70) and inject the top match(es) as a dedicated few-shot section in the prompt (after KB context, before script fragments; max 3). Retrieval MUST **fail open** (gemini F1): on embedding/TEI error or timeout (~500 ms), log and skip few-shot injection, then generate normally — the core chat MUST survive a TEI outage. Retrieval MUST be **skipped entirely** when the assistant has no annotations (`hasAnnotations = false`, FR-002a) — no embedding call on every query (gemini F2).
- **FR-004** `[ENGINE]`: Deleting an annotation MUST remove its vector from the store.
- **FR-005** `[ENGINE]`: The vector substrate for annotations and document-RAG MUST be **pgvector** on the engine's existing Postgres (no separate vector service). Document ingestion MUST use a **TS-native parser** (officeParser or LiteParse) with an OCR fallback; a Python OCR sidecar (PaddleOCR/Docling) is an optional later upgrade only if scanned/complex-table documents dominate. Embeddings MUST use a **multilingual, Russian-capable model** (BGE-M3) with a multilingual reranker (BGE-reranker-v2-m3) for two-stage retrieval, served via the engine's model-provider path.
- **FR-006** `[PRODUCT]`: The admin MUST provide a multi-step wizard to create/edit an assistant's core fields (name, system prompt, documents); other fields use `defaultAssistantConfig`. Advanced settings deferred.
- **FR-007** `[ENGINE]`: The system MUST upload, parse, and vectorize PDF/DOCX/TXT (≤10 MB/file, ≤10/assistant) **asynchronously** via the existing background-job infrastructure, using the TS-native parser of FR-005.
- **FR-008** `[PRODUCT]`+`[ENGINE]`: The admin MUST provide a sandbox chat connected to the **real** reply path; sandbox threads MUST be tagged (`isTestThread`, `source`) and excluded from all production side-effects (CRM, billing, re-engagement).
- **FR-009** `[PRODUCT]`: The sandbox MUST let an operator thumbs-down a reply and submit a corrected answer, feeding FR-001.
- **FR-010** `[OPS]`+`[ENGINE]`: The engine MUST emit a Langfuse trace per reply (model, resolved prompt, latency, token usage, tenant + assistant tags). Emission MUST be non-blocking and MUST NOT break or delay the reply path on Langfuse failure.
- **FR-011** `[OPS]`: Operators MUST be able to use Langfuse to review/annotate traces, build datasets, run LLM-as-judge evals, view failing-question analytics, and manage/version prompts — these capabilities are **adopted, not rebuilt** in our UI.
- **FR-012** `[ENGINE]`+`[OPS]`: The engine owns the **inference-time** annotation store (source of truth for few-shot injection); corrections are additionally pushed **one-way (engine → Langfuse)** as a labeled dataset for eval/regression. Inference-time few-shots MUST NOT be sourced from Langfuse — no runtime dependency on Langfuse on the reply path.
- **FR-013** `[OPS]`: Langfuse MUST be a single self-hosted instance with **project-per-tenant** isolation.
- **FR-014** `[ENGINE]`: Assistant configuration MUST include the `annotationSimilarityThreshold` (default 0.70), tunable without redeploy.
- **FR-015** `[ENGINE]`: Annotation retrieval MUST add < 300 ms to total reply time.
- **FR-016** `[ENGINE]`+`[PRODUCT]`: All assistant config, annotations, documents, and traces MUST be tenant-isolated.
- **FR-017** `[ENGINE]`: The reply-path integration MUST compose with existing hooks — **004-validators (post-gen)**, and **003-script-funnels (pre-gen) WHEN implemented** (recon confirms 003 is **not yet in the engine**, so annotation few-shot is currently the *first* scripted injection). Annotation injection is **pre-generation** at the `buildSystemPrompt` assembly site, after KB context. MUST NOT independently re-wire the shared assembly site.

### Key Entities

- **Assistant**: operator-created config — name, system prompt, documents, `annotationSimilarityThreshold`, `hasAnnotations` (hot-path guard), defaults. (Maps to the engine `persona` or an assistant wrapper — planning decision.)
- **Annotation**: a correction — `originalQuery` (normalized), `badResponse`, `correctedResponse`, assistant ref, vector. The inference-time few-shot store (engine-owned).
- **Document**: uploaded file, parsed + vectorized for RAG.
- **Trace/Score (Langfuse)**: per-reply observability record; human annotations/scores/datasets live here, not in the engine.

## Success Criteria *(mandatory)*

### Measurable Outcomes
- **SC-001**: A non-technical operator creates an assistant + uploads docs in **< 5 minutes** without developer help.
- **SC-002**: Sandbox replies use the **same** reply path as production (no behavior drift).
- **SC-003**: Submitting a correction yields a **100%** corrected-answer rate when the identical question is re-asked immediately.
- **SC-004**: Annotation retrieval adds **< 300 ms** to reply time.
- **SC-005**: Annotation retrieval precision **> 90%** on a 20-question test set (relevant returned, irrelevant filtered).
- **SC-006**: **100%** of replies produce a Langfuse trace; **zero** reply-path failures attributable to Langfuse being down.
- **SC-007**: Operators can answer "top-10 questions the bot gets wrong" from Langfuse **without** any custom analytics code shipped by us.
- **SC-008**: Zero cross-tenant leakage of assistants, annotations, documents, or traces.

## Assumptions
- Target stack is the **new** engine + product (not the legacy `ai-digital-twins` monolith). 149/150 are treated as idea sources.
- Langfuse is **self-hosted** (Stack #2: TS-native, self-host, max control); core features are MIT, some add-ons require an EE license key (assumed not needed for MVP).
- The engine's existing background-job infra handles async document parsing.
- The few-shot **injection** stays engine-owned; Langfuse is for human review/eval/analytics/prompt-mgmt, not the inference-time store.
- Vector substrate = **pgvector** on the existing Postgres; embeddings/rerank = **BGE-M3 / BGE-reranker-v2-m3** (multilingual, Russian-capable) via the model proxy.
- MVP = **thin end-to-end** across all four user stories (create → test → correct → measure).

## Dependencies
- **003-script-funnels** + **004-validators**: share the reply-path hook ordering; annotation injection is pre-generation and MUST compose (FR-017).
- **Vector substrate** (FR-005): chosen = pgvector + BGE-M3. **Planning-stage engine recon** to confirm: does the model proxy expose embeddings, does Letta already vectorize anything reusable, is pgvector in the schema. Does not block the spec.
- **Langfuse self-host** (ClickHouse) added to ops; the engine needs the Langfuse SDK wiring.
- **eval spine**: shares LLM-as-judge / dataset concepts with 004-validators and the regression-harness work — unify, don't fork.

## Out of Scope (MVP)
- Advanced settings UI (model/temperature/channels/validators) — `150` I4, deferred.
- Native (custom-built) analytics/auto-suggest/export-import — **delegated to Langfuse** (FR-011).
- Fine-tune / data-flywheel (OpenPipe/Argilla) — the brainstorm's Option D, a later phase.
- Multi-annotation merging.
- Streaming reply path for annotation injection — out of scope (consistent with 004 non-streaming scope).
