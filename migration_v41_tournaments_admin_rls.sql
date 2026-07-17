-- migration_v41: Tighten tournaments RLS to admin-only writes
-- Run in Supabase SQL Editor.
--
-- Background: migration_v18_admin_write_rls.sql added `USING (true)` /
-- `WITH CHECK (true)` insert/update/delete policies on `tournaments` so the
-- web admin panel (running under the authenticated anonKey client, not the
-- service role) could edit tournament config. Its own comment flagged this
-- as "acceptable for a small invite-only app" but not a real admin gate —
-- ANY authenticated user could call the Supabase client directly and edit
-- tournament settings (domestic_label, max_overseas_in_xi, active flag,
-- scoring rules, dates, format, etc), since RLS OR's permissive policies
-- together and `USING (true)` always wins regardless of any other policy.
--
-- This migration replaces those three policies with is_admin()-gated ones,
-- matching the pattern already used on `matches` (migration_v8_auth.sql)
-- and `notifications_log` (migration_v36_push_notifications.sql). Only
-- abhi0818@gmail.com (per is_admin()'s definition) can insert/update/delete
-- tournament rows after this runs; everyone else keeps read-only SELECT
-- access from migration_v17.
--
-- Scoped to `tournaments` only — this does not touch the other tables
-- migration_v18 loosened (contests, teams, tournament_players,
-- player_match_stats, match_scorecards), which were not part of this
-- request and may need separate review before tightening.
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "tournaments_admin_insert" ON tournaments;
DROP POLICY IF EXISTS "tournaments_admin_update" ON tournaments;
DROP POLICY IF EXISTS "tournaments_admin_delete" ON tournaments;

CREATE POLICY "tournaments: admin insert"
  ON tournaments FOR INSERT
  TO authenticated
  WITH CHECK (is_admin());

CREATE POLICY "tournaments: admin update"
  ON tournaments FOR UPDATE
  TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

CREATE POLICY "tournaments: admin delete"
  ON tournaments FOR DELETE
  TO authenticated
  USING (is_admin());
