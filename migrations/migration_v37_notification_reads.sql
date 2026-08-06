-- v37: in-app notification inbox
--
-- notifications_log (added in v36) already records every push the admin
-- sends, but its RLS only granted the admin access. To show a bell icon +
-- history inside the app, every authenticated user needs to read that same
-- log (all notifications are currently broadcast to 'all', so there's no
-- per-user filtering needed on the log itself).
--
-- notification_reads tracks, per user, which notifications they've already
-- opened — drives the unread badge. A row's absence means unread.

-- ── notifications_log: allow authenticated users to read ────────────────────
drop policy if exists "notifications_log: authenticated read" on notifications_log;
create policy "notifications_log: authenticated read"
  on notifications_log for select
  to authenticated
  using (true);


-- ── notification_reads ───────────────────────────────────────────────────────
create table if not exists notification_reads (
  user_id         uuid not null references auth.users(id) on delete cascade,
  notification_id uuid not null references notifications_log(id) on delete cascade,
  read_at         timestamptz not null default now(),
  primary key (user_id, notification_id)
);

alter table notification_reads enable row level security;

drop policy if exists "notification_reads: owner full access" on notification_reads;
create policy "notification_reads: owner full access"
  on notification_reads for all
  using  (user_id = auth.uid())
  with check (user_id = auth.uid());
