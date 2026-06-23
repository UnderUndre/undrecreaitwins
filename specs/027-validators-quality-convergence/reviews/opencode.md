# SpecKit Review: 027-validators-quality-convergence

**Reviewer**: opencode
**Reviewed at**: 2026-06-23T09:00:00Z
**Commit**: 0662b575a08fd1651488f1540eb3c4bb974fc006
**Artifacts reviewed**: spec.md, plan.md, tasks.md, data-model.md, research.md, quickstart.md, contracts/quality-event-push.md, contracts/rules-reload.md, reviews/analyze.md

## Summary

The spec is well-conceived: merging two independent post-processing pipelines (deterministic validators + LLM DAR) into one tiered orchestrator is the right architectural call. The cross-DB push-based approach (engine emits QualityEventPush to BFF) is sound and avoids impossible cross-DB views. Build-on path B (refactor, not fork) is correctly chosen. The headline weakness is in **state management under concurrent pipeline execution**: the in-memory rule-cache has no eviction policy for tenants that are deleted/deactivated, and the `getActiveDraft`-style dual-query anti-patterns (seen in 026) are echoed here in the rule-cache version-check path. Additionally, the `shortCircuitedBy` semantics are underspecified for multi-rule terminal scenarios.

## Findings

| ID | Severity | Area | Finding | Recommendation |
|---|---|---|---|---|
| F1 | HIGH | Edge case | **Rule-cache memory leak on tenant deletion.** `RulesReloadPush` pushes rules per tenant into engine in-memory cache. Spec/data-model has no eviction path for tenants that are deleted or deactivated. Over time, the Map grows unbounded. research.md §2.3 acknowledges rule-cache is in-memory but never addresses lifecycle. | Add a `tenantEvicted` signal (Redis pub/sub or periodic sweep) that clears the tenant's rules from the engine cache. Alternatively, add a TTL-based eviction (e.g., evict cache entries not accessed in 24h). |
| F2 | HIGH | Logical consistency | **T012-T014 (call-site updates) depend on T008-T011 (guard logic) via `+` join, but T015 (feature flag) is sequenced AFTER T014.** If T012-T014 ship without the feature flag, there's no way to roll back to the old `validateResponse` + `darExecute` path if regression surfaces. The feature flag MUST be in place BEFORE the first call-site is modified, not after. | Move T015 before T012 in the dependency graph. The feature flag should wrap the call-site (`if (USE_RESPONSE_GUARD) responseGuard.run() else { validateResponse(); darExecute(); }`), so each call-site can be toggled independently. |
| F3 | HIGH | Hidden assumption | **`QualityEventPush` carries `originalResponse` and `modifiedResponse` (first 500 chars) but spec doesn't specify truncation behavior for responses shorter than 500 chars.** Is it padded? Null-terminated? Stored as-is? If BFF stores in `String?` column, short responses will be stored fine, but the contract doesn't say "up to 500 chars" — it says "First 500 chars", implying truncation always occurs, which is misleading for a 50-char response. | Clarify contract: `originalResponseSnippet?: string` — "response text, truncated to 500 chars maximum. If response is shorter, stored as-is (no padding)." |
| F4 | MEDIUM | Failure modes | **BFF push channel failure is unspecified.** If `rules-reload` push fails (network, BFF down), engine continues with stale cache. This is acceptable (stale rules are better than no rules), but there's no alerting or fallback specified. research.md §2.3 mentions periodic refresh (5 min) but no alarm threshold. | Add NFR: "If rules-reload push fails >3 consecutive times, engine logs a WARNING and continues with stale cache. No crash, no retry storm." |
| F5 | MEDIUM | Logical consistency | **`shortCircuitedBy` is a single string, but the pipeline can have multiple terminal rules.** If two system validators have `terminalOnFail=true` and both fail in the same stage batch (before short-circuit check), which one is recorded? The spec says "short-circuit on first terminal fail", but doesn't define "first" in a concurrent/batch execution model. | Clarify: pipeline stages execute sequentially (not concurrently). `shortCircuitedBy` = the rule that triggered the terminal fail. Stages after it are skipped. Only ONE rule can be `shortCircuitedBy` per run. |
| F6 | MEDIUM | Security | **`QualityEventPush.originalResponse` may contain PII (user messages, persona responses).** The contract specifies truncation to 500 chars but no redaction. If these snippets are stored in BFF `quality_events` table and exposed via admin dashboards, PII leaks. | Add a note: "Engine MUST NOT include user PII in `originalResponse`/`modifiedResponse` snippets. Apply existing PII redaction (spec 025 PII guard pattern) before truncation." |
| F7 | MEDIUM | Performance | **`validator_runs` backfill (T028/T040) is a full-table scan + insert.** For tenants with millions of validator runs, this could lock the table or take hours. No batching, no chunking, no `LIMIT/OFFSET` strategy specified. | Specify: "Backfill script processes in batches of 10,000 rows, with `WHERE created_at > last_cursor` pagination. Script includes `BEGIN/COMMIT` per batch." |
| F8 | LOW | Stakeholder clarity | **`detail` field enum includes `degraded` and `skipped` but neither is mapped in §3.1 verdict mapping table.** Where do these values come from? No existing validator or DAR stage produces them. | Either remove `degraded`/`skipped` from the enum (YAGNI), or document which stage produces them (e.g., "degraded = LLM timeout fallback to strip"). |
| F9 | LOW | Alternative approaches | **The spec chose push-based config (BFF → engine `rules-reload`) but didn't evaluate pull-based (engine fetches from BFF API on startup + periodic refresh).** Push requires BFF to know engine endpoints; pull requires engine to know BFF API. Push was likely chosen because the channel already exists, but the trade-off isn't documented. | Add one-line rationale in research.md: "Push chosen because `correction-rules-reload` channel already exists; pull would add a new BFF API endpoint + auth path." |

