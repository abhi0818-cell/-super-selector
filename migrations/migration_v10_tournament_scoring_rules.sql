-- migration_v10: move scoring rules onto the tournaments row
-- Run in Supabase SQL editor.

-- 1. Add scoring_rules JSONB column to tournaments
ALTER TABLE tournaments
  ADD COLUMN IF NOT EXISTS scoring_rules JSONB;

-- 2. (Optional) Migrate any existing global scoring_rules rows into the
--    most-recently-created tournament so history isn't lost.
--    Safe to skip if you haven't customised the defaults.
--
-- UPDATE tournaments t
-- SET scoring_rules = (
--   SELECT jsonb_object_agg(sr.format, sr.rules)
--   FROM scoring_rules sr
-- )
-- WHERE t.id = (SELECT id FROM tournaments ORDER BY start_date DESC LIMIT 1);

-- The legacy scoring_rules table is kept intact as a fallback
-- and can be dropped later once all tournaments use the new column.
