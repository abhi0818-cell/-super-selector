-- ═══════════════════════════════════════════════════════════════════════════
-- Super Selector — Migration v59: stats_verified_at
--
-- Both scrape-scorecard and poll-cricapi can now flip matches.status to
-- 'completed' from a run whose stats/scorecard write was itself skipped by
-- the staleness guard (migration_v27) — see scrape-scorecard/index.ts step
-- 3b. That's intentional: a genuine "match ended" signal (read straight off
-- the page/API's own status text) must never be silently swallowed just
-- because the ball-by-ball numbers on that particular read looked regressed
-- relative to the stored watermark. But it means `status = 'completed'` can
-- now be true while the player_match_stats/match_scorecards behind it are
-- still whatever the last TRUSTED (non-stale) read produced — possibly a
-- mid-match snapshot, not the real final numbers.
--
-- Adds:
--   matches.stats_verified_at — timestamp of the last time this match's
--                                stats/scorecard were written from a
--                                trustworthy (non-stale) read. Set
--                                unconditionally by both scrape-scorecard
--                                and poll-cricapi every time they pass their
--                                respective staleness checks — NOT just when
--                                completion happens — so it doubles as a
--                                general "last verified" marker. The one
--                                place that deliberately never sets it is
--                                the staleness-guard bypass branch that
--                                flips status without writing stats.
--
-- `status = 'completed' AND stats_verified_at IS NULL` now uniquely
-- identifies a match that was auto-completed off a stale/unverified read.
-- The admin Matches table renders that combination as a "⚠ unverified"
-- badge next to the status pill, and the row's Scrape button (which always
-- bypasses staleness for a manual matchId call — see migration_v59's
-- accompanying index.ts changes) is the way to clear it: a successful
-- manual re-scrape stamps stats_verified_at for real.
--
-- Backfill: every match already 'completed' as of this migration predates
-- this column and the staleness-bypass behavior that motivated it — those
-- got marked completed the old way (a trustworthy write, or a manual
-- Finalize/admin override), so stamp them now. Otherwise every historical
-- completed match would show the "⚠ unverified" badge on first load, which
-- would be noise, not signal.
--
-- Paste into Supabase SQL Editor → Run.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE matches
  ADD COLUMN IF NOT EXISTS stats_verified_at TIMESTAMPTZ;

UPDATE matches
SET stats_verified_at = now()
WHERE status = 'completed'
  AND stats_verified_at IS NULL;
