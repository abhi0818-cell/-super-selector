-- ───────────────────────────────────────────────────────────────────────────
-- DIAGNOSTIC ONLY (no writes). Run this first and review the output.
-- For every SL squad in the MLC tournament, compares the correct transfer
-- count (derived from the actual locked XIs) against what's currently
-- logged in user_transfers for M5. Squads where these differ were hit by
-- the baseline bug.
-- ───────────────────────────────────────────────────────────────────────────
WITH trn AS (
  SELECT id FROM tournaments WHERE name ILIKE '%Major%' LIMIT 1
),
m5 AS (
  SELECT id FROM matches WHERE tournament_id = (SELECT id FROM trn) AND match_number = 5
),
squads AS (
  SELECT us.id AS squad_id, us.name AS squad_name, us.contest_id
  FROM user_squads us
  JOIN contests c ON c.id = us.contest_id
  WHERE c.tournament_id = (SELECT id FROM trn)
    AND c.contest_type = 'season_long'
),
prev_match AS (
  SELECT s.squad_id,
         (SELECT mm.id
            FROM matches mm
            JOIN user_match_xi uxi ON uxi.match_id = mm.id AND uxi.squad_id = s.squad_id
           WHERE mm.tournament_id = (SELECT id FROM trn) AND mm.match_number < 5
           ORDER BY mm.match_number DESC
           LIMIT 1) AS prev_match_id
  FROM squads s
),
curr AS (
  SELECT squad_id, array_agg(player_id) AS curr_ids
  FROM user_match_xi WHERE match_id = (SELECT id FROM m5) GROUP BY squad_id
),
prev AS (
  SELECT pm.squad_id, array_agg(uxi.player_id) AS prev_ids
  FROM prev_match pm
  JOIN user_match_xi uxi ON uxi.match_id = pm.prev_match_id AND uxi.squad_id = pm.squad_id
  GROUP BY pm.squad_id
)
SELECT
  s.squad_name,
  pm.prev_match_id IS NOT NULL                              AS has_prior_lock,
  COALESCE(array_length(p.prev_ids,1),0)                     AS prev_xi_size,
  COALESCE(array_length(c.curr_ids,1),0)                     AS m5_xi_size,
  LEAST(
    COALESCE(array_length(ARRAY(SELECT unnest(p.prev_ids) EXCEPT SELECT unnest(c.curr_ids)),1),0),
    COALESCE(array_length(ARRAY(SELECT unnest(c.curr_ids) EXCEPT SELECT unnest(p.prev_ids)),1),0)
  )                                                           AS correct_transfers,
  (SELECT count(*) FROM user_transfers ut
    WHERE ut.squad_id = s.squad_id AND ut.match_id = (SELECT id FROM m5))   AS currently_logged_transfers
FROM squads s
LEFT JOIN prev_match pm ON pm.squad_id = s.squad_id
LEFT JOIN prev p ON p.squad_id = s.squad_id
LEFT JOIN curr c ON c.squad_id = s.squad_id
ORDER BY s.squad_name;
