-- ───────────────────────────────────────────────────────────────────────────
-- FIX: rewrite user_transfers for every (squad, match) pair in the MLC
-- season-long contest(s) where the logged transfer count doesn't match what
-- the actual locked XIs imply (i.e. squads hit by the lock-matches baseline
-- bug — see supabase/functions/lock-matches/index.ts fix).
--
-- Not scoped to a single match number on purpose: "between M5 & M6" was
-- ambiguous, and the underlying bug was an intermittent heuristic misfire
-- that could have silently zeroed transfers for ANY squad on ANY match, not
-- just Master Blaster. This walks each squad's full chronological lock
-- history and recomputes the transfer diff between each match and the one
-- locked immediately before it, then overwrites user_transfers only where
-- that differs from what's currently logged. Matches that are already
-- correct are left untouched. user_match_xi (the actual locked XIs) is
-- never touched — only the derived user_transfers log.
--
-- Safe to re-run (idempotent).
-- RAISE NOTICE lines show up in the Supabase SQL editor's "Messages" panel —
-- review those after running to see exactly what got corrected.
-- ───────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_tournament_id uuid;
  v_squad         RECORD;
  v_match         RECORD;
  v_prev_match_id uuid;
  v_prev_ids      text[];
  v_curr_ids      text[];
  v_out_ids       text[];
  v_in_ids        text[];
  v_n             int;
  v_logged_n      int;
  v_free          int;
  v_cost          numeric;
  i               int;
  v_fixed_count   int := 0;
BEGIN
  SELECT id INTO v_tournament_id FROM tournaments WHERE name ILIKE '%Major%' LIMIT 1;
  IF v_tournament_id IS NULL THEN
    RAISE EXCEPTION 'Could not resolve MLC tournament — check the name filter (expects name ILIKE %%Major%%).';
  END IF;

  FOR v_squad IN
    SELECT us.id AS squad_id, us.name AS squad_name,
           c.free_transfers_per_match, c.extra_transfer_point_cost
    FROM user_squads us
    JOIN contests c ON c.id = us.contest_id
    WHERE c.tournament_id = v_tournament_id AND c.contest_type = 'season_long'
  LOOP
    v_prev_match_id := NULL;
    v_prev_ids := NULL;

    -- Walk this squad's locked matches in chronological order
    FOR v_match IN
      SELECT m.id AS match_id, m.match_number
      FROM matches m
      JOIN user_match_xi uxi ON uxi.match_id = m.id AND uxi.squad_id = v_squad.squad_id
      WHERE m.tournament_id = v_tournament_id
      GROUP BY m.id, m.match_number
      ORDER BY m.match_number
    LOOP
      SELECT array_agg(player_id) INTO v_curr_ids
      FROM user_match_xi WHERE squad_id = v_squad.squad_id AND match_id = v_match.match_id;

      IF v_prev_match_id IS NOT NULL THEN
        v_out_ids := ARRAY(SELECT unnest(v_prev_ids) EXCEPT SELECT unnest(v_curr_ids));
        v_in_ids  := ARRAY(SELECT unnest(v_curr_ids) EXCEPT SELECT unnest(v_prev_ids));
        v_n := LEAST(COALESCE(array_length(v_out_ids,1),0), COALESCE(array_length(v_in_ids,1),0));

        SELECT count(*) INTO v_logged_n FROM user_transfers
          WHERE squad_id = v_squad.squad_id AND match_id = v_match.match_id;

        IF v_n <> v_logged_n THEN
          RAISE NOTICE 'Fixing % — M%: was logging % transfer(s), correct count is %',
            v_squad.squad_name, v_match.match_number, v_logged_n, v_n;

          DELETE FROM user_transfers WHERE squad_id = v_squad.squad_id AND match_id = v_match.match_id;

          IF v_n > 0 THEN
            v_free := v_squad.free_transfers_per_match; -- NULL = unlimited free
            v_cost := COALESCE(v_squad.extra_transfer_point_cost, 4);
            FOR i IN 1..v_n LOOP
              INSERT INTO user_transfers (squad_id, match_id, player_out_id, player_in_id, is_free, points_deducted)
              VALUES (
                v_squad.squad_id, v_match.match_id, v_out_ids[i], v_in_ids[i],
                (v_free IS NULL OR i <= v_free),
                CASE WHEN (v_free IS NULL OR i <= v_free) THEN 0 ELSE v_cost END
              );
            END LOOP;
          END IF;

          v_fixed_count := v_fixed_count + 1;
        END IF;
      END IF;

      v_prev_match_id := v_match.match_id;
      v_prev_ids := v_curr_ids;
    END LOOP;
  END LOOP;

  RAISE NOTICE 'Done — % (squad, match) pair(s) corrected.', v_fixed_count;
END $$;

-- Verify: full season transfer tally per squad after the fix
SELECT
  us.name                                  AS squad_name,
  m.match_number,
  count(ut.id)                             AS transfers_logged,
  COALESCE(sum(ut.points_deducted), 0)     AS points_deducted
FROM user_squads us
JOIN contests c ON c.id = us.contest_id AND c.contest_type = 'season_long'
JOIN matches m ON m.tournament_id = c.tournament_id
LEFT JOIN user_transfers ut ON ut.squad_id = us.id AND ut.match_id = m.id
WHERE c.tournament_id = (SELECT id FROM tournaments WHERE name ILIKE '%Major%' LIMIT 1)
  AND EXISTS (SELECT 1 FROM user_match_xi uxi WHERE uxi.squad_id = us.id AND uxi.match_id = m.id)
GROUP BY us.name, m.match_number
ORDER BY us.name, m.match_number;
