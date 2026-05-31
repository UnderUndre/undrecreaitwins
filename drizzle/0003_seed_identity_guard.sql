-- Seed migration: default identity-and-provider-guard to 'dry-run' for all existing personas
-- This ensures that personas with no configured identity guard don't suddenly start 
-- blocking/rewriting without an explicit fallbackMessage being set.

INSERT INTO validator_configs (tenant_id, persona_id, validator_name, mode, config)
SELECT 
    tenant_id, 
    id as persona_id, 
    'identity-and-provider-guard' as validator_name, 
    'dry-run' as mode, 
    '{}'::jsonb as config
FROM personas
ON CONFLICT (tenant_id, persona_id, validator_name) DO NOTHING;
