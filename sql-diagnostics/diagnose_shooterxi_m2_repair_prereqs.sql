-- Prereqs for repairing ShooterXI's missing M1→M2 transfer records.
-- Run each block separately (Supabase SQL Editor only shows the last
-- statement's result when several are run together).

-- 1) CPL contest's transfer rules.
SELECT free_transfers_per_match, extra_transfer_point_cost, total_transfers_allowed
FROM contests
WHERE id = '3d66c13f-d7fb-497c-baff-bdc50edede61';

-- 2) Any booster ShooterXI had active for M2 (e.g. a wildcard/free-hit that
--    suspends the transfer cap) — squad_id from the earlier squad_draft_xi
--    result.
SELECT *
FROM user_booster_activations
WHERE squad_id = 'dc1ad8cf-3541-4947-be2f-bf47c9555aa7'
ORDER BY activated_at DESC;

-- 3) Confirm M2's real match_id + match_number (needed for the INSERT match_id).
SELECT id, match_number, status, start_time
FROM matches
WHERE tournament_id = 'b434446d-f817-4fe3-a930-cedc88084b24'
  AND match_number = 2;
