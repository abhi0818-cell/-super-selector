-- Run in Supabase SQL Editor to check whether the two RLS fixes for
-- cross-squad transfer/booster visibility on the leaderboard are actually
-- live. (Asked: "other players can't see transfers for other squads in the
-- leaderboard for a live match" — this is the same symptom both fixes below
-- were written for.)

-- 1. Should return exactly:
--      user_transfers_authenticated_read | SELECT
--      user_transfers_own_delete         | DELETE
--      user_transfers_own_insert         | INSERT
-- If you instead see "user_transfers_own_select" (or no SELECT row at all),
-- migration_v30_user_transfers_leaderboard_rls.sql was never run (or didn't
-- take effect) — re-run that file.
SELECT policyname, cmd FROM pg_policies
WHERE tablename = 'user_transfers'
ORDER BY cmd;

-- 2. Should include "booster_activations_read_all" | SELECT.
-- If you instead see "booster_activations: read own" (or no SELECT row),
-- migration_v31_user_booster_activations_leaderboard_rls.sql was never run
-- — re-run that file.
SELECT policyname, cmd FROM pg_policies
WHERE tablename = 'user_booster_activations'
ORDER BY cmd;

-- 3. Spot-check as a normal (non-admin) user would see it: pick any contest
-- with 2+ squads, then run the line below as that contest's squad IDs.
-- If RLS is still wrong, this will return rows for only ONE squad_id even
-- though you passed several.
-- SELECT squad_id, count(*) FROM user_transfers
-- WHERE squad_id IN ('<squad-id-1>', '<squad-id-2>')
-- GROUP BY squad_id;
