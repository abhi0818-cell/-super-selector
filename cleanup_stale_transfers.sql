-- Cleanup: remove all season-long data written during testing before
-- start_match_number was configured (M68, M69, M70).
--
-- These rows were generated with M67 as the transfer baseline, which is
-- incorrect now that the season starts at M68.  Run this once in the
-- Supabase SQL editor, then start fresh by picking your M68 XI in the app.
--
-- STEP 1 — find the match UUIDs you want to clean:
--
--   SELECT id, match_number FROM matches
--   WHERE match_number IN (68, 69, 70)
--   ORDER BY match_number;
--
-- STEP 2 — replace the placeholders below and run.
-- (Safe to run multiple times — idempotent.)

DO $$
DECLARE
  m68 UUID := '<M68_MATCH_ID>';   -- replace with real UUID
  m69 UUID := '<M69_MATCH_ID>';   -- replace with real UUID
  m70 UUID := '<M70_MATCH_ID>';   -- replace with real UUID
  match_ids UUID[] := ARRAY[m68, m69, m70];
  tid UUID;
BEGIN
  -- 1. user_transfers
  DELETE FROM user_transfers WHERE match_id = ANY(match_ids);

  -- 2. user_match_xi (season-long XI rows)
  DELETE FROM user_match_xi WHERE match_id = ANY(match_ids);

  -- 3. user_team_players + user_teams (SL teams written by upsertSlTeam)
  FOR tid IN
    SELECT id FROM user_teams
    WHERE match_id = ANY(match_ids)
      AND squad_id IS NOT NULL   -- SL teams only; leave daily teams untouched
  LOOP
    DELETE FROM user_team_players WHERE user_team_id = tid;
    DELETE FROM user_teams        WHERE id           = tid;
  END LOOP;

  RAISE NOTICE 'Cleanup complete for match numbers 68, 69, 70.';
END $$;
