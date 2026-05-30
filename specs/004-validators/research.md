# Phase 0: Research & Clarifications - Response & Input Validators

## 1. Needs Clarification Resolutions

**[RESOLVED: identity-guard mechanism + remediation — R-identity recon complete 2026-05-29]**
- **Resolution**: `identity-and-provider-guard` is confirmed as a **deterministic regex-based** validator. It inspects `rawUserMessage` and `responseText` using hardcoded regex patterns.
- **Remediation**: It performs a total **rewrite** (replacement) of the response using a persona-customizable `fallbackMessage`.
- **Policy Source**: System-managed regexes for detection; DB-managed (customizable) template for remediation.
- **Impact**: Added to Phase 1 scope for planning and implementation. Requires the validator row to store an optional `fallbackMessage` override.

## 2. Technical Context & Investigation

1. **Shared LLM Client**: The engine uses LLM calls. A shared internal LLM client needs to be extracted from `chat-service.ts` or similar, as `003-script-funnels` and `004-validators` both require an async LLM seam.
2. **Post-Generation Hook**: The generation hook for the non-streaming path resides in `packages/core/src/services/chat-service.ts`. The pipeline must compose: `input strips -> generation -> response validators -> deferred funnel slot-verification`.
3. **Database Schema**: Validator config and logs need DB tables. `validator_configs` (tenant_id, persona_id, ...) and `validator_runs` (tenant_id, persona_id, ...). We use Drizzle.

## 3. Assumptions Confirmed
- We build this in `packages/core` only for Phase 1 — no `packages/api` surface; validator config is seeded via SQL/migration (supersedes the earlier Phase-0 note; see plan.md §Target Platform).
- The streaming reply path is ignored for Phase 1.
- False promise prefilter: Can use deterministic regex or rule matching to fast-fail and avoid the LLM call.

## 4. Prefilter Pattern Catalog (false-promise)

The deterministic prefilter patterns (FR-003, T007a) MUST be **ported from the legacy false-promise validator** at `C:\Repositories\ai-digital-twins/server/services/validators/` — they are the basis for SC-002's ≥95% regression parity. Enumerate from the legacy source before implementing T007a; do not invent patterns from scratch (the regression set won't validate parity otherwise).

Representative categories (RU + EN), to be confirmed against legacy:
- **Discount / price commitments** — «сделаю скидку», «дам −30 %», "I'll give you a discount".
- **Delivery date/time commitments** — «привезём завтра», «доставка к 9 утра», "we'll deliver by Friday".
- **Refund / return promises** — «верну деньги», "full refund guaranteed".
- **Availability / stock guarantees** — «точно есть в наличии», "definitely in stock".

Each category needs RU + EN coverage. The legacy catalog + its EXACT/AMBIGUOUS classification is the source of truth.
