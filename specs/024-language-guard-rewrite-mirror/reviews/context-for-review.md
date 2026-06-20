# Context for External Reviewers: Language Guard Remediation

## Feature
`024-language-guard-rewrite-mirror`

## Overview
Phase 2 of language guard:
1.  **Remediation shift**: From `strip/block` to `translate/regenerate`.
2.  **Language Mirroring**: Dynamic inbound language detection (`langid`) to set response target language (within allowed set).
3.  **Tiered Logic**: 
    - System directive (`respond in {target}`).
    - Platform-cheap `langid` + `translate` model.
    - If fidelity check fails: `regenerate` via main model (1 pass).
    - Emergency fallback: `strip/block`.
4.  **Operational change**: Active guards now require **buffered delivery** (no streaming) to allow remediation.

## Why this change matters
Fixes "garbage" output (strip/block) with fluent language-aware rewriting. Adds mirroring for improved UX for multi-language personas.

## Reviewer Checklist
- [ ] **Fidelity**: Does `translate` + `regenerate` logic guarantee facts/prices/codes are preserved?
- [ ] **Cost**: Is `langid` usage restricted correctly (mirror-only + multi-allowed)?
- [ ] **Latency**: Are buffered deliveries acceptable? Is the degradation path (`graceful degradation`) robust?
- [ ] **Agentic Path**: Does remediation trigger for agentic responses? (Currently open question in spec).

## Artifacts
- `specs/024-language-guard-rewrite-mirror/spec.md`
- `specs/024-language-guard-rewrite-mirror/plan.md`
- `specs/024-language-guard-rewrite-mirror/tasks.md`

*Note: This feature is under strict constitution Principle VI. Pass/Fail verdict required via `/speckit.review`.*
