-- migration_v23: scraper_unmatched — persists player names the scraper couldn't resolve
-- Run in Supabase SQL Editor.
--
-- When the scraper encounters a name it can't match to a player_id it writes a row here.
-- Admin sees these in the tournament card (⚠️ Unmatched Players) and can:
--   a) Map to an existing player (creates a player_name_alias for future auto-resolution)
--   b) Add as a new player to the pool (inserts into players + tournament_players + alias)
--   c) Ignore (marks resolved so it stops appearing)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS scraper_unmatched (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id UUID        NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  match_id      UUID        NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  raw_name      TEXT        NOT NULL,
  source        TEXT        NOT NULL
                  CHECK (source IN ('cricketaddictor','business_standard')),
  context       TEXT        NOT NULL DEFAULT 'batting'
                  CHECK (context IN ('batting','bowling')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at   TIMESTAMPTZ DEFAULT NULL,
  resolved_by   TEXT        DEFAULT NULL
                  CHECK (resolved_by IS NULL OR resolved_by IN ('alias','new_player','ignored')),
  UNIQUE (tournament_id, raw_name, source)
);

-- Index for fast unresolved lookups per tournament
CREATE INDEX IF NOT EXISTS su_tournament_unresolved_idx
  ON scraper_unmatched(tournament_id)
  WHERE resolved_at IS NULL;

-- ── RLS ───────────────────────────────────────────────────────────────────────
ALTER TABLE scraper_unmatched ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "su_public_read"  ON scraper_unmatched;
DROP POLICY IF EXISTS "su_admin_insert" ON scraper_unmatched;
DROP POLICY IF EXISTS "su_admin_update" ON scraper_unmatched;
DROP POLICY IF EXISTS "su_admin_delete" ON scraper_unmatched;

CREATE POLICY "su_public_read"
  ON scraper_unmatched FOR SELECT USING (true);

CREATE POLICY "su_admin_insert"
  ON scraper_unmatched FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "su_admin_update"
  ON scraper_unmatched FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "su_admin_delete"
  ON scraper_unmatched FOR DELETE TO authenticated USING (true);
