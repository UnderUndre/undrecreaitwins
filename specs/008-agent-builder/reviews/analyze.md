# SpecKit Analyze: 008-agent-builder

**Reviewer**: analyze (Claude self-consistency)
**Reviewed at**: 2026-05-30T00:00:00Z
**Commit**: 389f18eba5f831826032c040072937c6eecb0e18 *(008 artifacts are UNTRACKED at this SHA — see C1)*
**Artifacts**: spec.md, plan.md, data-model.md, tasks.md

> Self-consistency pass only. Per Constitution Principle VI, this is the **first** gate; ≥2 independent external reviews (`/speckit.review`) are still required before `/speckit.implement`. The author is the weakest auditor of their own spec — treat external reviews as the real signal.

## Findings

| ID | Category | Severity | Location(s) | Summary | Recommendation |
|----|----------|----------|-------------|---------|----------------|
| C1 | Constitution (VII) | **HIGH** | tasks.md/plan.md (whole feature untracked) | Principle VII requires each stage to tag `<stage>/<slug>/v<N>`. 008 has **no branch, no commits, no snapshot tags** — deliberately deferred (Standing Order 1: no commit without consent). Real deviation, but consent-gated + trivially resolvable. | Before `/speckit.implement`: commit 008 onto its own branch + run `snapshot-stage.ps1` for plan/tasks. Clears C1. |
| U1 | Underspecification | MEDIUM | tasks.md T006; plan.md §Phase0 | Embedding **serving mechanism** unresolved: "proxy `/embeddings` if available, else TEI sidecar." Recon says the proxy is chat-only ⇒ likely a **new embedding service** (ops + critical-path impact). Direction (pgvector+BGE-M3) is locked; the *how-served* fork is not. | Resolve at start of T006 (de-risk the long pole): confirm proxy embeddings support, else commit to a TEI/Ollama sidecar in ops. |
| X1 | Inconsistency (shared file) | MEDIUM | tasks.md T011, T018, T019, T023 → `packages/api/src/server.ts` | Four 008 tasks wire routes into `buildServer()`; **004 and 005 also edit `buildServer()`**. Same-agent within 008 (sequential), but a **cross-feature merge hotspot**. | Sequence the 008 route-wiring within the [BE] lane; coordinate the `buildServer()` edits across 004/005/008 (one integration owner, like the callLLM seam). |
| G1 | Coverage gap | MEDIUM | spec.md FR-013; tasks.md T002 | FR-013 (single Langfuse, **project-per-tenant** isolation) is only partially covered — T002 stands up Langfuse but there is **no task for per-tenant project provisioning** (auto-create on tenant onboarding?). | Add a task (or fold into T002): provision/resolve a Langfuse project per tenant; verify isolation. |
| X2 | Inconsistency (spec↔reality) | MEDIUM | spec.md FR-017 | FR-017 mandates composition with **003-script-funnels**, but recon found 003 is **not implemented** in the engine. plan.md notes it's forward-looking; the spec still reads as if 003 exists. | Mark FR-017's 003-composition explicitly **aspirational** (annotation few-shot is currently the *first* scripted injection). |
| T1 | Terminology drift | LOW | spec.md (Assistant) vs engine (persona) | "Assistant" (product/UI) vs "persona" (engine entity). Mapped in data-model §1, but two names for one concept. | Keep the data-model mapping note prominent; consider a glossary line in spec. |
| T2 | Underspecification | LOW | tasks.md T005 | After the callLLM correction, T005 is a **no-op/coordination note** ("don't extract; reuse 004's DD-001"), not an actionable task. | Convert T005 to a plan/notes line; renumber or leave as an explicit "no-action" marker. |
| U2 | Underspecification | LOW | spec.md FR-007; data-model §3 | Document **chunking strategy** (size / overlap / splitter) unspecified. | Pick at impl (e.g., recursive ~512-token chunks w/ overlap); not blocking. |
| X3 | Shared file | LOW | tasks.md T012, T016 → `chat-service.ts` | Two [BE] tasks edit `chat-service.ts` (different methods: `buildSystemPrompt` vs `emitUsageEvent`). Same agent, no logical conflict. | Sequence within the [BE] lane; note in lane comments. |
| G2 | Coverage (by design) | LOW | spec.md FR-011; tasks.md T002 | FR-011 (operators *use* Langfuse for review/datasets/evals/analytics) has **no build task** — intentional (adopted, not rebuilt). | Acceptable; ensure T002/quickstart documents the operator workflow so "no task" ≠ "no enablement." |

## Coverage Summary

