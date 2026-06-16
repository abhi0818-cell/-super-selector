-- migration_v13: shared squad support
-- Allows a private-league squad to mirror another squad's XI automatically.
-- Run in Supabase SQL editor.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Add primary_squad_id to user_squads
--
--    NULL  → independent squad (picks its own XI — default for all existing rows)
--    set   → shared squad (XI is propagated from the primary squad at lock time)
--
--    A shared squad is created when a user joins a private league that has
--    identical scoring rules AND identical boosters to the main SL contest
--    (i.e. contest.scoring_rules IS NULL AND contest.available_boosters IS NULL).
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE user_squads
  ADD COLUMN IF NOT EXISTS primary_squad_id UUID REFERENCES user_squads(id) ON DELETE SET NULL;

-- Index for fast "give me all squads that share squad X" lookups
-- (used at lock time to propagate the XI to shared leagues)
CREATE INDEX IF NOT EXISTS user_squads_primary_squad_idx
  ON user_squads (primary_squad_id)
  WHERE primary_squad_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. No RLS changes needed — user_squads RLS already scopes to user_id.
--    The primary_squad_id is just metadata; the sharing logic lives in the app.
-- ─────────────────────────────────────────────────────────────────────────────
