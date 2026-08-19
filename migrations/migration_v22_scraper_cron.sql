-- migration_v22: pg_cron job to trigger the scrape-scorecard Edge Function
-- Run in Supabase SQL Editor AFTER deploying the Edge Function.
--
-- Prerequisites:
--   1. Enable pg_cron in Supabase dashboard → Database → Extensions → pg_cron
--   2. Enable pg_net  in Supabase dashboard → Database → Extensions → pg_net
--   3. Deploy the Edge Function:
--        supabase functions deploy scrape-scorecard
--
-- Replace the placeholder value below before running:
--   YOUR_SERVICE_ROLE_KEY : Supabase dashboard → Settings → API → the
--   current "Secret keys" value (format sb_secret_...). Do NOT commit the
--   real value to git — this placeholder is intentional. Paste the real key
--   directly into the SQL editor when you run this file, then discard it.
--
-- NOTE (2026-08-18): this job's Authorization key had gone stale after the
-- project rotated from the old legacy JWT-format service_role key to the
-- current sb_secret_... format, silently 401'ing this job on every run. If
-- you rotate the key again, update it directly via cron.alter_job (or
-- re-run this file's unschedule/schedule pair with the new value) — editing
-- this file alone doesn't touch an already-scheduled job.
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
      'Authorization', 'Bearer YOUR_SERVICE_ROLE_KEY'
    ),
    body    := '{}'::jsonb
  )
  $$
);

-- Verify the job was created
SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'scrape-live-matches';
