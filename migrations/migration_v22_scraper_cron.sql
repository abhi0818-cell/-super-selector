-- migration_v22: pg_cron job to trigger the scrape-scorecard Edge Function
-- Run in Supabase SQL Editor AFTER deploying the Edge Function.
--
-- Prerequisites:
--   1. Enable pg_cron in Supabase dashboard → Database → Extensions → pg_cron
--   2. Enable pg_net  in Supabase dashboard → Database → Extensions → pg_net
--   3. Deploy the Edge Function:
--        supabase functions deploy scrape-scorecard
--
-- Replace the two placeholder values below before running:
--   YOUR_SERVICE_ROLE_KEY : Supabase dashboard → Settings → API → service_role key
-- ─────────────────────────────────────────────────────────────────────────────

-- Remove any previous version of this job
SELECT cron.unschedule('scrape-live-matches') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'scrape-live-matches'
);

-- Schedule: every 15 minutes, call the Edge Function
-- The function itself checks for live matches with scraper_enabled — no wasted calls.
SELECT cron.schedule(
  'scrape-live-matches',
  '*/15 * * * *',
  $$
  SELECT net.http_post(
    url     := 'https://gepltclaeczgtruvekci.supabase.co/functions/v1/scrape-scorecard',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdlcGx0Y2xhZWN6Z3RydXZla2NpIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODUxNzk1NSwiZXhwIjoyMDk0MDkzOTU1fQ.0C77Zg63Pk58raq_5bzzCjFxmkGOpj8R6tbgnMwMISo'
    ),
    body    := '{}'::jsonb
  )
  $$
);

-- Verify the job was created
SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'scrape-live-matches';
