-- ─────────────────────────────────────────────────────────────────────────────
-- Super Selector — Migration v3: Season Total Transfer Cap
--
-- Adds a configurable total_transfers_allowed column to the contests table.
-- NULL = unlimited (no season cap). Any integer = hard cap for the season.
--
-- Also adds free_transfers_per_match and extra_transfer_point_cost to contests
-- (if not already present from v2 — run is idempotent).
--
-- Run in Supabase SQL Editor → Run.
-- ─────────────────────────────────────────────────────────────────────────────

-- Add transfer config columns to contests (idempotent — safe to re-run)
alter table contests
  add column if not exists free_transfers_per_match    int  default null,   -- null = unlimited free per match
  add column if not exists extra_transfer_point_cost   int  default 0,      -- pts deducted per extra transfer
  add column if not exists total_transfers_allowed     int  default null;   -- null = no season cap

-- Example: update the IPL 2026 season-long contest to use a cap of 50 total transfers,
-- 2 free per match, 4 pts cost for extras.
-- Adjust values to taste — or leave NULL for unlimited.
--
-- update contests
--   set free_transfers_per_match  = 2,
--       extra_transfer_point_cost = 4,
--       total_transfers_allowed   = 50
--   where contest_type = 'season_long';
