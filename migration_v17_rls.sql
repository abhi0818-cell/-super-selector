-- ─────────────────────────────────────────────────────────────────────────────
-- v17 — Row Level Security for all unprotected tables
--
-- Run this once in Supabase SQL Editor.
-- All admin writes go through the service role key (bypasses RLS entirely),
-- so no admin-write policies are needed — just block anonymous/user writes
-- on tables that users should never write to directly.
--
-- Policy groups:
--   A. Public read, no direct writes  → tournaments, contests, teams,
--                                        tournament_players, scoring_rules,
--                                        player_match_stats, match_scorecards
--   B. Owner-only private             → squad_draft_xi, user_transfers
--   C. Authenticated read, own write  → user_squads, user_match_xi,
--                                        user_match_xi_scores,
--                                        user_team_players,
--                                        user_team_match_scores
-- Note: user_team_history is a VIEW — RLS not applicable (underlying
--       tables user_teams already enforces access control).
-- ─────────────────────────────────────────────────────────────────────────────


-- ══════════════════════════════════════════════════════════════════════════════
-- GROUP A — Public read · no direct writes (admin uses service role)
-- ══════════════════════════════════════════════════════════════════════════════

-- ── tournaments ───────────────────────────────────────────────────────────────
ALTER TABLE tournaments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tournaments_public_read"    ON tournaments;

CREATE POLICY "tournaments_public_read"
  ON tournaments FOR SELECT USING (true);

-- ── contests ──────────────────────────────────────────────────────────────────
ALTER TABLE contests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "contests_public_read"       ON contests;

CREATE POLICY "contests_public_read"
  ON contests FOR SELECT USING (true);

-- ── teams ─────────────────────────────────────────────────────────────────────
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "teams_public_read"          ON teams;

CREATE POLICY "teams_public_read"
  ON teams FOR SELECT USING (true);

-- ── tournament_players ────────────────────────────────────────────────────────
ALTER TABLE tournament_players ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tournament_players_public_read" ON tournament_players;

CREATE POLICY "tournament_players_public_read"
  ON tournament_players FOR SELECT USING (true);

-- ── scoring_rules ─────────────────────────────────────────────────────────────
ALTER TABLE scoring_rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "scoring_rules_public_read"  ON scoring_rules;

CREATE POLICY "scoring_rules_public_read"
  ON scoring_rules FOR SELECT USING (true);

-- ── player_match_stats ────────────────────────────────────────────────────────
ALTER TABLE player_match_stats ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "player_match_stats_public_read" ON player_match_stats;

CREATE POLICY "player_match_stats_public_read"
  ON player_match_stats FOR SELECT USING (true);

-- ── match_scorecards ──────────────────────────────────────────────────────────
ALTER TABLE match_scorecards ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "match_scorecards_public_read" ON match_scorecards;

CREATE POLICY "match_scorecards_public_read"
  ON match_scorecards FOR SELECT USING (true);


-- ══════════════════════════════════════════════════════════════════════════════
-- GROUP B — Owner-only private tables
-- ══════════════════════════════════════════════════════════════════════════════

-- ── squad_draft_xi ────────────────────────────────────────────────────────────
-- Your draft must never be visible to other users — not even after lock.
-- Ownership is resolved via user_squads.user_id.

ALTER TABLE squad_draft_xi ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "squad_draft_xi_own_select" ON squad_draft_xi;
DROP POLICY IF EXISTS "squad_draft_xi_own_insert" ON squad_draft_xi;
DROP POLICY IF EXISTS "squad_draft_xi_own_update" ON squad_draft_xi;
DROP POLICY IF EXISTS "squad_draft_xi_own_delete" ON squad_draft_xi;

CREATE POLICY "squad_draft_xi_own_select"
  ON squad_draft_xi FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND EXISTS (
      SELECT 1 FROM user_squads us
      WHERE us.id      = squad_draft_xi.squad_id
        AND us.user_id = auth.uid()
    )
  );

