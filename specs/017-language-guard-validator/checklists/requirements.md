# Specification Quality Checklist: Language Response Guard

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-06-10
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders (product owner / operator personas)
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified (9 cases documented — code/URL masking + strip-quality added in review remediation)
- [x] Scope is clearly bounded (engine-only; config UI out of scope)
- [x] Dependencies and assumptions identified

## Review remediation (2026-06-10 — claude CRITICAL + gemini CRITICAL, both addressed)

- [x] **Code-block/inline-code masking** before classification — the CRITICAL (gemini F1 / claude F1): technical personas no longer blocked on legitimate code → FR-014, DD-008, T005, T006 test
- [x] **URL/email masking** instead of adding Latin to `zh` (claude F5 — alternative remedy: blanket Latin would let full-English pass a Chinese-only persona) → FR-014, DD-001 note
- [x] **Fraction formula pinned**: `nonCompliant / (total − common − masked)`, zero-denominator → pass (gemini F3 / claude F2 / analyze A1) → FR-015, DD-002
- [x] **Single config resolve per request**, shared by directive + pipeline; tenantId in scope at entry (gemini F2/F5, claude F3) → spec assumption, DD-003, T008, T009 spy-test
- [x] **Strip-quality degradation documented** (>~15% → stitched words); `stripMaxFraction` cap noted as follow-up, not MVP (gemini F4 / claude F4) → spec edge case, DD-002
- [x] **Audit-skip = explicit pipeline convention**, code comment required (claude F6, option 3) → DD-005, T003
- [x] **`'pass'` added to verdict enum** alongside `'strip'` (claude F7 — FR-009 audit insert would fail at DB) → T001, research §2.4
- [x] **Latin Extended Additional U+1E00–U+1EFF** added (Vietnamese; claude F8) + extensibility comment → DD-001, T005
- [x] **SC-005 marked target-not-gate** (claude F9) → spec SC-005
- [x] **Script-vs-language terminology note** (claude F10) → spec Assumptions

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows (P1 enforcement, P2 dry-run, P2 directive, P3 per-persona)
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

- **SC-005** (directive reduces violations by ≥60%) is an empirical target — requires baseline measurement on a real corpus during implementation to validate. Flag this in the plan if the LLM used doesn't respond reliably to language directives.
- `regenerateOnViolation` (FR-010) is the only path that adds an LLM call. Spec correctly defaults it to `false`. Consider whether to gate it behind a plan-level feature flag for initial rollout.
- Fallback message default wording is intentionally left to implementation — spec is silent on the exact string. Confirm with tenant product team before shipping.
- `allowedLanguages` identifier format (BCP-47 vs Unicode script names) is deferred to planning per Assumptions. Must be resolved in `/speckit.plan` before implementation.
