-- ─────────────────────────────────────────────────────────────────────────────
-- Fix: user_transfers SELECT policy blocks the SL leaderboard's Xfers column.
--
-- migration_v17_rls.sql put user_transfers in "Group B — owner-only private"
-- (USING us.user_id = auth.uid()), on the assumption transfer history is
-- personal. But getLeaderboardSL() (db.js) reads every squad's
-- user_transfers rows to show each squad's season transfer count/penalty on
-- the public SL leaderboard — exactly the same need user_squads and
-- user_match_xi already have, which migration_v17 correctly put in
-- "Group C — authenticated read, own write".
--
-- Symptom this caused: a signed-in user's own client only ever got back
-- *their own* squad's transfer rows from Supabase (RLS silently dropped
-- every other squad's rows from the response) — so the leaderboard showed
-- 0 Xfers for every squad except whichever one the viewer happened to own.
-- An admin/service-role session bypasses RLS entirely, which is why it
-- looked correct from that account.
--
-- Fix: move user_transfers' SELECT policy to Group C (authenticated read),
-- matching user_squads/user_match_xi. INSERT/DELETE stay owner-only —
-- nobody can log a transfer for someone else's squad, this only changes
-- who can *read* the log.
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "user_transfers_own_select" ON user_transfers;

CREATE POLICY "user_transfers_authenticated_read"
  ON user_transfers FOR SELECT
  USING (auth.role() = 'authenticated');

-- INSERT/DELETE policies from migration_v17_rls.sql are unchanged and still
-- in effect (own-squad-only) — not re-created here since they don't need to
-- change. For reference, they are:
--
-- CREATE POLICY "user_transfers_own_insert"
--   ON user_transfers FOR INSERT
--   WITH CHECK (
--     auth.role() = 'authenticated'
--     AND EXISTS (
--       SELECT 1 FROM user_squads us
--       WHERE us.id      = user_transfers.squad_id
--         AND us.user_id = auth.uid()
--     )
--   );
--
-- CREATE POLICY "user_transfers_own_delete"
--   ON user_transfers FOR DELETE
--   USING (
--     auth.role() = 'authenticated'
--     AND EXISTS (
--       SELECT 1 FROM user_squads us
--       WHERE us.id      = user_transfers.squad_id
--         AND us.user_id = auth.uid()
--     )
--   );

-- Verify: should now list "user_transfers_authenticated_read" (SELECT) plus
-- the two pre-existing own-squad insert/delete policies.
-- (pg_policies is the friendly view — pg_policy's raw column is polcmd, a
-- single-char code like 'r'/'a'/'w'/'d', not the text "SELECT" used below.)
SELECT policyname, cmd FROM pg_policies
WHERE tablename = 'user_transfers'
ORDER BY cmd;
