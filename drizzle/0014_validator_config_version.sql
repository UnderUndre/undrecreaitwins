-- T000: Add version column for atomic optimistic locking on validator_configs
-- One-time ALTER TABLE (not full table rebuild)

ALTER TABLE validator_configs
  ADD COLUMN version INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_validator_configs_version
  ON validator_configs (tenant_id, persona_id, validator_name, version);
