-- CPL — verify EVERY season-long squad's M1→M2 transfers were correctly
-- captured, not just one user's. Read-only. Run in Supabase SQL Editor.
--
-- NOTE: the SQL Editor runs as the postgres role, which BYPASSES RLS — this
-- checks the underlying data itself, independent of what any one user's
-- client can currently see.
--
-- METHOD: derive what SHOULD have been transferred by diffing each squad's
-- locked M1 XI against its locked M2 XI (a player in M1's XI but missing
-- from M2's XI must have been transferred OUT before M2; a player new in
-- M2's XI but absent from M1's must have been transferred IN). Compare that
-- derived set against what's actually sitting in user_transfers for M2.
-- Any disagreement means a transfer was dropped, double-counted, or the
-- lock captured a stale/wrong draft — this is exactly the kind of gap the
-- recent squad_draft_xi diff fix (MyXIScreen.tsx) targets, so this query
-- doubles as a way to confirm that fix didn't leave any squad stuck with
-- bad historical data.

-- ── 0. Confirmed CPL ids (from contests table lookup):
--      contest_id    = 3d66c13f-d7fb-497c-baff-bdc50edede61  (CPL 2026 Season Long)
--      tournament_id = b434446d-f817-4fe3-a930-cedc88084b24
-- Sanity check M1/M2 resolve to real matches before trusting the results below.
SELECT id AS match_id, match_number, status, start_time
FROM matches
WHERE tournament_id = 'b434446d-f817-4fe3-a930-cedc88084b24'
ORDER BY match_number
LIMIT 5;

-- ── 1. Main check — one row per squad, flagging any mismatch.
WITH cpl_contest AS (
  SELECT
    '3d66c13f-d7fb-497c-baff-bdc50edede61'::uuid AS contest_id,
    'b434446d-f817-4fe3-a930-cedc88084b24'::uuid AS tournament_id
),
m1 AS (
  SELECT id FROM matches
  WHERE tournament_id = (SELECT tournament_id FROM cpl_contest) AND match_number = 1
),
m2 AS (
  SELECT id FROM matches
  WHERE tournament_id = (SELECT tournament_id FROM cpl_contest) AND match_number = 2
),
m1_xi AS (
  SELECT squad_id, array_agg(player_id ORDER BY player_id) AS players
  FROM user_match_xi
  WHERE match_id = (SELECT id FROM m1)
  GROUP BY squad_id
),
m2_xi AS (
  SELECT squad_id, array_agg(player_id ORDER BY player_id) AS players
  FROM user_match_xi
  WHERE match_id = (SELECT id FROM m2)
  GROUP BY squad_id
),
all_squads AS (
  SELECT us.id AS squad_id, us.name AS squad_name, us.user_id, p.email,
         us.free_transfers_available
  FROM user_squads us
  LEFT JOIN profiles p ON p.id = us.user_id
  WHERE us.contest_id = (SELECT contest_id FROM cpl_contest)
),
derived AS (
  SELECT
    s.squad_id, s.squad_name, s.email, s.free_transfers_available,
    m1x.players AS m1_players,
    m2x.players AS m2_players,
    ARRAY(SELECT unnest(coalesce(m1x.players,'{}')) EXCEPT SELECT unnest(coalesce(m2x.players,'{}'))) AS should_be_out,
    ARRAY(SELECT unnest(coalesce(m2x.players,'{}')) EXCEPT SELECT unnest(coalesce(m1x.players,'{}'))) AS should_be_in
  FROM all_squads s
  LEFT JOIN m1_xi m1x ON m1x.squad_id = s.squad_id
  LEFT JOIN m2_xi m2x ON m2x.squad_id = s.squad_id
),
actual AS (
  SELECT
    squad_id,
    array_agg(player_out_id ORDER BY player_out_id) AS actual_out,
    array_agg(player_in_id  ORDER BY player_in_id)  AS actual_in,
    count(*)                                        AS transfer_row_count,
    sum(points_deducted)                            AS points_deducted_total
  FROM user_transfers
  WHERE match_id = (SELECT id FROM m2)
  GROUP BY squad_id
)
SELECT
  d.squad_name,
  d.email,
  coalesce(array_length(d.m1_players,1), 0) AS m1_xi_count,
  coalesce(array_length(d.m2_players,1), 0) AS m2_xi_count,
  d.should_be_out            AS derived_should_be_out,
  d.should_be_in             AS derived_should_be_in,
  coalesce(a.actual_out, '{}') AS actually_recorded_out,
  coalesce(a.actual_in,  '{}') AS actually_recorded_in,
  coalesce(a.transfer_row_count, 0)  AS transfer_rows_written,
  coalesce(a.points_deducted_total, 0) AS points_deducted,
  CASE
    WHEN d.m1_players IS NULL OR d.m2_players IS NULL
      THEN 'NO XI LOCKED FOR M1 OR M2 — investigate separately, not a transfer bug'
    WHEN (
      ARRAY(SELECT unnest(d.should_be_out) EXCEPT SELECT unnest(coalesce(a.actual_out,'{}'))) = '{}'
      AND ARRAY(SELECT unnest(coalesce(a.actual_out,'{}')) EXCEPT SELECT unnest(d.should_be_out)) = '{}'
      AND ARRAY(SELECT unnest(d.should_be_in) EXCEPT SELECT unnest(coalesce(a.actual_in,'{}'))) = '{}'
      AND ARRAY(SELECT unnest(coalesce(a.actual_in,'{}')) EXCEPT SELECT unnest(d.should_be_in)) = '{}'
    ) THEN 'OK — matches'
    ELSE '*** MISMATCH ***'
  END AS status
FROM derived d
LEFT JOIN actual a ON a.squad_id = d.squad_id
ORDER BY status DESC, squad_name;

-- ── 2. Optional follow-up if any squad shows MISMATCH above: pull its raw
--      user_transfers rows for M2 plus its user_squad_players release/
--      acquire history, to see exactly what WAS written vs. what the XI
--      diff says should have been. Replace '<SQUAD_ID>' with the squad_id
--      of a flagged row (join back through squad_name/email above to find it).
-- SELECT * FROM v_transfer_history WHERE squad_id = '<SQUAD_ID>' ORDER BY transferred_at DESC;
-- SELECT * FROM user_squad_players WHERE squad_id = '<SQUAD_ID>' ORDER BY acquired_at DESC;
