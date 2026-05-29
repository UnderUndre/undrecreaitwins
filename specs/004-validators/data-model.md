# Data Model: Validators

## Overview
Adds database tables for per-tenant/per-persona validator configuration and logging of validator executions. Implemented in `packages/core/src/db.ts` (or appropriate schema file).

## Tables

### 1. `validator_configs`
Stores configuration for validators per tenant and persona.

- `id`: uuid, primary key
- `tenant_id`: varchar, foreign key, indexed
- `persona_id`: uuid, foreign key, indexed
- `validators`: jsonb (Stores the list of active/dry-run validators, e.g., `{ "false-promise": { "mode": "active", "min_confidence": 0.7, "timeout_ms": 1500, "remediation": "append_disclaimer" }, "format-injection": { "mode": "active" } }`)
- `created_at`: timestamp
- `updated_at`: timestamp
- **Constraints**: Unique constraint on `(tenant_id, persona_id)`.

### 2. `validator_runs`
Audit log of validator executions.

- `id`: uuid, primary key
- `tenant_id`: varchar, indexed
- `persona_id`: uuid, indexed
- `conversation_id`: uuid, indexed
- `message_id`: uuid, indexed (Optional, null if pre-generation format strip)
- `validator_name`: varchar (e.g., 'false-promise')
- `mode`: varchar ('active' | 'dry-run')
- `verdict`: varchar ('pass' | 'append_disclaimer' | 'block' | 'strip' | 'no_op')
- `confidence`: float (Nullable)
- `action_taken`: varchar ('none' | 'disclaimer' | 'block' | 'strip')
- `original_content`: text
- `remediated_content`: text (Nullable)
- `latency_ms`: integer
- `created_at`: timestamp

## Notes
- Defaults (all active) apply when a row in `validator_configs` does not exist for a persona.
