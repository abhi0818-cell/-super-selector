-- migration_v12: boosters
-- Run in Supabase SQL editor.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Mark overseas players on the players table
--    is_overseas = true  → counts against each team's overseas quota (IPL: 4/XI)
--    is_overseas = false → Indian / domestic player
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE players
  ADD COLUMN IF NOT EXISTS is_overseas BOOLEAN NOT NULL DEFAULT false;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Booster configuration on contests
--    JSONB map of  booster_key → uses_per_squad_member
--    Supported keys: triple_captain | wildcard | free_hit |
--                    os_double | indian_double | team_double
--    null / absent key = booster not offered in this contest
--    Example: {"triple_captain":1,"wildcard":1,"free_hit":1,"os_double":1,"indian_double":1,"team_double":1}
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE contests
  ADD COLUMN IF NOT EXISTS available_boosters JSONB;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Booster activations — one row per squad × match × booster type
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_booster_activations (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  squad_id     UUID        NOT NULL REFERENCES user_squads(id) ON DELETE CASCADE,
  match_id     UUID        NOT NULL REFERENCES matches(id)     ON DELETE CASCADE,
  booster      TEXT        NOT NULL
                           CHECK (booster IN (
                             'triple_captain',
                             'wildcard',
                             'free_hit',
                             'os_double',
                             'indian_double',
                             'team_double'
                           )),
  activated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- For free_hit: snapshot of the XI before activation so it can be restored
  -- after the match.  Other boosters leave this null.
  snapshot     JSONB,

  -- A squad can only activate each booster type once per match
  UNIQUE (squad_id, match_id, booster)
);

-- Index for fast per-squad lookups (booster usage count, active match check)
CREATE INDEX IF NOT EXISTS uba_squad_idx ON user_booster_activations (squad_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. RLS
--    Assumes RLS is already enabled on user_squads (migration_v9).
--    Users can read/write their own activations only.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE user_booster_activations ENABLE ROW LEVEL SECURITY;

-- Read own activations
CREATE POLICY "booster_activations: read own"
  ON user_booster_activations FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND EXISTS (
      SELECT 1 FROM user_squads us
      WHERE us.id      = user_booster_activations.squad_id
        AND us.user_id = auth.uid()
    )
  );

-- Insert own activations
CREATE POLICY "booster_activations: insert own"
  ON user_booster_activations FOR INSERT
  WITH CHECK (
    auth.role() = 'authenticated'
    AND EXISTS (
      SELECT 1 FROM user_squads us
      WHERE us.id      = user_booster_activations.squad_id
        AND us.user_id = auth.uid()
    )
  );

-- Delete own activations (allow cancelling before match starts)
CREATE POLICY "booster_activations: delete own"
  ON user_booster_activations FOR DELETE
  USING (
    auth.role() = 'authenticated'
    AND EXISTS (
      SELECT 1 FROM user_squads us
      WHERE us.id      = user_booster_activations.squad_id
        AND us.user_id = auth.uid()
    )
  );
