-- Review-only migration: add funnel richness fields
-- NOTE: DO NOT APPLY TO PRODUCTION WITHOUT DB TEAM REVIEW

-- 1) create enum type for delivery mode
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'delivery_mode') THEN
        CREATE TYPE delivery_mode AS ENUM ('verbatim', 'template', 'llm');
    END IF;
END$$;

-- 2) add columns to funnel_fragments
ALTER TABLE IF EXISTS funnel_fragments
  ADD COLUMN IF NOT EXISTS delivery_mode delivery_mode NOT NULL DEFAULT 'llm',
  ADD COLUMN IF NOT EXISTS adaptive_intro boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS media_url text,
  ADD COLUMN IF NOT EXISTS delivery_condition jsonb;

-- 3) add columns to funnel_stages
ALTER TABLE IF EXISTS funnel_stages
  ADD COLUMN IF NOT EXISTS required_slots jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS requires_confirmation boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_anytime boolean NOT NULL DEFAULT false;

-- 4) add columns to funnel_slots
ALTER TABLE IF EXISTS funnel_slots
  ADD COLUMN IF NOT EXISTS locked boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS enum_values jsonb;

-- 5) add columns to conversation_funnel_states
ALTER TABLE IF EXISTS conversation_funnel_states
  ADD COLUMN IF NOT EXISTS return_stack jsonb NOT NULL DEFAULT '[]'::jsonb;

-- 6) add slots column to conversations
ALTER TABLE IF EXISTS conversations
  ADD COLUMN IF NOT EXISTS slots jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Rollback (for review only):
-- To rollback these changes, run (review & adapt as needed):
-- ALTER TABLE conversations DROP COLUMN IF EXISTS slots;
-- ALTER TABLE conversation_funnel_states DROP COLUMN IF EXISTS return_stack;
-- ALTER TABLE funnel_slots DROP COLUMN IF EXISTS enum_values, DROP COLUMN IF EXISTS locked;
-- ALTER TABLE funnel_stages DROP COLUMN IF EXISTS is_anytime, DROP COLUMN IF EXISTS requires_confirmation, DROP COLUMN IF EXISTS required_slots;
-- ALTER TABLE funnel_fragments DROP COLUMN IF EXISTS delivery_condition, DROP COLUMN IF EXISTS media_url, DROP COLUMN IF EXISTS adaptive_intro, DROP COLUMN IF EXISTS delivery_mode;
-- DROP TYPE IF EXISTS delivery_mode;
