-- migration_v26: pg_cron job to trigger the lock-matches Edge Function
-- Run in Supabase SQL Editor AFTER deploying the Edge Function.
--
-- Prerequisites:
--   1. pg_cron and pg_net already enabled (used by migration_v22 / v25)
--   2. Deploy the Edge Function (it exists in the repo but has not been
--      deployed/scheduled yet):
--        supabase functions deploy lock-matches --no-verify-jwt
--
-- lock-matches locks every season-long squad's draft XI for any match whose
-- lock gate (lock_time, falling back to start_time) has passed, snapshots
-- into user_match_xi, computes transfers, mirrors to user_teams/
-- user_team_players, and flips the match to 'live'. It is idempotent —
-- squads already locked for a match are skipped — so running it every
-- minute is cheap and safe.
--
-- Replace the placeholder service_role key below with the same one used in
-- migration_v22_scraper_cron.sql / migration_v25_cricapi_cron.sql.
-- ─────────────────────────────────────────────────────────────────────────────

-- Remove any previous version of this job
SELECT cron.unschedule('lock-matches') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'lock-matches'
);

-- Schedule: every 1 minute — lock precision matters here, unlike the
-- 15-minute scrape interval. The function is a cheap no-op when no matches
-- are due to lock.
SELECT cron.schedule(
  'lock-matches',
  '* * * * *',
  $$
  SELECT net.http_post(
    url     := 'https://gepltclaeczgtruvekci.supabase.co/functions/v1/lock-matches',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdlcGx0Y2xhZWN6Z3RydXZla2NpIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODUxNzk1NSwiZXhwIjoyMDk0MDkzOTU1fQ.0C77Zg63Pk58raq_5bzzCjFxmkGOpj8R6tbgnMwMISo'
    ),
    body    := '{}'::jsonb
  )
  $$
);

-- Verify the job was created
SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'lock-matches';
