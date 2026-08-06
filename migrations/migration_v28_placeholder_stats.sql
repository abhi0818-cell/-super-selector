-- migration_v28: scraper_placeholder_stats — recovers points for sources'
-- own "I couldn't identify this player" placeholder (e.g. CricAPI's literal
-- "Player Not Found").
--
-- Why a separate table from scraper_unmatched: that table's uniqueness is
-- (tournament_id, raw_name, source) — one queue row per name, because fixing
-- a genuinely-misspelled/missing name once (via an alias) is meant to
-- auto-resolve every future occurrence too. A placeholder string is the
-- opposite: the SAME literal string represents a DIFFERENT real player each
-- time, so every match's occurrence has to be captured and resolved
-- separately, and resolving one must NEVER create an alias that would
-- silently apply to the next one (that's exactly how "Player Not Found" got
-- wrongly and permanently mapped to Abayanga Khaka).
--
-- Flow: poll-cricapi / scrape-scorecard capture the raw box-score numbers
-- (runs/balls/wickets/etc., already-computed raw_points) for a placeholder
-- row instead of dropping them. The admin panel lets you pick the real
-- player for that one match/context, which copies those numbers straight
-- into player_match_stats for them (merged, not overwritten, if they already
-- have stats from a normal appearance) and marks this row resolved — no
-- alias, no effect on any other match.
--
-- Known limitation: if the SAME match has two DIFFERENT unidentified players
-- in the same discipline (e.g. two different uncapped batters both reported
-- as "Player Not Found" in one innings), only the latest one's numbers are
-- kept under the (match_id, source, context) key — this covers the common
-- single-occurrence case, not that rarer collision.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS scraper_placeholder_stats (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id      UUID        NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  match_id           UUID        NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  source             TEXT        NOT NULL
                        CHECK (source IN ('cricketaddictor','business_standard','cricapi')),
  context            TEXT        NOT NULL DEFAULT 'batting'
                        CHECK (context IN ('batting','bowling')),
  raw_name           TEXT        NOT NULL DEFAULT 'player not found',
  raw_stats          JSONB       NOT NULL, -- { batting, bowling, fielding, raw_points }
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at        TIMESTAMPTZ DEFAULT NULL,
  resolved_by        TEXT        DEFAULT NULL
                        CHECK (resolved_by IS NULL OR resolved_by IN ('forced_stat','ignored')),
  credited_player_id TEXT        REFERENCES players(id),
  UNIQUE (match_id, source, context)
);

CREATE INDEX IF NOT EXISTS sps_match_unresolved_idx
  ON scraper_placeholder_stats(match_id)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS sps_tournament_unresolved_idx
  ON scraper_placeholder_stats(tournament_id)
  WHERE resolved_at IS NULL;

-- ── RLS — same shape as scraper_unmatched (migration_v23) ───────────────────
ALTER TABLE scraper_placeholder_stats ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "sps_public_read"  ON scraper_placeholder_stats;
DROP POLICY IF EXISTS "sps_admin_insert" ON scraper_placeholder_stats;
DROP POLICY IF EXISTS "sps_admin_update" ON scraper_placeholder_stats;
DROP POLICY IF EXISTS "sps_admin_delete" ON scraper_placeholder_stats;

CREATE POLICY "sps_public_read"
  ON scraper_placeholder_stats FOR SELECT USING (true);

CREATE POLICY "sps_admin_insert"
  ON scraper_placeholder_stats FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "sps_admin_update"
  ON scraper_placeholder_stats FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "sps_admin_delete"
  ON scraper_placeholder_stats FOR DELETE TO authenticated USING (true);
