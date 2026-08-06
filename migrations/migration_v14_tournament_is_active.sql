-- ─────────────────────────────────────────────────────────────────────────────
-- v14 — Multi-tournament support
-- Adds is_active flag to tournaments so admin controls what users can pick.
-- Multiple tournaments can be active simultaneously (overlapping date ranges
-- are allowed — users choose which one to play).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE tournaments
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT false;

-- Mark any tournament whose window contains today as active by default
-- (safe to run even if column already existed)
UPDATE tournaments
  SET is_active = true
  WHERE
    (start_date IS NULL OR start_date <= current_date)
    AND (end_date   IS NULL OR end_date   >= current_date);

-- Index so the mobile app's "load active tournaments" query is fast
CREATE INDEX IF NOT EXISTS tournaments_is_active_idx
  ON tournaments (is_active)
  WHERE is_active = true;
