-- ───────────────────────────────────────────────────────────────────────────
-- READ-ONLY. No writes. Run any time — especially right after a match locks —
-- to confirm lock-matches is logging transfers correctly going forward.
--
-- For every squad's locked matches in the MLC season-long contest(s), compares
-- the transfer count implied by the actual locked XIs (current match vs. the
-- one locked immediately before it) against what's currently in
-- user_transfers. An EMPTY result = everything is registering correctly.
-- Any row returned = that squad/match was hit by a logging bug — investigate
-- before it compounds.
-- ───────────────────────────────────────────────────────────────────────────
WITH trn AS (
  SELECT id FROM tournaments WHERE name ILIKE '%Major%' LIMIT 1
),
sl_squads AS (
  SELECT us.id AS squad_id, us.name AS squad_name
  FROM user_squads us
  JOIN contests c ON c.id = us.contest_id
  WHERE c.tournament_id = (SELECT id FROM trn) AND c.contest_type = 'season_long'
),
locked AS (
  SELECT uxi.squad_id, m.id AS match_id, m.match_number,
         array_agg(uxi.player_id) AS xi_ids
  FROM user_match_xi uxi
  JOIN matches m ON m.id = uxi.match_id
  WHERE m.tournament_id = (SELECT id FROM trn)
  GROUP BY uxi.squad_id, m.id, m.match_number
),
with_prev AS (
  SELECT l.*,
    LAG(l.match_id) OVER (PARTITION BY l.squad_id ORDER BY l.match_number) AS prev_match_id,
    LAG(l.xi_ids)   OVER (PARTITION BY l.squad_id ORDER BY l.match_number) AS prev_xi_ids
  FROM locked l
)
SELECT
  s.squad_name,
  wp.match_number,
  LEAST(
    COALESCE(array_length(ARRAY(SELECT unnest(wp.prev_xi_ids) EXCEPT SELECT unnest(wp.xi_ids)),1),0),
    COALESCE(array_length(ARRAY(SELECT unnest(wp.xi_ids) EXCEPT SELECT unnest(wp.prev_xi_ids)),1),0)
  ) AS correct_transfers,
  (SELECT count(*) FROM user_transfers ut
     WHERE ut.squad_id = wp.squad_id AND ut.match_id = wp.match_id) AS logged_transfers
FROM with_prev wp
JOIN sl_squads s ON s.squad_id = wp.squad_id
WHERE wp.prev_match_id IS NOT NULL
  AND LEAST(
        COALESCE(array_length(ARRAY(SELECT unnest(wp.prev_xi_ids) EXCEPT SELECT unnest(wp.xi_ids)),1),0),
        COALESCE(array_length(ARRAY(SELECT unnest(wp.xi_ids) EXCEPT SELECT unnest(wp.prev_xi_ids)),1),0)
      )
      <> (SELECT count(*) FROM user_transfers ut
            WHERE ut.squad_id = wp.squad_id AND ut.match_id = wp.match_id)
ORDER BY wp.match_number, s.squad_name;
