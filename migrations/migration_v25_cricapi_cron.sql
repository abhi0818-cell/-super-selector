-- migration_v25: CricAPI server-side polling — CHECK-constraint widening + pg_cron registration
-- Run in Supabase SQL Editor.
--
-- Companion migration to the new poll-cricapi Edge Function
-- (supabase/functions/poll-cricapi/index.ts). That function writes rows
-- tagged source='cricapi' into the same two tables the scraper uses
-- (player_name_aliases, scraper_unmatched), but their CHECK constraints
-- currently only allow ('cricketaddictor','business_standard'). This widens
-- both, then registers a pg_cron job that calls poll-cricapi on a configurable
-- interval — exactly the same pattern as migration_v22_scraper_cron.sql.
--
-- HOW TO CHANGE THE POLLING INTERVAL LATER:
--   Just re-run this file with a different value in the cron.schedule() call
--   below (the unschedule-then-schedule pattern makes it safe to re-run any
--   time). Common values: '*/1 * * * *' (every minute), '*/2 * * * *',
--   '*/5 * * * *'. CricAPI's free tier has a daily call quota, so don't go
--   below ~1 minute unless you have multiple keys configured in CRICAPI_KEYS.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Widen player_name_aliases.source to allow 'cricapi' ──────────────────
ALTER TABLE player_name_aliases DROP CONSTRAINT IF EXISTS player_name_aliases_source_check;
ALTER TABLE player_name_aliases
  ADD CONSTRAINT player_name_aliases_source_check
  CHECK (source IN ('cricketaddictor','business_standard','cricapi'));

-- ── 2. Widen scraper_unmatched.source to allow 'cricapi' ────────────────────
ALTER TABLE scraper_unmatched DROP CONSTRAINT IF EXISTS scraper_unmatched_source_check;
ALTER TABLE scraper_unmatched
  ADD CONSTRAINT scraper_unmatched_source_check
  CHECK (source IN ('cricketaddictor','business_standard','cricapi'));

-- ── 3. Register / replace the pg_cron job for poll-cricapi ──────────────────
-- Same project + service-role key as migration_v22_scraper_cron.sql.

SELECT cron.unschedule('poll-cricapi-matches') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'poll-cricapi-matches'
);

SELECT cron.schedule(
  'poll-cricapi-matches',
  '*/30 * * * *',                       -- ◀── EDIT THIS to change the poll interval
  $$
  SELECT net.http_post(
    url     := 'https://gepltclaeczgtruvekci.supabase.co/functions/v1/poll-cricapi',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdlcGx0Y2xhZWN6Z3RydXZla2NpIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODUxNzk1NSwiZXhwIjoyMDk0MDkzOTU1fQ.0C77Zg63Pk58raq_5bzzCjFxmkGOpj8R6tbgnMwMISo'
    ),
    body    := '{}'::jsonb
  )
  $$
);

-- ── 4. Verify ─────────────────────────────────────────────────────────────
-- SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'poll-cricapi-matches';
