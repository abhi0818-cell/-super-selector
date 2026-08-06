-- migration_v29: allow 'scraper_manual' as a player_match_stats.source value
-- Run in Supabase SQL Editor.
--
-- applyManualFieldingCredit (db.js) — used by the admin "Fielding Issues" panel's
-- Credit button, and by resolveUnmatchedAsNewPlayer's fielding-credit path — has
-- always written source = 'scraper_manual' so a later scrape-scorecard re-poll
-- knows to leave that player's row alone (see the regression-guard check in
-- supabase/functions/scrape-scorecard/index.ts: "ex.source === 'scraper_manual'
-- always wins"). But migration_v21's CHECK constraint on player_match_stats.source
-- only ever allowed ('cricapi','scraper','manual') — 'scraper_manual' was never
-- added, so every manual fielding credit has been failing with:
--   "new row for relation "player_match_stats" violates check constraint
--    "player_match_stats_source_check""
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE player_match_stats DROP CONSTRAINT IF EXISTS player_match_stats_source_check;

ALTER TABLE player_match_stats
  ADD CONSTRAINT player_match_stats_source_check
  CHECK (source IN ('cricapi','scraper','manual','scraper_manual'));
