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
-- Replace the placeholder service_role key below with the current key from
-- Supabase dashboard → Settings → API → "Secret keys" (format sb_secret_...)
-- when you run this — do NOT commit the real value to git.
--
-- NOTE (2026-08-18): this job's Authorization key had gone stale after the
-- project rotated from the old legacy JWT-format service_role key to the
-- current sb_secret_... format, silently 401'ing this job on every run. If
-- you rotate the key again, update it directly via cron.alter_job (or
-- re-run this file's unschedule/schedule pair with the new value) — editing
-- this file alone doesn't touch an already-scheduled job.
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
      'Authorization', 'Bearer YOUR_SERVICE_ROLE_KEY'
    ),
    body    := '{}'::jsonb
  )
  $$
);

-- Verify the job was created
SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'lock-matches';
