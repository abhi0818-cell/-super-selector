-- migration_v26: per-match data-source override
-- Run in Supabase SQL Editor.
--
-- Today, whether a match is polled via CricAPI or scraped from CricketAddictor/
-- Business Standard is decided entirely by tournaments.scraper_enabled — a single
-- flag for the whole tournament. That means there's no way to force one specific
-- match onto the other source (e.g. the scraper's name-matching keeps failing for
-- one fixture, or CricAPI is temporarily blocked and you want to fall back to the
-- scraper for just the matches happening today).
--
-- Adds:
--   matches.data_source  — 'auto' (default, inherit tournament.scraper_enabled)
--                           | 'scraper'  (always use scrape-scorecard, regardless
--                                         of the tournament default)
--                           | 'cricapi'  (always use poll-cricapi, regardless of
--                                         the tournament default)
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE matches
  ADD COLUMN IF NOT EXISTS data_source TEXT NOT NULL DEFAULT 'auto'
    CHECK (data_source IN ('auto', 'scraper', 'cricapi'));
