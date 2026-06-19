-- T000: Add version column for atomic optimistic locking on validator_configs
-- One-time ALTER TABLE (not full table rebuild)

ALTER TABLE validator_configs
  ADD COLUMN version INTEGER NOT NULL DEFAULT 0;

-- Index idx_validator_configs_version removed because (tenant_id, persona_id, validator_name) is already unique