CREATE POLICY "squad_draft_xi_own_insert"
  ON squad_draft_xi FOR INSERT
  WITH CHECK (
    auth.role() = 'authenticated'
    AND EXISTS (
      SELECT 1 FROM user_squads us
      WHERE us.id      = squad_draft_xi.squad_id
        AND us.user_id = auth.uid()
    )
  );

CREATE POLICY "squad_draft_xi_own_update"
  ON squad_draft_xi FOR UPDATE
  USING (
    auth.role() = 'authenticated'
    AND EXISTS (
      SELECT 1 FROM user_squads us
      WHERE us.id      = squad_draft_xi.squad_id
        AND us.user_id = auth.uid()
    )
  );

CREATE POLICY "squad_draft_xi_own_delete"
  ON squad_draft_xi FOR DELETE
  USING (
    auth.role() = 'authenticated'
    AND EXISTS (
      SELECT 1 FROM user_squads us
      WHERE us.id      = squad_draft_xi.squad_id
        AND us.user_id = auth.uid()
    )
  );

-- ── user_transfers ────────────────────────────────────────────────────────────
-- Transfer history is private — users can only see their own.

ALTER TABLE user_transfers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_transfers_own_select" ON user_transfers;
DROP POLICY IF EXISTS "user_transfers_own_insert" ON user_transfers;
DROP POLICY IF EXISTS "user_transfers_own_delete" ON user_transfers;

CREATE POLICY "user_transfers_own_select"
  ON user_transfers FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND EXISTS (
      SELECT 1 FROM user_squads us
      WHERE us.id      = user_transfers.squad_id
        AND us.user_id = auth.uid()
    )
  );

CREATE POLICY "user_transfers_own_insert"
  ON user_transfers FOR INSERT
  WITH CHECK (
    auth.role() = 'authenticated'
    AND EXISTS (
      SELECT 1 FROM user_squads us
      WHERE us.id      = user_transfers.squad_id
        AND us.user_id = auth.uid()
    )
  );

CREATE POLICY "user_transfers_own_delete"
  ON user_transfers FOR DELETE
  USING (
    auth.role() = 'authenticated'
    AND EXISTS (
      SELECT 1 FROM user_squads us
      WHERE us.id      = user_transfers.squad_id
        AND us.user_id = auth.uid()
    )
  );


-- ══════════════════════════════════════════════════════════════════════════════
-- GROUP C — Authenticated read · own write
-- Leaderboards require reading other users' squad names and scores,
-- so authenticated users can read all rows in this group.
-- Writes are restricted to the owning user (or service role for scoring data).
-- ══════════════════════════════════════════════════════════════════════════════

-- ── user_squads ───────────────────────────────────────────────────────────────
-- Any signed-in user can read all squads (needed for leaderboard rankings).
-- Users can only create/update/delete their own squads.

ALTER TABLE user_squads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_squads_authenticated_read" ON user_squads;
DROP POLICY IF EXISTS "user_squads_own_insert"         ON user_squads;
DROP POLICY IF EXISTS "user_squads_own_update"         ON user_squads;
DROP POLICY IF EXISTS "user_squads_own_delete"         ON user_squads;

CREATE POLICY "user_squads_authenticated_read"
  ON user_squads FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "user_squads_own_insert"
  ON user_squads FOR INSERT
  WITH CHECK (
    auth.role() = 'authenticated'
    AND user_id = auth.uid()
  );

CREATE POLICY "user_squads_own_update"
  ON user_squads FOR UPDATE
  USING (
    auth.role() = 'authenticated'
    AND user_id = auth.uid()
  );

CREATE POLICY "user_squads_own_delete"
  ON user_squads FOR DELETE
  USING (
    auth.role() = 'authenticated'
    AND user_id = auth.uid()
  );

