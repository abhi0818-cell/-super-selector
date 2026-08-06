-- migration_v19: per-tournament overseas player cap in XI
-- Run in Supabase SQL Editor.
--
-- Adds max_overseas_in_xi to tournaments so each tournament can enforce
-- its own overseas quota:
--   IPL          → 4
--   MLC          → 6
--   Women's WC   → 0  (no overseas concept)
--   ODI/Test     → 11 (effectively uncapped)
--   null         → app falls back to format default (T20: 4, ODI/TEST: 11)
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE tournaments
  ADD COLUMN IF NOT EXISTS max_overseas_in_xi INTEGER DEFAULT NULL;

-- Optional: seed sensible defaults for existing tournaments based on format
-- (comment out if you prefer to set them manually in the admin UI)
-- UPDATE tournaments SET max_overseas_in_xi = 4  WHERE format = 'T20'  AND max_overseas_in_xi IS NULL;
-- UPDATE tournaments SET max_overseas_in_xi = 11 WHERE format = 'ODI'  AND max_overseas_in_xi IS NULL;
-- UPDATE tournaments SET max_overseas_in_xi = 11 WHERE format = 'TEST' AND max_overseas_in_xi IS NULL;
