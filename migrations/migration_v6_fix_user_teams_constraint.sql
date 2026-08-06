-- Migration v6: Fix user_teams unique constraint to allow both daily and SL teams per match
-- Run this in the Supabase SQL editor

-- 1. Drop the old constraint (covers all rows, blocks daily + SL sharing a match)
DROP INDEX IF EXISTS user_teams_one_per_match_idx;

-- 2. Partial index — one DAILY team per user per match (squad_id IS NULL rows only)
CREATE UNIQUE INDEX user_teams_one_per_match_idx
  ON user_teams (user_id, match_id)
  WHERE squad_id IS NULL;

-- 3. Separate unique constraint for SL teams — one per squad per match
CREATE UNIQUE INDEX IF NOT EXISTS user_teams_one_per_squad_match_idx
  ON user_teams (squad_id, match_id)
  WHERE squad_id IS NOT NULL;