## Alternative approaches considered

**Pull-based rule sync (engine fetches from BFF)**: Rejected because the existing `correction-rules-reload` push channel already works and adding a BFF API fetch would create a new auth boundary. However, pull-based has an advantage: engine can recover from a missed push by re-fetching. The periodic refresh (5 min) in the spec is a half-measure toward pull — if implemented, it should be a full BFF API GET, not just "check Redis for missed pushes".

## Constitution Alignment

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Source of Truth | ✅ PASS | `.claude/` authoritative; types flow engine→BFF via push |
| II. Transformer, Not Fork | ✅ PASS | No new AI-tool target |
| III. Protected Slots | ✅ PASS | No managed files edited |
| IV. SemVer Discipline | ✅ PASS | Breaking change to QualityEvent shape → MINOR bump (0.x) |
| V. Token Economy | ✅ PASS | No new agents/skills |
| VI. Cross-AI Review Gate | ⏳ IN PROGRESS | This review = 1 of ≥2 required external. Need ≥1 more. |
| VII. Artifact Versioning | ✅ PASS | Tags will be created |
| VIII. Self-Maintaining Knowledge | ✅ PASS | Converges existing duplication |
| IX. Two-Phase Review Flow | ✅ PASS | Planning in specs/027-*; implementation on separate branch |

No CRITICAL constitution violations.

## VERDICT

The spec/plan/tasks are **coherent, well-researched, and implementable**. The cross-DB push approach is correctly designed — normalization at emission, not in UI. Build-on path B preserves existing validator algorithms. The tiered stage ordering with `terminalOnFail` correctly preserves the cost model (NFR-1).

**Three HIGH findings** — memory leak in rule-cache, feature flag sequencing, and response snippet contract ambiguity — should be addressed before `/speckit.implement` proceeds. F1 (memory leak) is a production scaling risk; F2 (feature flag) is a deployment safety risk; F3 (snippet contract) is a cross-team contract ambiguity.

**Conditions for PASS**:

1. F1: Add rule-cache eviction strategy (TTL or tenant-deleted signal).
2. F2: Reorder dependency graph so T015 (feature flag) precedes T012 (first call-site update).
3. F3: Clarify `originalResponse` truncation contract (max 500, shorter = as-is).

```yaml
verdict: MEDIUM
reviewer: opencode
reviewed_at: 2026-06-23T09:00:00Z
commit: 0662b575a08fd1651488f1540eb3c4bb974fc006
critical_count: 0
high_count: 3
medium_count: 4
low_count: 2
```
