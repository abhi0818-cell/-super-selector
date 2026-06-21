-- migration_v24: scraper_fielding_issues — persists fielding/wicket credit events
-- the scraper parsed from a dismissal but could NOT auto-credit to exactly one player.
-- Run in Supabase SQL Editor.
--
-- scrape-scorecard now derives fielding credit (catches, stumpings, run-outs) and
-- the bowler LBW/bowled bonus directly from each batter's scraped dismissal text
-- (e.g. "c A Fletcher b A Russell"), the same way poll-cricapi already does for
-- CricAPI-sourced matches. When the named fielder can't be resolved to exactly one
-- player on the squad — either no match at all, or an ambiguous match (e.g. two
-- squad members sharing a surname) — the event is written here instead of being
-- silently dropped. The admin reviews these in the tournament card
-- (⚠️ Fielding Issues) and can:
--   a) Credit it to a specific player (and optionally save an alias for future runs)
--   b) Ignore it (e.g. a substitute fielder not on the roster)
-- This table only covers credit the scraper couldn't resolve automatically — fully
-- manual fielding entry (independent of any parsed dismissal) writes directly to
-- player_match_stats via applyManualFieldingCredit, tagging source='scraper_manual'.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS scraper_fielding_issues (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id UUID        NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  match_id      UUID        NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  raw_name      TEXT        NOT NULL,
  source        TEXT        NOT NULL
                  CHECK (source IN ('cricketaddictor','business_standard')),
  field         TEXT        NOT NULL
                  CHECK (field IN ('catches','stumpings','runOutDirect','runOutIndirect')),
  batter_name   TEXT        NOT NULL,
  dismissal_text TEXT       NOT NULL,
  -- NULL = raw_name matched zero squad players. Non-null array (2+ names) =
  -- ambiguous match — these candidate names are offered as the resolve choices.
  candidates    TEXT[]      DEFAULT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at   TIMESTAMPTZ DEFAULT NULL,
  resolved_by   TEXT        DEFAULT NULL
                  CHECK (resolved_by IS NULL OR resolved_by IN ('alias','credit_only','ignored')),
  UNIQUE (match_id, raw_name, field, batter_name)
);

-- Index for fast unresolved lookups per tournament
CREATE INDEX IF NOT EXISTS sfi_tournament_unresolved_idx
  ON scraper_fielding_issues(tournament_id)
  WHERE resolved_at IS NULL;

-- ── RLS ───────────────────────────────────────────────────────────────────────
ALTER TABLE scraper_fielding_issues ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "sfi_public_read"  ON scraper_fielding_issues;
DROP POLICY IF EXISTS "sfi_admin_insert" ON scraper_fielding_issues;
DROP POLICY IF EXISTS "sfi_admin_update" ON scraper_fielding_issues;
DROP POLICY IF EXISTS "sfi_admin_delete" ON scraper_fielding_issues;

CREATE POLICY "sfi_public_read"
  ON scraper_fielding_issues FOR SELECT USING (true);

CREATE POLICY "sfi_admin_insert"
  ON scraper_fielding_issues FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "sfi_admin_update"
  ON scraper_fielding_issues FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "sfi_admin_delete"
  ON scraper_fielding_issues FOR DELETE TO authenticated USING (true);

-- The service-role key used by the edge functions bypasses RLS entirely, so no
-- explicit service-role policy is needed (matches scraper_unmatched's setup).

-- NOTE: the edge function's INSERT path runs with the service-role key (bypasses
-- RLS), so "sfi_admin_insert" above only matters for any future client-side
-- inserts. The "authenticated" requirement matches scraper_unmatched's convention
-- — this app's admin screens always run signed in.
