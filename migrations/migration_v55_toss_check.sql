-- migration_v55: toss-check tracking columns + auto-push settings
-- ─────────────────────────────────────────────────────────────────────────────
-- Supports the new check-toss Edge Function (runs every minute from ~20 min
-- before a match's start_time until it locks). That function tries to confirm
-- the toss from CricAPI and CricketAddictor; if neither has a toss recorded
-- by 10 minutes before start_time, it's treated as a delay signal — the
-- admin gets a push notification, and (only once explicitly enabled via
-- app_settings below) it can auto-push lock_time forward. When a toss IS
-- confirmed, the admin also gets a push ("confirmed, no action needed") —
-- not just a silent DB write.
--
-- toss_status:
--   'pending'        — still waiting, nothing wrong yet (normal pre-toss state)
--   'confirmed'      — toss result captured from at least one source
--   'delay_flagged'  — no toss from either source within 10 min of start_time
--
-- toss_checked_at / toss_delay_notified_at are separate: the function updates
-- toss_checked_at on every pass (so you can see it's alive), but only stamps
-- toss_delay_notified_at when it actually sends a push — used as a cooldown so
-- a still-unresolved delay doesn't re-notify every single minute.
-- ─────────────────────────────────────────────────────────────────────────────

alter table matches
  add column if not exists toss_status text not null default 'pending',
  add column if not exists toss_winner_name text,
  add column if not exists toss_decision text,
  add column if not exists toss_source text,
  add column if not exists toss_checked_at timestamptz,
  add column if not exists toss_delay_notified_at timestamptz;

do $$
begin
  alter table matches drop constraint if exists matches_toss_status_check;
exception when others then null;
end $$;

alter table matches
  add constraint matches_toss_status_check
  check (toss_status in ('pending', 'confirmed', 'delay_flagged'));

do $$
begin
  alter table matches drop constraint if exists matches_toss_decision_check;
exception when others then null;
end $$;

alter table matches
  add constraint matches_toss_decision_check
  check (toss_decision is null or toss_decision in ('bat', 'bowl'));

do $$
begin
  alter table matches drop constraint if exists matches_toss_source_check;
exception when others then null;
end $$;

alter table matches
  add constraint matches_toss_source_check
  check (toss_source is null or toss_source in ('cricapi', 'cricketaddictor'));

-- check-toss's query window is "matches starting soon, not yet resolved" —
-- this keeps that scan cheap regardless of how many historical matches pile up.
create index if not exists matches_toss_check_idx
  on matches(start_time)
  where toss_status <> 'confirmed';

-- ─────────────────────────────────────────────────────────────────────────────
-- app_settings — small key/value config table, service-role read/write only
-- (no client-side use case yet). First consumer: toss_auto_push, which gates
-- whether check-toss is allowed to actually move lock_time on a delay, or
-- just notify. Starts disabled — flip it on once you trust the signal.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

alter table app_settings enable row level security;

drop policy if exists "app_settings: admin full access" on app_settings;
create policy "app_settings: admin full access"
  on app_settings for all
  using  (is_admin())
  with check (is_admin());

insert into app_settings (key, value)
values (
  'toss_auto_push',
  jsonb_build_object(
    'enabled', false,
    -- How far past start_time to push lock_time when a delay auto-pushes.
    'push_minutes', 30,
    -- Minimum minutes between re-notifying the admin about the SAME
    -- still-unresolved delay (so a stuck match doesn't spam every minute).
    'renotify_minutes', 15
  )
)
on conflict (key) do nothing;
