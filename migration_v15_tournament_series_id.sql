-- ─────────────────────────────────────────────────────────────────────────────
-- v15 — Store CricAPI series ID on tournaments
-- Eliminates manual re-entry: once saved, the Schedule tab auto-fills it
-- whenever the tournament is selected.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE tournaments
  ADD COLUMN IF NOT EXISTS cricapi_series_id text;