-- ── user_match_xi ─────────────────────────────────────────────────────────────
-- Locked XIs are readable by any signed-in user (post-lock team visibility
-- powers the leaderboard "view team" detail).
-- Pre-lock drafts stay private in squad_draft_xi — this table only ever
-- gets rows written at lock time (by the client auto-lock or Edge Function).
-- Direct user inserts/updates go through the service role or own squad check.

ALTER TABLE user_match_xi ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_match_xi_authenticated_read" ON user_match_xi;
DROP POLICY IF EXISTS "user_match_xi_own_insert"         ON user_match_xi;
DROP POLICY IF EXISTS "user_match_xi_own_delete"         ON user_match_xi;

CREATE POLICY "user_match_xi_authenticated_read"
  ON user_match_xi FOR SELECT
  USING (auth.role() = 'authenticated');

-- Inserts/deletes: own squad only (client-side auto-lock path).
-- The Edge Function lock-matches uses service role and bypasses this.
CREATE POLICY "user_match_xi_own_insert"
  ON user_match_xi FOR INSERT
  WITH CHECK (
    auth.role() = 'authenticated'
    AND EXISTS (
      SELECT 1 FROM user_squads us
      WHERE us.id      = user_match_xi.squad_id
        AND us.user_id = auth.uid()
    )
  );

CREATE POLICY "user_match_xi_own_delete"
  ON user_match_xi FOR DELETE
  USING (
    auth.role() = 'authenticated'
    AND EXISTS (
      SELECT 1 FROM user_squads us
      WHERE us.id      = user_match_xi.squad_id
        AND us.user_id = auth.uid()
    )
  );

-- ── user_match_xi_scores ──────────────────────────────────────────────────────
-- Scores are public within the app — needed for leaderboard totals.
-- Writes are done exclusively by the scoring pipeline (service role).

ALTER TABLE user_match_xi_scores ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_match_xi_scores_authenticated_read" ON user_match_xi_scores;

CREATE POLICY "user_match_xi_scores_authenticated_read"
  ON user_match_xi_scores FOR SELECT
  USING (auth.role() = 'authenticated');

-- ── user_team_players ─────────────────────────────────────────────────────────
-- Follows user_teams (already has authenticated read policy).
-- Ownership resolved via user_teams.user_id.

ALTER TABLE user_team_players ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_team_players_authenticated_read" ON user_team_players;
DROP POLICY IF EXISTS "user_team_players_own_insert"         ON user_team_players;
DROP POLICY IF EXISTS "user_team_players_own_delete"         ON user_team_players;

CREATE POLICY "user_team_players_authenticated_read"
  ON user_team_players FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "user_team_players_own_insert"
  ON user_team_players FOR INSERT
  WITH CHECK (
    auth.role() = 'authenticated'
    AND EXISTS (
      SELECT 1 FROM user_teams ut
      WHERE ut.id      = user_team_players.user_team_id
        AND ut.user_id = auth.uid()
    )
  );

CREATE POLICY "user_team_players_own_delete"
  ON user_team_players FOR DELETE
  USING (
    auth.role() = 'authenticated'
    AND EXISTS (
      SELECT 1 FROM user_teams ut
      WHERE ut.id      = user_team_players.user_team_id
        AND ut.user_id = auth.uid()
    )
  );

-- ── user_team_match_scores ────────────────────────────────────────────────────
-- Aggregate match scores (daily path). Readable for leaderboard.
-- Written only by the scoring pipeline (service role).

ALTER TABLE user_team_match_scores ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_team_match_scores_authenticated_read" ON user_team_match_scores;

CREATE POLICY "user_team_match_scores_authenticated_read"
  ON user_team_match_scores FOR SELECT
  USING (auth.role() = 'authenticated');

-- ── user_team_history ─────────────────────────────────────────────────────────
-- This is a VIEW, not a table — RLS is not applicable.
-- Access is controlled by the underlying tables (user_teams already has RLS).
