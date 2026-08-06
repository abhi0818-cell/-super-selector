-- ─────────────────────────────────────────────────────────────────────────────
-- Fix: user_booster_activations SELECT policy blocks the SL leaderboard's
-- new Booster column (and the per-match booster icon on the expanded row).
--
-- migration_v12_boosters.sql put user_booster_activations behind an
-- owner-only SELECT policy ("booster_activations: read own", USING
-- us.user_id = auth.uid()), on the same assumption migration_v17 made for
-- user_transfers: that this data is personal. It isn't — the leaderboard
-- needs to show how many boosters every squad has used (and which booster,
-- if any, was active for a given match), the same way it already needs
-- every squad's transfer count (fixed in migration_v30) and score totals.
--
-- Symptom this would cause, identical in shape to the v30 bug: a signed-in
-- user's own client only ever gets back *their own* squad's activation rows
-- from Supabase (RLS silently drops every other squad's rows) — so the new
-- Booster column would show 0/N for every squad except whichever one the
-- viewer happens to own, and the per-match booster icon would never show
-- for other squads' matches even when a booster was genuinely used.
--
-- (This also explains the stale comment already in db.js's
-- getAllBoostersForMatch(), which says it "Requires the
-- booster_activations_read_all policy on user_booster_activations" — that
-- policy was apparently planned but never actually created. This migration
-- adds it under that exact name.)
--
-- Fix: move user_booster_activations' SELECT policy to authenticated-read,
-- matching user_squads/user_match_xi/user_transfers. INSERT/DELETE stay
-- owner-only — nobody can activate or cancel a booster for someone else's
-- squad, this only changes who can *read* the activation log.
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "booster_activations: read own" ON user_booster_activations;
-- Idempotent: a policy with this name may already exist (e.g. from a prior
-- partial run of this script) — drop and recreate so the definition below is
-- guaranteed to be the one actually in effect.
DROP POLICY IF EXISTS "booster_activations_read_all" ON user_booster_activations;

CREATE POLICY "booster_activations_read_all"
  ON user_booster_activations FOR SELECT
  USING (auth.role() = 'authenticated');

-- INSERT/DELETE policies from migration_v12_boosters.sql are unchanged and
-- still in effect (own-squad-only) — not re-created here since they don't
-- need to change. For reference, they are:
--
-- CREATE POLICY "booster_activations: insert own"
--   ON user_booster_activations FOR INSERT
--   WITH CHECK (
--     auth.role() = 'authenticated'
--     AND EXISTS (
--       SELECT 1 FROM user_squads us
--       WHERE us.id      = user_booster_activations.squad_id
--         AND us.user_id = auth.uid()
--     )
--   );
--
-- CREATE POLICY "booster_activations: delete own"
--   ON user_booster_activations FOR DELETE
--   USING (
--     auth.role() = 'authenticated'
--     AND EXISTS (
--       SELECT 1 FROM user_squads us
--       WHERE us.id      = user_booster_activations.squad_id
--         AND us.user_id = auth.uid()
--     )
--   );

-- Verify: should now list "booster_activations_read_all" (SELECT) plus the
-- two pre-existing own-squad insert/delete policies.
SELECT policyname, cmd FROM pg_policies
WHERE tablename = 'user_booster_activations'
ORDER BY cmd;
