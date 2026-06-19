-- 0015_validator_runs_language_guard_idx.sql
-- D-2: Add composite index for language-guard audit-log query (GET /logs endpoint)
-- Without this index, the query seq-scans within (tenant_id, persona_id) partition

CREATE INDEX IF NOT EXISTS idx_validator_runs_validator_created
  ON validator_runs (tenant_id, persona_id, validator_name, created_at DESC, id DESC);
