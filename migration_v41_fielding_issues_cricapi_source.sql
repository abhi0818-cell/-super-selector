-- migration_v41: allow scraper_fielding_issues.source = 'cricapi'.
--
-- poll-cricapi's fielding-credit matching previously used a bare .find()
-- against players already seen in this match's own batting/bowling rows —
-- no ambiguity detection at all, unlike scrape-scorecard's resolveFielderName
-- (the "Bryce sisters" fix). It's now been brought up to the same standard:
-- tiered matching against the full 2-team match roster, with genuinely
-- ambiguous/unmatched fielding credit surfaced to the admin instead of
-- silently guessed. This table is where those get queued — widen the CHECK
-- so CricAPI-sourced matches can write here too.

ALTER TABLE scraper_fielding_issues DROP CONSTRAINT IF EXISTS scraper_fielding_issues_source_check;
ALTER TABLE scraper_fielding_issues ADD CONSTRAINT scraper_fielding_issues_source_check
  CHECK (source IN ('cricketaddictor','business_standard','cricapi'));
