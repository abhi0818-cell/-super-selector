-- migration_v11: private leagues within a tournament
-- Run in Supabase SQL editor.

-- 1. Extend contests with private-league fields
ALTER TABLE contests
  ADD COLUMN IF NOT EXISTS is_private     BOOLEAN  NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS invite_code    TEXT,
  ADD COLUMN IF NOT EXISTS scoring_rules  JSONB,
  ADD COLUMN IF NOT EXISTS max_members    INT;

-- 2. Unique index on invite_code (NULLs are excluded automatically)
CREATE UNIQUE INDEX IF NOT EXISTS contests_invite_code_key
  ON contests (invite_code)
  WHERE invite_code IS NOT NULL;

-- 3. RLS: members of a private league can read it; public contests are visible to all.
--    (Assumes RLS is already enabled on contests from migration_v9.)
--
--    Drop the old open-read policy if it exists, then add the scoped one.
DROP POLICY IF EXISTS "contests: authenticated read all" ON contests;

CREATE POLICY "contests: read own or public"
  ON contests FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND (
      is_private = false
      OR EXISTS (
        SELECT 1 FROM user_squads us
        WHERE us.contest_id = contests.id
          AND us.user_id    = auth.uid()
      )
    )
  );

-- Public contests remain fully readable; private ones only visible to members.
-- Admins can still read everything via the existing service-role key.
