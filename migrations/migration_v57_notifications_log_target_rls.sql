-- migration_v57: scope notifications_log reads by target
-- ─────────────────────────────────────────────────────────────────────────────
-- migration_v37 opened notifications_log to every authenticated user with
-- `using (true)` — reasonable at the time, since every send back then was
-- target='all' (per that migration's own comment: "no per-user filtering
-- needed on the log itself"). That's no longer true: send-push-notification
-- now also writes target='admin' rows (check-toss's delay/confirmation
-- alerts — migration_v55/v56), and those were leaking into every regular
-- user's HomeScreen ticker and notification inbox (both read from this same
-- table via app/src/store/notificationsStore.ts, with no target filter of
-- their own — see that file's header comment, also written back when 'all'
-- was the only value that ever existed).
--
-- This tightens the policy so a row is only readable by:
--   - anyone, when target = 'all' (the normal broadcast case), or
--   - the admin, when target = 'admin' (check-toss's alerts, or anything
--     else sent admin-only in the future).
--
-- This alone fixes the leak for every existing app install immediately —
-- no client update needed, since the client's query has no target filter of
-- its own and simply gets fewer rows back once RLS narrows what's visible.
-- ─────────────────────────────────────────────────────────────────────────────

drop policy if exists "notifications_log: authenticated read" on notifications_log;
create policy "notifications_log: authenticated read"
  on notifications_log for select
  to authenticated
  using (target = 'all' or (target = 'admin' and is_admin()));