| Requirement | Has Task? | Task IDs | Notes |
|-------------|-----------|----------|-------|
| FR-001 persist annotation (norm upsert) | ✅ | T010 | |
| FR-002 vectorize, isolated from docs | ✅ | T006, T010 | separate tables (data-model) |
| FR-003 retrieve+inject few-shot | ✅ | T012 | pre-gen, ≤3, after KB |
| FR-004 delete → remove vector | ✅ | T010 | |
| FR-005 substrate pgvector+BGE-M3 | ✅ | T001, T004, T006 | |
| FR-006 wizard core fields | ✅ | T018, T021 | |
| FR-007 upload/parse/vectorize async | ✅ | T019, T020 | |
| FR-008 sandbox real path + gating | ✅ | T023 | |
| FR-009 thumbs-down + correction | ✅ | T024 | |
| FR-010 Langfuse trace per reply | ✅ | T016 | |
| FR-011 operators use Langfuse | ⚠️ by design | T002 | no build task (adopted) — G2 |
| FR-012 ownership boundary + 1-way sync | ✅ | T013 | |
| FR-013 single Langfuse project-per-tenant | ⚠️ partial | T002 | provisioning gap — G1 |
| FR-014 annotationSimilarityThreshold | ✅ | T007 | |
| FR-015 retrieval < 300 ms | ✅ | T028 | |
| FR-016 tenant isolation | ✅ | T008, T027 | |
| FR-017 pipeline composition (pre-gen) | ✅ | T012 | 003 part aspirational — X2 |

## Constitution Alignment Issues

- **Principle VII (Artifact Versioning)** — **NOT MET** (C1): no snapshot tags; feature untracked. Deliberate, consent-gated deferral; resolvable by commit + snapshot. Flagged HIGH (process deviation, not artifact-content contradiction).
- **Principle VI (Cross-AI Review Gate)** — PENDING by pipeline position (analyze is the first gate; ≥2 external reviews come next). Not a finding.
- Principles I–V, VIII — no conflicts in 008 artifacts.

## Unmapped Tasks

- **T005** — no mapped requirement after the callLLM correction (now a coordination note, see T2).
- **T026** — `architecture.md` update (Principle VIII living-spec), not an FR; legitimate.
- **T003** — engine-client scaffold; supports FR-006/008/009 (FE client). Mapped indirectly.

## Metrics

- Total Requirements: 17 FR (+ 8 SC)
- Total Tasks: 28
- Coverage (≥1 task): 17/17 = **100%** (2 partial: FR-011 by-design, FR-013 provisioning gap)
- Ambiguity count: 1 (T006 serving)
- Duplication count: 0
- CRITICAL count: 0
- HIGH count: 1
- MEDIUM count: 4
- LOW count: 5

## VERDICT

```yaml
verdict: MEDIUM
reviewer: analyze
reviewed_at: 2026-05-30T00:00:00Z
commit: 389f18eba5f831826032c040072937c6eecb0e18
critical_count: 0
high_count: 1
medium_count: 4
low_count: 5
```

## Remediation Applied (2026-05-30)

| Finding | Status | Fix |
|---------|--------|-----|
| **C1** (VII untracked/snapshot) | ⏳ **PENDING** | Requires a git **commit + branch + snapshot** — Standing-Order-1 gated; awaiting explicit user consent + branch strategy for the 4 untracked specs. **Only remaining finding.** |
| U1 (embedding serving) | ✅ Fixed | Locked **TEI sidecar** (BGE-M3 + reranker over HTTP) — T002 stands it up, T006 calls it; proxy only if it gains `/embeddings`. plan §Phase0 + risk + tasks updated. |
| X1 (server.ts hotspot) | ✅ Fixed | Notes: append-only registration + single integration owner across 004/005/008. |
| G1 (Langfuse per-tenant) | ✅ Fixed | Added **T029** (provision Langfuse project per tenant + isolation test); deps + graph updated. |
| X2 (FR-017 003 aspirational) | ✅ Fixed | spec FR-017 marks 003-composition "when implemented"; annotation few-shot is the first scripted injection. |
| T1 (Assistant vs persona) | ✅ Fixed | spec Glossary line added. (Also corrected stale `apps/admin` → `apps/web/(dashboard)/assistants`.) |
| T2 (T005 no-op) | ✅ Fixed | T005 retagged `[NOTE]` (coordination, not a build task). |
| U2 (chunking) | ✅ Fixed | T020 specifies recursive ~512-token chunks, ~10% overlap. |
| X3 (chat-service.ts) | ✅ Fixed | Notes sequencing for T012/T016. |
| G2 (FR-011 adopted) | ✅ Fixed | T002 documents the operator Langfuse workflow. |

**Post-remediation state**: CRITICAL 0 · HIGH 1 (**C1 only, pending commit**) · MEDIUM 0 · LOW 0. Verdict stays **MEDIUM** until C1's commit/snapshot lands → then re-run yields **PASS**.
