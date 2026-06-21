# Task Breakdown: Language Guard — LLM Rewrite Remediation + Language Mirroring

**Feature Slug**: `024-language-guard-rewrite-mirror`

## Task Summary

Implement LLM-based rewrite/translation remediation, language mirroring, and buffered delivery for LanguageGuard. Tasks granular to FR level (review F8 fix).

## Agent Dispatch Plan

| Task ID | Agent | Skills | Input Context | Blocked By |
|---|---|---|---|---|
| T0 | `backend-specialist` | api-patterns, typescript-expert | `LLMClient` source | — | [X] |
| T1 | `backend-specialist` | typescript-expert, database-design | `spec.md` FR-011, `plan.md` data-model | — | [X] |
| T2 | `backend-specialist` | typescript-expert | `spec.md` FR-010, `plan.md` supported-set | — | [X] |
| T3 | `backend-specialist` | typescript-expert | `spec.md` FR-001/002/002b/003 | T0, T1 | [X] |
| T4 | `backend-specialist` | typescript-expert | `spec.md` FR-005/006/007, `plan.md` contracts | T0, T1 | [X] |
| T5 | `backend-specialist` | typescript-expert, systematic-debugging | `spec.md` FR-008/013, `chat-service.ts` | T3, T4 | [X] |
| T6 | `backend-specialist` | typescript-expert | `spec.md` FR-012, `validator_runs` schema | T3, T4 | [X] |
| T7 | `test-engineer` | tdd-workflow, testing-patterns | US1-US5, all FRs | T1-T6 | [X] |

## Parallel Lanes

- **Lane A (Foundation)**: T0, T1, T2 (parallel, no deps)
- **Lane B (Core Logic)**: T3, T4 (blocked by T0+T1)
- **Lane C (Integration)**: T5, T6 (blocked by T3+T4)
- **Lane D (Verification)**: T7 (blocked by T1-T6)

## Task Details

### T0: Platform Model Plumbing (review F2)
- **Assignee**: `backend-specialist`
- **FR**: FR-002, FR-005 dependency
- **Desc**: Verify/implement `LLMClient` ability to call platform (non-BYOK) models for langid + translate. If not supported — add platform provider config path (env-based, separate from tenant BYOK keys).
- **Verify**: `LLMClient` can route to `LANG_GUARD_LANGID_MODEL` and `LANG_GUARD_TRANSLATE_MODEL` without tenant BYOK key.

### T1: Config Schema + Validation (FR-011, FR-013/F13)
- **Assignee**: `backend-specialist`
- **FR**: FR-011
- **Desc**: Add `targetPolicy`, `fixedLanguage?`, `fallbackLanguage`, `remediation`, `langidMinConfidence`, `allowPlatformModelRouting` to `LanguageGuardConfig` type. Implement config validation rules (plan.md Config Validation Rules §1-6). Default `remediation='strip-block'` (NFR-5), `allowPlatformModelRouting=false` (NFR-4).
- **Verify**: Config validation rejects invalid combos (400); valid configs persist; backward-compat (no new fields → Phase 1 behavior).

### T2: Supported Language Set (FR-010)
- **Assignee**: `backend-specialist`
- **FR**: FR-010
- **Desc**: Expand `BCP47_TO_SCRIPTS` to 19 languages (original 9 + 10 СНГ). Create single-source export that 023 validation and 026 UI import.
- **Verify**: All 19 codes present; export is the single import point; invalid code in config → 400.

### T3: Target Resolution + Dynamic Directive (FR-001, FR-002, FR-002b, FR-003)
- **Assignee**: `backend-specialist`
- **FR**: FR-001, FR-002, FR-002b, FR-003
- **Desc**: Implement per-message target resolution (`mirror`/`fixed`/`fallback`/`degraded`). langid inbound call (structured output `{lang, confidence}`, parse+validate to BCP-47, F9 injection guard). Outbound same-script detect langid (FR-002b). `buildLanguageDirective` accepts resolved target (dynamic, replaces static).
- **Verify**: mirror switches per-message; fixed pins; single-language → no langid call; same-script violation detected; langid output validated before interpolation.

### T4: Remediation Pipeline (FR-005, FR-006, FR-007, F4/F11)
- **Assignee**: `backend-specialist`
- **FR**: FR-005, FR-006, FR-007
- **Desc**: Implement translate-pass (placeholder-masking for numbers/prices/dates/URL/code, restore verbatim). Fidelity-guard (numeric value compare, code/URL/currency match). Regenerate escalation (maxRegenerate=1, cost guard). Strip/block fallback. Fenced user/answer content in translate prompt.
- **Verify**: translate preserves numbers/prices; fidelity fail → regenerate; regenerate fail → strip/block; no recursion; malformed funnel → skip.

### T5: Buffered Delivery + Agentic Path (FR-008, FR-013)
- **Assignee**: `backend-specialist`
- **FR**: FR-008, FR-013
- **Desc**: Buffer delivery when guard active (`enabled && allowedLanguages nonempty`). Route agentic answers through remediation pipeline (F2 decision). Degradation path: remediation fail → answer delivered as-is, audit `degraded`.
- **Verify**: guard-active → no streaming; agentic answer remediated; remediation timeout → graceful degradation.

### T6: Audit Extension (FR-012)
- **Assignee**: `backend-specialist`
- **FR**: FR-012
- **Desc**: Extend `validator_runs` metadata: `remediation` type (`translated|regenerated|stripped|blocked|pass|degraded|skipped`), `sourceLang`, `targetLang`, `fidelityOk`, `reason`. Cost metrics (langid+translate calls) → observability.
- **Verify**: Audit records remediation type + langs; no PII in plaintext metrics.

### T7: Testing (US1-US5, all FRs)
- **Assignee**: `test-engineer`
- **FR**: all
- **Desc**: Unit/integration tests for US1-US5 + FR-level coverage. Same-script detection (FR-002b). Placeholder masking + fidelity (F4). Config validation combos (F13). Latency budget enforcement (F7). Agentic remediation (FR-013).
- **Verify**: All US pass; all FRs have ≥1 test; edge cases covered (mixed-language, short message, malformed funnel, platform model down).

## Suggested MVP Scope

All US-1 to US-5, including tiered remediation, mirroring, buffered delivery, and agentic-path coverage.
