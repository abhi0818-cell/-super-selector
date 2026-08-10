-- Repairs ShooterXI's missing M1→M2 transfer records in CPL 2026 Season Long.
--
-- Root cause: the pre-fa4721d "first active lock" bug wrongly treated M1
-- (the earliest match, already marked 'completed' by lock time) as having
-- "no real baseline", so M2's lock diffed against an empty baseline instead
-- of the squad's real M1 XI — meaning no user_transfers rows got written,
-- even though the M2 XI itself saved the new players correctly. Confirmed
-- via diagnose_cpl_all_squads_m1_m2_transfers.sql (the only squad flagged
-- *** MISMATCH ***) and diagnose_shooterxi_m2_repair_prereqs.sql (contest
-- has free_transfers_per_match = null → unlimited free transfers, so this
-- is purely an audit-trail repair with zero scoring/points impact).
--
-- squad_id = dc1ad8cf-3541-4947-be2f-bf47c9555aa7 (ShooterXI, kumarharshit03@gmail.com)
-- match_id = 975dc666-7af7-4db0-ba3b-eefde34f6dc6 (M2)
-- Derived diff (M1 XI minus M2 XI / M2 XI minus M1 XI):
--   out: p85, p86, scr_1781916608352
--   in:  p538, p539, scr_1781916475717

-- ── 1. Pre-check — should return 0 rows. If this returns anything, STOP —
--      someone already backfilled this and re-running would duplicate it.
SELECT * FROM user_transfers
WHERE squad_id = 'dc1ad8cf-3541-4947-be2f-bf47c9555aa7'
  AND match_id = '975dc666-7af7-4db0-ba3b-eefde34f6dc6';

-- ── 2. The actual repair.
INSERT INTO user_transfers
  (squad_id, match_id, player_out_id, player_in_id, is_free, points_deducted, transferred_at)
VALUES
  ('dc1ad8cf-3541-4947-be2f-bf47c9555aa7', '975dc666-7af7-4db0-ba3b-eefde34f6dc6', 'p85',               'p538',               true, 0, '2026-08-08 23:00:00+00'),
  ('dc1ad8cf-3541-4947-be2f-bf47c9555aa7', '975dc666-7af7-4db0-ba3b-eefde34f6dc6', 'p86',               'p539',               true, 0, '2026-08-08 23:00:00+00'),
  ('dc1ad8cf-3541-4947-be2f-bf47c9555aa7', '975dc666-7af7-4db0-ba3b-eefde34f6dc6', 'scr_1781916608352', 'scr_1781916475717',  true, 0, '2026-08-08 23:00:00+00');

-- ── 3. Verify — re-run the all-squads diagnostic's derived-vs-actual check
--      for just this squad; should now say OK.
SELECT
  array_agg(player_out_id ORDER BY player_out_id) AS actual_out,
  array_agg(player_in_id  ORDER BY player_in_id)  AS actual_in,
  count(*) AS transfer_rows
FROM user_transfers
WHERE squad_id = 'dc1ad8cf-3541-4947-be2f-bf47c9555aa7'
  AND match_id = '975dc666-7af7-4db0-ba3b-eefde34f6dc6';
-- Expect: actual_out = {p85,p86,scr_1781916608352}, actual_in = {p538,p539,scr_1781916475717}, transfer_rows = 3
