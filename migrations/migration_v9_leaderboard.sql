-- ============================================================
-- migration_v9_leaderboard.sql
-- Adds profiles table + cross-user read policies for leaderboard
-- Run once in Supabase SQL Editor
-- ============================================================

-- ── 1. Profiles ──────────────────────────────────────────────
-- Stores display names so the leaderboard can show real names
-- instead of raw UUIDs. Populated by the app on first sign-in.
create table if not exists profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  email        text,
  updated_at   timestamptz not null default now()
);

alter table profiles enable row level security;

-- Anyone signed in can read all profiles (needed for leaderboard names)
drop policy if exists "profiles: authenticated read" on profiles;
create policy "profiles: authenticated read"
  on profiles for select
  using (auth.role() = 'authenticated');

-- Users can only write their own profile
drop policy if exists "profiles: owner write" on profiles;
create policy "profiles: owner write"
  on profiles for all
  using  (id = auth.uid())
  with check (id = auth.uid());


-- ── 2. Cross-user READ policies for leaderboard ──────────────
-- Existing owner policies remain for writes.
-- We add separate SELECT policies so all authenticated users
-- can read everyone's teams and scores for the leaderboard.

-- user_teams: all authenticated users can read (leaderboard needs all teams)
drop policy if exists "user_teams: authenticated read all" on user_teams;
create policy "user_teams: authenticated read all"
  on user_teams for select
  using (auth.role() = 'authenticated');

-- user_team_match_scores: all authenticated users can read
alter table user_team_match_scores enable row level security;

drop policy if exists "utms: authenticated read all" on user_team_match_scores;
create policy "utms: authenticated read all"
  on user_team_match_scores for select
  using (auth.role() = 'authenticated');

drop policy if exists "utms: owner write" on user_team_match_scores;
create policy "utms: owner write"
  on user_team_match_scores for all
  using  (exists (
    select 1 from user_teams ut
    where ut.id = user_team_match_scores.user_team_id
      and (ut.user_id = auth.uid() or is_admin())
  ))
  with check (exists (
    select 1 from user_teams ut
    where ut.id = user_team_match_scores.user_team_id
      and (ut.user_id = auth.uid() or is_admin())
  ));

-- user_squads: all authenticated users can read (SL leaderboard)
drop policy if exists "user_squads: authenticated read all" on user_squads;
create policy "user_squads: authenticated read all"
  on user_squads for select
  using (auth.role() = 'authenticated');
