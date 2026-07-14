-- Run in Supabase SQL Editor. Targets the CURRENTLY LIVE match specifically,
-- since that's the case you said is still broken ("history is fine" = once
-- a match completes it's OK, only live ones show missing transfers for
-- other squads).
--
-- NOTE: the SQL Editor runs as the postgres role, which BYPASSES RLS — so
-- every query below will return data even if RLS would still block a real
-- end user. That's intentional: this checks whether the underlying DATA
-- exists and is correct, to separate "RLS is still wrong" from "the data
-- itself was never written for this match" (a different bug — lock-matches
-- not having run/finished for this match yet).

-- 1. Find the live match(es) right now.
SELECT id, tournament_id, match_number, status, start_time, lock_time
FROM matches
WHERE status IN ('live', 'in_progress')
ORDER BY start_time DESC;

-- 2. For that match's tournament, list every SL squad and whether it has a
--    locked XI yet for this match. If squads OTHER than your own show
--    locked = false here, lock-matches simply hasn't processed this match
--    for them yet (not an RLS problem) — re-run with the real match id below.
-- Replace '<MATCH_ID>' with the id from query 1.
WITH m AS (SELECT id, tournament_id FROM matches WHERE id = '<MATCH_ID>')
SELECT
  us.id   AS squad_id,
  us.name AS squad_name,
  us.user_id,
  EXISTS (
    SELECT 1 FROM user_match_xi uxi
    WHERE uxi.squad_id = us.id AND uxi.match_id = (SELECT id FROM m)
  ) AS xi_locked,
  (
    SELECT count(*) FROM user_transfers ut
    WHERE ut.squad_id = us.id AND ut.match_id = (SELECT id FROM m)
  ) AS transfer_rows
FROM user_squads us
JOIN contests c ON c.id = us.contest_id
WHERE c.tournament_id = (SELECT tournament_id FROM m)
  AND c.contest_type = 'season_long'
ORDER BY squad_name;

-- 3. Re-confirm the live policy text actually in effect right now (not just
--    that a migration file exists locally) — should show
--    user_transfers_authenticated_read for SELECT.
SELECT policyname, cmd, qual
FROM pg_policies
WHERE tablename = 'user_transfers';

-- 4. Same for booster activations.
SELECT policyname, cmd, qual
FROM pg_policies
WHERE tablename = 'user_booster_activations';
