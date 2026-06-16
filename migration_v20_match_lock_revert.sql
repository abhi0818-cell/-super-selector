-- migration_v20: admin delete policy on user_match_xi for match lock revert
-- Run in Supabase SQL Editor.
--
-- Background:
--   When a match is delayed AFTER its scheduled lock time, user_match_xi rows
--   have already been written (lock fired). Admin needs to delete those rows so
--   users can re-pick their XI before the rescheduled lock time.
--
--   The existing "user_match_xi_own_delete" policy (v17) only lets a user delete
--   rows belonging to their own squad. An admin deleting another user's locked XI
--   requires a separate permissive policy.
--
--   Security note: consistent with migration_v18 — any authenticated user is
--   treated as admin. Replace `USING (true)` with an is_admin check if you later
--   add a public sign-up flow.
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "user_match_xi_admin_delete" ON user_match_xi;

CREATE POLICY "user_match_xi_admin_delete"
  ON user_match_xi FOR DELETE
  TO authenticated
  USING (true);

-- Also allow admin inserts (needed if admin ever needs to manually seed a locked XI)
DROP POLICY IF EXISTS "user_match_xi_admin_insert" ON user_match_xi;

CREATE POLICY "user_match_xi_admin_insert"
  ON user_match_xi FOR INSERT
  TO authenticated
  WITH CHECK (true);
