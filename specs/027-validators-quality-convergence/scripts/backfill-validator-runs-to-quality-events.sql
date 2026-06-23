-- T040: Backfill historical validator_runs → quality_events
-- Standing Order 5: REVIEW BEFORE EXECUTING — do NOT run on prod without review.
-- This script is additive (INSERT only), safe to review and test on staging first.
-- 
-- Mapping:
--   validator_runs.verdict (old enum) → quality_events.verdict (VerdictCoarse)
--   'no_op' / 'pass'       → 'pass'
--   'block'                → 'block'
--   'rewrite'              → 'corrected'
--   'strip'                → 'corrected'
--   'append_disclaimer'    → 'corrected'
--   'error'                → 'warn'
--
-- Prerequisites:
--   1. BFF quality_events table must exist (from T003 Prisma migration)
--   2. Engine validator_runs table must be accessible from BFF context
--      (cross-DB query or export/import — depends on deployment topology)

BEGIN;

INSERT INTO quality_events (
  ts,
  kind,
  rule_key,
  verdict,
  detail,
  conversation_id,
  message_id,
  latency_ms,
  original_response_snippet,
  modified_response_snippet,
  created_at
)
SELECT
  vr.created_at AS ts,
  'system' AS kind,
  vr.validator_name AS rule_key,
  CASE vr.verdict
    WHEN 'no_op'             THEN 'pass'
    WHEN 'pass'              THEN 'pass'
    WHEN 'block'             THEN 'block'
    WHEN 'rewrite'           THEN 'corrected'
    WHEN 'strip'             THEN 'corrected'
    WHEN 'append_disclaimer' THEN 'corrected'
    WHEN 'error'             THEN 'warn'
    ELSE 'warn'
  END AS verdict,
  CASE vr.verdict
    WHEN 'strip'             THEN 'stripped'
    WHEN 'rewrite'           THEN 'rewritten'
    WHEN 'append_disclaimer' THEN 'rewritten'
    WHEN 'block'             THEN 'rewritten'
    WHEN 'error'             THEN 'degraded'
    ELSE NULL
  END AS detail,
  vr.conversation_id,
  vr.message_id,
  vr.latency_ms,
  LEFT(vr.original_content, 500) AS original_response_snippet,
  LEFT(vr.remediated_content, 500) AS modified_response_snippet,
  NOW() AS created_at
FROM validator_runs vr
WHERE vr.created_at < NOW() - INTERVAL '1 hour'  -- skip very recent, avoid race
  AND NOT EXISTS (
    SELECT 1 FROM quality_events qe
    WHERE qe.conversation_id = vr.conversation_id
      AND qe.rule_key = vr.validator_name
      AND qe.ts = vr.created_at
  );

COMMIT;

-- Dry-run (no-op) version for review:
-- Replace BEGIN; ... COMMIT; with BEGIN; ROLLBACK; to test without persisting.
