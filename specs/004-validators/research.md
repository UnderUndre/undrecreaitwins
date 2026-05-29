# Phase 0: Research & Clarifications - Response & Input Validators

## 1. Needs Clarification Resolutions

**[NEEDS CLARIFICATION: identity-guard mechanism + remediation — awaiting recon R-identity]**
- **Resolution**: `identity-and-provider-guard` is parked until the `R-identity` recon report is submitted. It is excluded from the technical design (Phase 1) and tasks (Phase 2).
- **Impact**: We will focus entirely on `false-promise`, `format-injection`, and the Validator Pipeline & Config infrastructure.

## 2. Technical Context & Investigation

1. **Shared LLM Client**: The engine uses LLM calls. A shared internal LLM client needs to be extracted from `chat-service.ts` or similar, as `003-script-funnels` and `004-validators` both require an async LLM seam.
2. **Post-Generation Hook**: The generation hook for the non-streaming path resides in `packages/core/src/services/chat-service.ts`. The pipeline must compose: `input strips -> generation -> response validators -> deferred funnel slot-verification`.
3. **Database Schema**: Validator config and logs need DB tables. `validator_configs` (tenant_id, persona_id, ...) and `validator_runs` (tenant_id, persona_id, ...). We use Drizzle.

## 3. Assumptions Confirmed
- We build this in `packages/core` with endpoints in `packages/api`.
- The streaming reply path is ignored for Phase 1.
- False promise prefilter: Can use deterministic regex or rule matching to fast-fail and avoid the LLM call.
