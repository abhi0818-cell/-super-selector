-- migration_v24: add secondary color (color2) to teams
-- Safe: nullable column, no impact on existing rows or ongoing tournaments

ALTER TABLE teams
  ADD COLUMN IF NOT EXISTS color2 TEXT DEFAULT NULL;

COMMENT ON COLUMN teams.color2 IS 'Secondary/accent jersey color (hex). If null, app auto-derives from primary color.';
