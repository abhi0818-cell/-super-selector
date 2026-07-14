-- ───────────────────────────────────────────────────────────────────────────
-- FIX: rewrite user_transfers for M5 (MLC tournament) using the correct
-- baseline — the squad's last locked XI before M5 — instead of whatever the
-- baseline bug logged (or failed to log). The M5 XI itself (user_match_xi)
-- is untouched; only the transfer log for that match is recomputed.
-- Safe to re-run (idempotent: deletes+reinserts per squad).
-- ───────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_tournament_id uuid;
  v_m5_id         uuid;
  v_squad         RECORD;
  v_prev_match_id uuid;
  v_prev_ids      uuid[];
  v_curr_ids      uuid[];
  v_out_ids       uuid[];
  v_in_ids        uuid[];
  v_n             int;
  v_free          int;
  v_cost          numeric;
  i               int;
BEGIN
  SELECT id INTO v_tournament_id FROM tournaments WHERE name ILIKE '%Major%' LIMIT 1;
  SELECT id INTO v_m5_id FROM matches WHERE tournament_id = v_tournament_id AND match_number = 5;

  IF v_tournament_id IS NULL OR v_m5_id IS NULL THEN
    RAISE EXCEPTION 'Could not resolve tournament or M5 match — check the name filter.';
  END IF;

  FOR v_squad IN
    SELECT us.id AS squad_id, c.free_transfers_per_match, c.extra_transfer_point_cost
    FROM user_squads us
    JOIN contests c ON c.id = us.contest_id
    WHERE c.tournament_id = v_tournament_id AND c.contest_type = 'season_long'
  LOOP
    SELECT mm.id INTO v_prev_match_id
    FROM matches mm
    JOIN user_match_xi uxi ON uxi.match_id = mm.id AND uxi.squad_id = v_squad.squad_id
    WHERE mm.tournament_id = v_tournament_id AND mm.match_number < 5
    ORDER BY mm.match_number DESC
    LIMIT 1;

    IF v_prev_match_id IS NULL THEN
      CONTINUE; -- no earlier lock for this squad — genuinely first lock, 0 transfers is correct
    END IF;

    SELECT array_agg(player_id) INTO v_prev_ids FROM user_match_xi WHERE squad_id = v_squad.squad_id AND match_id = v_prev_match_id;
    SELECT array_agg(player_id) INTO v_curr_ids FROM user_match_xi WHERE squad_id = v_squad.squad_id AND match_id = v_m5_id;

    IF v_curr_ids IS NULL THEN
      CONTINUE; -- squad hasn't locked M5 yet — nothing to fix
    END IF;

    v_out_ids := ARRAY(SELECT unnest(v_prev_ids) EXCEPT SELECT unnest(v_curr_ids));
    v_in_ids  := ARRAY(SELECT unnest(v_curr_ids) EXCEPT SELECT unnest(v_prev_ids));
    v_n := LEAST(COALESCE(array_length(v_out_ids,1),0), COALESCE(array_length(v_in_ids,1),0));

    DELETE FROM user_transfers WHERE squad_id = v_squad.squad_id AND match_id = v_m5_id;

    IF v_n > 0 THEN
      v_free := v_squad.free_transfers_per_match; -- NULL = unlimited free
      v_cost := COALESCE(v_squad.extra_transfer_point_cost, 4);
      FOR i IN 1..v_n LOOP
        INSERT INTO user_transfers (squad_id, match_id, player_out_id, player_in_id, is_free, points_deducted)
        VALUES (
          v_squad.squad_id, v_m5_id, v_out_ids[i], v_in_ids[i],
          (v_free IS NULL OR i <= v_free),
          CASE WHEN (v_free IS NULL OR i <= v_free) THEN 0 ELSE v_cost END
        );
      END LOOP;
    END IF;
  END LOOP;
END $$;

-- Verify
SELECT us.name, count(*) AS m5_transfers, COALESCE(sum(ut.points_deducted),0) AS m5_penalty
FROM user_squads us
LEFT JOIN user_transfers ut ON ut.squad_id = us.id
  AND ut.match_id = (SELECT id FROM matches WHERE tournament_id = (SELECT id FROM tournaments WHERE name ILIKE '%Major%' LIMIT 1) AND match_number = 5)
JOIN contests c ON c.id = us.contest_id AND c.contest_type = 'season_long'
WHERE c.tournament_id = (SELECT id FROM tournaments WHERE name ILIKE '%Major%' LIMIT 1)
GROUP BY us.name
ORDER BY us.name;
