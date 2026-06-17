-- migration_v27: per-match progress tracking + staleness guard
-- Run in Supabase SQL Editor.
--
-- Both poll-cricapi and scrape-scorecard can now run for the same match
-- (scraper every 15 min from start_time+5min, CricAPI every 30 min from
-- start_time+30min). Each source reads independently, so a slow/cached read
-- from one source can occasionally regress relative to what's already stored
-- (e.g. CricAPI reports "11 overs done" and a later scraper read reports
-- "4 overs done" because it hit a stale cache). Without a guard, that
-- regressed read would overwrite good data with worse data.
--
-- Adds:
--   matches.progress_innings — furthest innings number reached so far,
--                               across BOTH sources (starts at 0)
--   matches.progress_balls   — legal balls bowled in that furthest innings,
--                               across BOTH sources (starts at 0)
--
-- Both functions compare a freshly-parsed read against these two columns
-- before writing player_match_stats/leaderboard/history. If the new read's
-- (innings, balls) is LESS than what's stored, the read is treated as stale:
-- the write is skipped entirely for that match this cycle (logged as
-- 'stale_skipped' in the function's response), and the stored columns are
-- left untouched. Otherwise the write proceeds and these columns are bumped
-- up to the new value.
--
-- This guard applies to every match regardless of data_source — it's a
-- general defense against a single bad/cached read, not just a dual-source
-- conflict check.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE matches
  ADD COLUMN IF NOT EXISTS progress_innings INTEGER NOT NULL DEFAULT 0;

ALTER TABLE matches
  ADD COLUMN IF NOT EXISTS progress_balls INTEGER NOT NULL DEFAULT 0;
