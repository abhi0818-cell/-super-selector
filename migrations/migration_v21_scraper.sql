-- migration_v21: scraper infrastructure
-- Run in Supabase SQL Editor.
--
-- Adds:
--   tournaments.scraper_enabled   — toggle per tournament (admin sets once)
--   matches.scorecard_url         — auto-discovered URL cached after first live poll
--   matches.match_type            — 'league'|'qualifier_1'|'qualifier_2'|'eliminator'|'semi_final'|'final'
--                                   used by scraper slug builder; null = league match
--   player_match_stats.source     — 'cricapi'|'scraper'|'manual'
--   player_name_aliases           — maps source display name → player_id per tournament
-- ─────────────────────────────────────────────────────────────────────────────

-- ── tournaments: scraper on/off toggle ───────────────────────────────────────
ALTER TABLE tournaments
  ADD COLUMN IF NOT EXISTS scraper_enabled BOOLEAN NOT NULL DEFAULT false;

-- ── matches: auto-discovered scorecard URL + match type ─────────────────────
ALTER TABLE matches
  ADD COLUMN IF NOT EXISTS scorecard_url TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS match_type    TEXT DEFAULT NULL
    CHECK (match_type IS NULL OR match_type IN (
      'league','qualifier_1','qualifier_2','eliminator','semi_final','final'
    ));

-- ── player_match_stats: data source tracking ─────────────────────────────────
ALTER TABLE player_match_stats
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'cricapi'
    CHECK (source IN ('cricapi','scraper','manual'));

-- ── player_name_aliases ───────────────────────────────────────────────────────
-- Maps the display name that a scraping source uses → your player_id.
-- Populated automatically by the Edge Function when it fuzzy-matches a name,
-- and can be manually added via Supabase dashboard if a player never matches.
--
-- alias:         the name exactly as it appears on the source site (lowercased)
-- source:        'cricketaddictor' | 'business_standard'
-- tournament_id: scoped per tournament so the same alias can differ across events

CREATE TABLE IF NOT EXISTS player_name_aliases (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id     TEXT        NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  tournament_id UUID        NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  alias         TEXT        NOT NULL,
  source        TEXT        NOT NULL DEFAULT 'cricketaddictor'
                  CHECK (source IN ('cricketaddictor','business_standard')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (alias, source, tournament_id)
);

CREATE INDEX IF NOT EXISTS pna_tournament_source_idx
  ON player_name_aliases(tournament_id, source);

-- ── RLS for player_name_aliases ──────────────────────────────────────────────
ALTER TABLE player_name_aliases ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pna_public_read"   ON player_name_aliases;
DROP POLICY IF EXISTS "pna_admin_insert"  ON player_name_aliases;
DROP POLICY IF EXISTS "pna_admin_update"  ON player_name_aliases;
DROP POLICY IF EXISTS "pna_admin_delete"  ON player_name_aliases;

CREATE POLICY "pna_public_read"
  ON player_name_aliases FOR SELECT USING (true);

CREATE POLICY "pna_admin_insert"
  ON player_name_aliases FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "pna_admin_update"
  ON player_name_aliases FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "pna_admin_delete"
  ON player_name_aliases FOR DELETE TO authenticated USING (true);
