-- 015: Add credentialsCiphertext + kmsKeyRef to channel_instances
-- Standing Order 5: review-only migration, do NOT auto-execute.
-- Safety (gemini-F3): idempotent, re-runnable.

-- Add columns (IF NOT EXISTS for idempotency)
ALTER TABLE channel_instances
  ADD COLUMN IF NOT EXISTS credentials_ciphertext TEXT,
  ADD COLUMN IF NOT EXISTS kms_key_ref TEXT;

-- Backfill: encrypt existing plaintext secrets from config → credentials_ciphertext
-- This step MUST be run AFTER the KmsProvider is configured.
-- Steps:
--   1. Read all rows where credentials_ciphertext IS NULL
--   2. For each row, extract secret fields from config (platform-specific)
--   3. Encrypt via KmsProvider.encrypt() → { ciphertext, keyRef }
--   4. UPDATE channel_instances SET credentials_ciphertext = $ciphertext, kms_key_ref = $keyRef WHERE id = $id
--   5. Verify decrypt round-trips BEFORE scrubbing plaintext from config (no data loss)
--   6. Remove secret fields from config jsonb (keep non-secret display config)
-- CAUTION: Do NOT scrub config secrets until step 5 passes for every row.
-- This migration is designed to be run by a script, not raw SQL.
-- The SQL below only adds columns; backfill requires application logic.

-- Verify columns exist
DO $$
BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'channel_instances' AND column_name = 'credentials_ciphertext'
  ), 'credentials_ciphertext column missing after ALTER';
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'channel_instances' AND column_name = 'kms_key_ref'
  ), 'kms_key_ref column missing after ALTER';
END $$;
