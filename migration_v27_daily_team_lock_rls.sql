-- migration_v27: server-side lock for DAILY one-off teams
-- Run in Supabase SQL Editor.
--
-- Background:
--   Season-long squads get locked by the lock-matches Edge Function
--   (service role, see migration_v26). DAILY teams (user_teams rows where
--   squad_id IS NULL, paired with user_team_players) have no equivalent
--   today — submission is only gated client-side, by effectiveLockTime()
--   in index.html. isXILocked() is hardcoded to return false, and
--   saveCurrentXI() (the Save button handler that calls db.js
--   saveUserTeam()) never checks lock state at all. The existing RLS
--   policies on user_teams ("user_teams_own_insert"/"_own_update") and
--   user_team_players (v17's "_own_insert"/"_own_delete") only check
--   ownership (auth.uid() = user_id) — no time predicate. So today, any
--   direct API call — not just the web UI — can rewrite a daily team after
--   its match has already started.
--
--   A cron job can't fully close this kind of gap: it would still leave a
--   window (up to the cron interval) where a write slips through between
--   ticks. The fix belongs in RLS itself — a real-time, zero-lag check
--   evaluated on every request, no cron involved.
--
-- What this migration does:
--   1. Adds user_teams.locked_at (nullable) — display/audit only, stamped
--      by lock-matches via service role (bypasses RLS) at the same gate as
--      SL squads, purely so the UI can show a "Locked" badge. It is NOT the
--      security boundary — the RLS policies below are.
--   2. Re-creates user_teams_own_insert / user_teams_own_update to deny the
--      write once the match's lock gate (lock_time, falling back to
--      start_time) has passed.
--   3. Re-creates user_team_players_own_insert / _own_delete (v17) with the
--      same gate, resolved via the parent user_teams row's match_id.
--   4. Adds an admin-unlock policy on user_teams (USING (true), same
--      "any authenticated user is admin" convention as migration_v18/v20)
--      so an admin action can clear locked_at — the daily-team analogue of
--      revertMatchLock.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Audit/display column (not security-relevant — see note above)
ALTER TABLE user_teams
  ADD COLUMN IF NOT EXISTS locked_at timestamptz;

-- 2. user_teams: re-create insert/update with the lock-gate check
DROP POLICY IF EXISTS "user_teams_own_insert" ON user_teams;
DROP POLICY IF EXISTS "user_teams_own_update" ON user_teams;

CREATE POLICY "user_teams_own_insert"
  ON user_teams FOR INSERT
  WITH CHECK (
    auth.uid() = user_id
    AND (
      match_id IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM matches m
        WHERE m.id = user_teams.match_id
          AND COALESCE(m.lock_time, m.start_time) IS NOT NULL
          AND COALESCE(m.lock_time, m.start_time) <= now()
      )
    )
  );

CREATE POLICY "user_teams_own_update"
  ON user_teams FOR UPDATE
  USING (
    auth.uid() = user_id
    AND (
      match_id IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM matches m
        WHERE m.id = user_teams.match_id
          AND COALESCE(m.lock_time, m.start_time) IS NOT NULL
          AND COALESCE(m.lock_time, m.start_time) <= now()
      )
    )
  );

-- 3. user_team_players: re-create insert/delete with the same lock-gate
--    check, resolved through the parent user_teams row.
DROP POLICY IF EXISTS "user_team_players_own_insert" ON user_team_players;
DROP POLICY IF EXISTS "user_team_players_own_delete" ON user_team_players;

CREATE POLICY "user_team_players_own_insert"
  ON user_team_players FOR INSERT
  WITH CHECK (
    auth.role() = 'authenticated'
    AND EXISTS (
      SELECT 1 FROM user_teams ut
      WHERE ut.id      = user_team_players.user_team_id
        AND ut.user_id = auth.uid()
        AND (
          ut.match_id IS NULL
          OR NOT EXISTS (
            SELECT 1 FROM matches m
            WHERE m.id = ut.match_id
              AND COALESCE(m.lock_time, m.start_time) IS NOT NULL
              AND COALESCE(m.lock_time, m.start_time) <= now()
          )
        )
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
        AND (
          ut.match_id IS NULL
          OR NOT EXISTS (
            SELECT 1 FROM matches m
            WHERE m.id = ut.match_id
              AND COALESCE(m.lock_time, m.start_time) IS NOT NULL
              AND COALESCE(m.lock_time, m.start_time) <= now()
          )
        )
    )
  );

-- 4. Admin escape hatch — lets revertDailyTeamLock (db.js) clear locked_at
--    on behalf of a signed-in admin session, same convention as
--    migration_v20's user_match_xi_admin_delete ("any authenticated user is
--    treated as admin"; tighten with an is_admin() check if you later add a
--    public sign-up flow).
--    WITH CHECK is narrowed to "the new value of locked_at must be NULL" so
--    this policy can only be used to clear the unlock flag — not to widen
--    into a general "any authenticated user can edit any team" hole the way
--    a bare USING (true) would (this row's other policies still apply for
--    everything else; Postgres OR's permissive policies together, so this
--    one only ever adds the ability to null out locked_at).
DROP POLICY IF EXISTS "user_teams_admin_unlock" ON user_teams;

CREATE POLICY "user_teams_admin_unlock"
  ON user_teams FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (locked_at IS NULL);
