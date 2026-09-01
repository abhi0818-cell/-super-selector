-- migration_v64: allow source = 'manual' on scraper_unmatched and
-- scraper_fielding_issues.
--
-- admin.js's manual-scorecard-paste path (saveManualScorecardForMatch) has
-- always tagged its insertFieldingIssues(...) call with source='manual' so a
-- manually pasted scorecard's unresolved fielding credit reaches Review →
-- Fielding Issues instead of only a console.warn. But scraper_fielding_issues
-- .source_check only ever allowed ('cricketaddictor','business_standard',
-- 'cricapi') -- so every one of those inserts has been silently rejected
-- (caught by admin.js's own best-effort try/catch) and never actually queued.
--
-- Wiring the same treatment for unmatched *batter/bowler identities* (not
-- just fielding credit) needs scraper_unmatched.source widened the same way:
-- a manually pasted scorecard's unmatched player names were previously only
-- ever visible live in the Fantasy Scorecard panel (client-side, ephemeral),
-- never in Review's persisted "⚠️ Unmatched Players" queue, because nothing
-- wrote them to scraper_unmatched at all. See db.js's new
-- insertUnmatchedPlayers() and its call from admin.js's
-- saveManualScorecardForMatch().
--
-- Applied directly to the live DB on 2026-09-01; this file documents it for
-- the repo/schema history.

ALTER TABLE scraper_unmatched DROP CONSTRAINT IF EXISTS scraper_unmatched_source_check;
ALTER TABLE scraper_unmatched
  ADD CONSTRAINT scraper_unmatched_source_check
  CHECK (source IN ('cricketaddictor','business_standard','cricapi','manual'));

ALTER TABLE scraper_fielding_issues DROP CONSTRAINT IF EXISTS scraper_fielding_issues_source_check;
ALTER TABLE scraper_fielding_issues
  ADD CONSTRAINT scraper_fielding_issues_source_check
  CHECK (source IN ('cricketaddictor','business_standard','cricapi','manual'));
