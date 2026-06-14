-- 0011_add_strip_pass_verdicts.sql
-- Adds 'strip' and 'pass' values to the validator_verdict enum (017 language-guard)
-- Review-only — do NOT execute without explicit approval

ALTER TYPE validator_verdict ADD VALUE IF NOT EXISTS 'strip';
ALTER TYPE validator_verdict ADD VALUE IF NOT EXISTS 'pass';
