-- 0016_grounding_mode_fulltext.sql
-- T001: Add grounding mode, truncation strategy, embeddings status, full-text, and priority columns

ALTER TABLE tenants ADD COLUMN grounding_mode TEXT NOT NULL DEFAULT 'vector';
ALTER TABLE personas ADD COLUMN grounding_mode TEXT;
ALTER TABLE personas ADD COLUMN big_context_max_tokens INTEGER;
ALTER TABLE personas ADD COLUMN truncation_strategy TEXT NOT NULL DEFAULT 'silent';
ALTER TABLE personas ADD COLUMN embeddings_status TEXT NOT NULL DEFAULT 'idle';
ALTER TABLE documents ADD COLUMN full_text TEXT;
ALTER TABLE documents ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF current_setting('server_version_num')::int >= 140000 THEN
    ALTER TABLE documents ALTER COLUMN full_text SET COMPRESSION lz4;
  ELSE
    RAISE NOTICE 'PG < 14 (%); skipping lz4 compression for full_text.', current_setting('server_version');
  END IF;
END $$;
