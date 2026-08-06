-- Migration v39: Make playoff_first_match_unlimited the DEFAULT behavior
-- Run this in the Supabase SQL editor
--
-- Product decision: whenever a contest has a playoff phase configured, the
-- first playoff match should be unlimited-and-free by default, with no
-- separate admin step required. The admin checkbox added in v38 remains
-- available for the rare exception where a league wants the first playoff
-- match to share the same pooled budget as the rest of the playoffs instead.

ALTER TABLE contests
  ALTER COLUMN playoff_first_match_unlimited SET DEFAULT true;

-- Backfill: any existing contest with a playoff phase already configured
-- gets the new default too (MLC was already set true in v38; this covers
-- any other season-long contest with playoff_start_match_number set).
UPDATE contests
SET playoff_first_match_unlimited = true
WHERE playoff_start_match_number IS NOT NULL
  AND playoff_first_match_unlimited = false;

COMMENT ON COLUMN contests.playoff_first_match_unlimited IS
  'Defaults to true whenever a playoff phase is configured. If true, the first playoff match (match_number == playoff_start_match_number) has unlimited, cost-free transfers and its transfers are excluded from the pooled playoff_transfers_allowed budget used by the rest of the playoff matches. Set to false only as a deliberate exception for a specific contest.';
