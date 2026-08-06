-- migration_v28: allow admin Recalc to write user_match_xi_scores
-- Run in Supabase SQL Editor.
--
-- Background:
--   migration_v17_rls.sql enabled RLS on user_match_xi_scores with ONLY a
--   SELECT policy, on the assumption that writes would always come from the
--   server-side scoring pipeline (scrape-scorecard / poll-cricapi), which
--   use the service_role key and bypass RLS entirely.
--
--   The admin "Recalc" button (forceRefinalizeMatch → computeAndSaveSL
--   ScoresForMatch → db.js upsertSquadMatchScores) runs CLIENT-SIDE, under
--   the logged-in admin's own authenticated session — not service role.
--   With no INSERT/UPDATE policy present, every upsert from that path has
--   been silently rejected by RLS. The failure is caught per-squad
--   (index.html computeAndSaveSLScoresForMatch, ~line 10481-10486) and only
--   console.warn'd — never surfaced to the admin, so Recalc has appeared to
--   "succeed" while writing zero SL score rows, for every squad, every time
--   it's been used from the browser.
--
-- What this migration does:
--   Adds an admin-write policy on user_match_xi_scores, same "any
--   authenticated user is treated as admin" convention already used by
--   user_match_xi_admin_delete (migration_v20) and user_teams_admin_unlock
--   (migration_v27). Scores are not sensitive/ownable data (every squad's
--   scores are already publicly readable per the existing SELECT policy),
--   so a broad authenticated-write policy here doesn't widen the app's
--   existing security posture — it only fixes a write path that should
--   have existed since v17.
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "user_match_xi_scores_admin_write" ON user_match_xi_scores;

CREATE POLICY "user_match_xi_scores_admin_write"
  ON user_match_xi_scores FOR INSERT
  TO authenticated
  WITH CHECK (true);

DROP POLICY IF EXISTS "user_match_xi_scores_admin_update" ON user_match_xi_scores;

CREATE POLICY "user_match_xi_scores_admin_update"
  ON user_match_xi_scores FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- Verify
SELECT policyname, cmd FROM pg_policies WHERE tablename = 'user_match_xi_scores';
