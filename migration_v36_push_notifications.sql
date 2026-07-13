-- v36: admin-triggered push notifications
--
-- push_tokens      — one row per (user, device). A user can have multiple
--                     devices; a device's Expo push token can churn (reinstall,
--                     token rotation), so it's keyed on the token itself with
--                     an upsert from the client on every app launch/login.
-- notifications_log — audit trail of what the admin sent, to whom, and how
--                     many devices actually received a successful push.
--
-- Sending itself happens server-side in the send-push-notification Edge
-- Function (service role — bypasses RLS), triggered from AdminScreen.tsx via
-- supabase.functions.invoke(), same pattern as lock-matches / poll-cricapi.
-- RLS below only governs direct client access (token registration reads/writes
-- its own row; only the admin can read the log).

create table if not exists push_tokens (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  token      text not null unique,
  platform   text check (platform in ('ios', 'android', 'web')),
  updated_at timestamptz not null default now()
);
create index if not exists push_tokens_user_idx on push_tokens(user_id);

alter table push_tokens enable row level security;

drop policy if exists "push_tokens: owner full access" on push_tokens;
create policy "push_tokens: owner full access"
  on push_tokens for all
  using  (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "push_tokens: admin full access" on push_tokens;
create policy "push_tokens: admin full access"
  on push_tokens for all
  using  (is_admin())
  with check (is_admin());


create table if not exists notifications_log (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  body         text not null,
  target       text not null default 'all',   -- 'all' for now; extensible later (tournament/user segment)
  sent_by      uuid references auth.users(id),
  sent_count   int not null default 0,
  failed_count int not null default 0,
  created_at   timestamptz not null default now()
);

alter table notifications_log enable row level security;

drop policy if exists "notifications_log: admin full access" on notifications_log;
create policy "notifications_log: admin full access"
  on notifications_log for all
  using  (is_admin())
  with check (is_admin());
