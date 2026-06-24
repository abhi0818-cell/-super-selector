-- migration_v30: per-tournament dot-ball scoring toggle
-- Run in Supabase SQL Editor.
--
-- Background: dot_ball has always been a real weight in DEFAULT_SCORING_RULES
-- (T20: 1 pt/dot, ODI: 0.5 pt/dot) and the scoring engines (web calcBowling,
-- scrape-scorecard, poll-cricapi, mobile cricketScoringEngine) have always
-- multiplied it in whenever a feed reports a per-bowler dot-ball count. Only
-- the *rules editor UI* hid the field, on the old assumption that no feed
-- would ever report dots — which turned out to be wrong for CricketAddictor-
-- scraped matches, so dot-ball points were silently scoring with no admin
-- visibility or control.
--
-- This adds an explicit per-tournament ON/OFF switch:
--   OFF (default) — dot_ball hidden from both the admin rules editor and the
--                    public Rules modal, AND forced to 0 at actual scoring
--                    time server-side, regardless of whatever numeric value
--                    happens to be saved in scoring_rules.
--   ON             — dot_ball visible + editable in both UIs, and applied at
--                    full configured weight when scoring.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE tournaments
  ADD COLUMN IF NOT EXISTS dot_ball_enabled BOOLEAN NOT NULL DEFAULT false;

-- Turn it ON for the tournaments currently live. Adjust the name pattern
-- below if it doesn't match what's in your tournaments table — run the
-- commented SELECT first to check names before the UPDATE.

-- select id, name, format, scraper_enabled from tournaments order by created_at desc;

UPDATE tournaments
SET dot_ball_enabled = true
WHERE name ILIKE '%T20%WC%' OR name ILIKE '%Women%T20%' OR name ILIKE '%MLC%' OR name ILIKE '%Major League%';

-- Verify
SELECT id, name, format, scraper_enabled, dot_ball_enabled FROM tournaments ORDER BY created_at DESC;
