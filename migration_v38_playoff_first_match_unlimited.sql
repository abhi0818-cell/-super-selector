-- Migration v38: Playoff first-match-unlimited flag
-- Run this in the Supabase SQL editor
--
-- Supports the common playoff pattern: the FIRST playoff match (M31, i.e.
-- match_number == playoff_start_match_number) gets unlimited transfers as a
-- reset point, and the remaining playoff matches (M32..M34) share a single
-- pooled budget (playoff_transfers_allowed). Previously playoff_transfers_allowed
-- applied uniformly to the whole playoff window including the first match —
-- there was no way to carve the first match out as unlimited.

ALTER TABLE contests
  ADD COLUMN IF NOT EXISTS playoff_first_match_unlimited BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN contests.playoff_first_match_unlimited IS
  'If true, the first playoff match (match_number == playoff_start_match_number) has unlimited transfers and its transfers are excluded from the pooled playoff_transfers_allowed budget used by the rest of the playoff matches.';

-- Enable it for MLC Season Long (M31 unlimited, M32-M34 share the pooled
-- playoff_transfers_allowed = 10 budget already set on this contest).
UPDATE contests
SET playoff_first_match_unlimited = true
WHERE id = '4bdbf63d-90fd-4056-9fad-3d626a23369b';
