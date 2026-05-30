# Data Model: Validators

## Overview
Adds database tables for per-tenant/per-persona validator configuration and logging of validator executions. Implemented in `packages/core/src/db.ts` (or appropriate schema file). All reads/writes go through the engine's tenant-context wrapper (`withTenantContext()`) and are protected by row-level-security policies keyed on `tenant_id` (FR-021) — a `tenant_id` column alone is **not** isolation.

## Tables

### 1. `validator_configs`
Stores configuration for validators per tenant and persona.

- `id`: uuid, primary key
- `tenant_id`: varchar, foreign key, indexed
- `persona_id`: uuid, foreign key, indexed
- `validators`: jsonb — per-validator config (typed in `contracts/validator.ts`). Example:
  ```json
  {
    "false-promise": {
      "mode": "active",
      "minConfidence": 0.7,
      "timeoutMs": 1500,
      "remediation": "append_disclaimer",
      "disclaimerText": null,
      "blockFallbackMessage": null,
      "judgeModel": null
    },
    "format-injection": { "mode": "active", "maxInputChars": 8000 },
    "identity-and-provider-guard": {
      "mode": "dry-run",
      "fallbackMessage": "Да, я ИИ-ассистент Анна. Если хотите, могу передать живому оператору 😊",
      "applyToTier1": true,
      "maxInputChars": 8000
    }
  }
  ```
- `created_at`: timestamp
- `updated_at`: timestamp
- **Constraints**: Unique constraint on `(tenant_id, persona_id)`.
- **RLS**: row-level-security policy keyed on `tenant_id` (FR-021).

### 2. `validator_runs`
Audit log of validator executions.

- `id`: uuid, primary key
- `tenant_id`: varchar, indexed
- `persona_id`: uuid, indexed
- `conversation_id`: uuid, indexed
- `message_id`: uuid, indexed (Optional, null if pre-generation format strip)
- `validator_name`: varchar (e.g., 'false-promise')
- `mode`: varchar ('active' | 'dry-run') — **denormalized snapshot** of the config at execution time. `validator_configs` is the source of truth; the run is the immutable historical record (FR-013). Drift is expected and acceptable — the run reflects what actually ran.
- `verdict`: varchar ('pass' | 'append_disclaimer' | 'block' | 'strip' | 'no_op' | 'error')
- `confidence`: float (Nullable) — deterministic validators (identity-guard, format-injection) record **1.0**; null only when genuinely not computed. SC-002 catch-rate is measured over judge-based runs where confidence is populated.
- `action_taken`: varchar ('none' | 'disclaimer' | 'block' | 'strip')
- `original_content`: text — **PII-bearing** (full generated reply or inbound user message)
- `remediated_content`: text (Nullable)
- `latency_ms`: integer
- `created_at`: timestamp
- **Indexes**: `(tenant_id, persona_id)`, `(conversation_id)`, and **`(tenant_id, created_at)`** for time-bounded audit queries (FR-013).
- **RLS**: row-level-security policy keyed on `tenant_id` (FR-021).

## Notes
- **Defaults (FR-015, revised post-review)**: when no `validator_configs` row exists, `false-promise` and `format-injection` default to **active**; `identity-and-provider-guard` defaults to **dry-run** until a persona-specific `fallbackMessage` is configured. Rationale: identity-guard's remediation is a *total rewrite* — defaulting it active for an unconfigured persona would replace every identity-question reply with a generic default that mismatches the persona's name/language (deploy-day footgun). Promotion to `active` happens once `fallbackMessage` is set (see migration task T017).
- **PII / retention (FR-023)**: `original_content` / `remediated_content` MUST follow the same retention/redaction policy as the `messages` table (TTL or scrubbing job, if any). Do not create a longer-lived second copy of message bodies. If `messages` has no retention policy yet, this is a tracked gap (spec Assumptions), not a silent one.
- **Volume**: high-write table — roughly one row per validator per message. Budget ≈ conversations/day × validators × messages (e.g. 100 × 3 × 10 ≈ 3 000 rows/day). Revisit partitioning / archival in Phase 2 if growth warrants; the `(tenant_id, created_at)` index keeps audit queries bounded meanwhile.
- **Empty-output guard (FR-019)**: enforced in the pipeline orchestrator, not the schema — the delivered reply is never empty/whitespace-only after remediation.
