-- migration_v56: pg_cron job to trigger the check-toss Edge Function
-- Run in Supabase SQL Editor AFTER deploying the Edge Function.
--
-- Prerequisites:
--   1. pg_cron and pg_net already enabled (used by migration_v22 / v25 / v26)
--   2. Deploy the Edge Function:
--        supabase functions deploy check-toss --no-verify-jwt
--
-- check-toss looks for matches starting within the next 20 minutes (or already
-- past their 10-minutes-before-start delay decision point and still unresolved)
-- and tries to confirm the toss from CricAPI and CricketAddictor. It's
-- idempotent and cheap when there's nothing to check, so running it every
-- minute — same cadence as lock-matches — is safe.
--
-- Replace YOUR_SERVICE_ROLE_KEY below with the current key from Supabase
-- dashboard → Settings → API → "Secret keys" (format sb_secret_...) when you
-- run this — do NOT commit the real value to git.
--
-- NOTE (2026-08-18): this job's Authorization key had gone stale from the
-- moment this file was first written — the legacy JWT-format service_role
-- key it originally shipped with was already stale by the time it ran, since
-- the project had rotated to the current sb_secret_... format shortly
-- before, which silently 401'd this job from the start. If you rotate the
-- key again, update it directly via cron.alter_job (or re-run this file's
-- unschedule/schedule pair with the new value) — editing this file alone
-- doesn't touch an already-scheduled job.
-- ─────────────────────────────────────────────────────────────────────────────

-- Remove any previous version of this job
SELECT cron.unschedule('check-toss') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'check-toss'
);

SELECT cron.schedule(
  'check-toss',
  '* * * * *',
  $$
  SELECT net.http_post(
    url     := 'https://gepltclaeczgtruvekci.supabase.co/functions/v1/check-toss',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer YOUR_SERVICE_ROLE_KEY'
    ),
    body    := '{}'::jsonb
  )
  $$
);

-- Verify the job was created
SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'check-toss';
