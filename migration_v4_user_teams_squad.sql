-- migration_v4_user_teams_squad.sql
-- Adds squad_id to user_teams so Season Long XIs use the same
-- user_teams + user_team_players tables as daily XIs (enabling the
-- shared computeAndSaveXIScoresForMatch scoring pipeline).
--
-- Safe to run on existing databases: column is nullable so all existing
-- daily-mode rows (which have no squad_id) are unaffected.

ALTER TABLE user_teams
  ADD COLUMN IF NOT EXISTS squad_id uuid REFERENCES user_squads(id) ON DELETE CASCADE;

-- Index for fast lookup by squad + match (used by upsertSlTeam)
CREATE INDEX IF NOT EXISTS idx_user_teams_squad_match
  ON user_teams (squad_id, match_id)
  WHERE squad_id IS NOT NULL;
