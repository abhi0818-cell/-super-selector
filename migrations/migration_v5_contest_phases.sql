-- Migration v5: Add contest phase configuration columns
-- Run this in the Supabase SQL editor

ALTER TABLE contests
  ADD COLUMN IF NOT EXISTS start_match_number         INTEGER DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS playoff_start_match_number INTEGER DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS playoff_transfers_allowed  INTEGER DEFAULT NULL;

COMMENT ON COLUMN contests.start_match_number         IS 'Season-long scoring only counts from this match number onward (inclusive). NULL = all matches.';
COMMENT ON COLUMN contests.playoff_start_match_number IS 'Match number where the playoff phase begins. NULL = no playoff phase.';
COMMENT ON COLUMN contests.playoff_transfers_allowed  IS 'Separate transfer budget for the playoff phase. NULL = use regular budget.';
