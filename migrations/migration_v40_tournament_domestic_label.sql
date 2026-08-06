-- migration_v40: per-tournament label for "non-overseas" players
-- Run in Supabase SQL Editor.
--
-- The app only ever tracked a single is_overseas boolean per player — what
-- "non-overseas" actually MEANS varies by competition (IPL → Indian,
-- MLC → US, SA20 → South African, etc.). Rather than trying to tag every
-- player with a real country (which breaks down the moment a pool is
-- reused across tournaments), this adds a per-tournament display label so
-- admins can say what the non-overseas bucket is called for that specific
-- competition. The underlying data model — is_overseas boolean, overseas
-- cap enforcement — is untouched.
--
--   domestic_label = null   → app falls back to a generic "Domestic" label
--   domestic_label = 'US'   → MLC-style: pool filter chip reads "🏠 US"
--   domestic_label = 'Indian' → IPL-style
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE tournaments
  ADD COLUMN IF NOT EXISTS domestic_label TEXT DEFAULT NULL;
