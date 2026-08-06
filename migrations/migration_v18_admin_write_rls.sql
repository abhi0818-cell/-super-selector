-- migration_v18: Admin write policies for contest configuration
-- Run in Supabase SQL Editor.
--
-- Background: migration_v17 added public SELECT policies on contests/tournaments
-- but no UPDATE/INSERT/DELETE policies, assuming admin writes would use the
-- service role key. Since the web admin panel uses the authenticated anonKey
-- client, we need explicit UPDATE policies for the tables admins edit.
--
-- Security note: these policies allow ANY authenticated user to update these
-- tables. This is acceptable for a small, invite-only app where only the admin
-- knows the admin panel URL. If you later add a public sign-up flow, replace
-- `USING (true)` with a check against an is_admin flag or an admin_emails table.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── contests: allow authenticated users to INSERT / UPDATE / DELETE ───────────
-- (admin creates contests, edits booster config, transfer budgets, phase numbers)

DROP POLICY IF EXISTS "contests_admin_insert" ON contests;
DROP POLICY IF EXISTS "contests_admin_update" ON contests;
DROP POLICY IF EXISTS "contests_admin_delete" ON contests;

CREATE POLICY "contests_admin_insert"
  ON contests FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "contests_admin_update"
  ON contests FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "contests_admin_delete"
  ON contests FOR DELETE
  TO authenticated
  USING (true);

-- ── tournaments: allow authenticated users to UPDATE ─────────────────────────
-- (admin edits scoring rules, dates, format, active flag)

DROP POLICY IF EXISTS "tournaments_admin_insert" ON tournaments;
DROP POLICY IF EXISTS "tournaments_admin_update" ON tournaments;
DROP POLICY IF EXISTS "tournaments_admin_delete" ON tournaments;

CREATE POLICY "tournaments_admin_insert"
  ON tournaments FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "tournaments_admin_update"
  ON tournaments FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "tournaments_admin_delete"
  ON tournaments FOR DELETE
  TO authenticated
  USING (true);

-- ── teams: allow authenticated users to INSERT / UPDATE / DELETE ─────────────
-- (admin manages team roster)

DROP POLICY IF EXISTS "teams_admin_insert" ON teams;
DROP POLICY IF EXISTS "teams_admin_update" ON teams;
DROP POLICY IF EXISTS "teams_admin_delete" ON teams;

CREATE POLICY "teams_admin_insert"
  ON teams FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "teams_admin_update"
  ON teams FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "teams_admin_delete"
  ON teams FOR DELETE
  TO authenticated
  USING (true);

-- ── tournament_players: allow authenticated INSERT / UPDATE / DELETE ──────────
-- (admin links players to a tournament)

DROP POLICY IF EXISTS "tournament_players_admin_insert" ON tournament_players;
DROP POLICY IF EXISTS "tournament_players_admin_update" ON tournament_players;
DROP POLICY IF EXISTS "tournament_players_admin_delete" ON tournament_players;

CREATE POLICY "tournament_players_admin_insert"
  ON tournament_players FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "tournament_players_admin_update"
  ON tournament_players FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "tournament_players_admin_delete"
  ON tournament_players FOR DELETE
  TO authenticated
  USING (true);

-- ── player_match_stats: allow authenticated INSERT / UPDATE / DELETE ──────────
-- (admin enters match scores)

DROP POLICY IF EXISTS "player_match_stats_admin_insert" ON player_match_stats;
DROP POLICY IF EXISTS "player_match_stats_admin_update" ON player_match_stats;
DROP POLICY IF EXISTS "player_match_stats_admin_delete" ON player_match_stats;

CREATE POLICY "player_match_stats_admin_insert"
  ON player_match_stats FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "player_match_stats_admin_update"
  ON player_match_stats FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "player_match_stats_admin_delete"
  ON player_match_stats FOR DELETE
  TO authenticated
  USING (true);

-- ── match_scorecards: allow authenticated INSERT / UPDATE / DELETE ────────────

DROP POLICY IF EXISTS "match_scorecards_admin_insert" ON match_scorecards;
DROP POLICY IF EXISTS "match_scorecards_admin_update" ON match_scorecards;
DROP POLICY IF EXISTS "match_scorecards_admin_delete" ON match_scorecards;

CREATE POLICY "match_scorecards_admin_insert"
  ON match_scorecards FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "match_scorecards_admin_update"
  ON match_scorecards FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "match_scorecards_admin_delete"
  ON match_scorecards FOR DELETE
  TO authenticated
  USING (true);
