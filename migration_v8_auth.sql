-- ============================================================
-- migration_v8_auth.sql
-- Adds per-user data isolation via Supabase Auth + RLS
-- Run once in Supabase SQL Editor (Dashboard → SQL Editor)
-- ============================================================

-- ── 0. Helper: is_admin() ────────────────────────────────────
-- Returns true when the calling JWT belongs to the admin email.
-- Update the email constant if your admin email changes.
create or replace function is_admin()
returns boolean
language sql stable
as $$
  select (auth.email() = 'abhi0818@gmail.com');
$$;


-- ── 1. user_teams ────────────────────────────────────────────
alter table user_teams
  add column if not exists user_id uuid references auth.users(id) on delete cascade;

-- Claim existing rows for the admin (run AFTER your first Google login
-- so auth.uid() resolves; substitute your actual Supabase user UUID below).
-- IMPORTANT: replace <YOUR_SUPABASE_USER_UUID> with the UUID from
--   Auth → Users in the Supabase dashboard after first login.
-- UPDATE user_teams SET user_id = '<YOUR_SUPABASE_USER_UUID>' WHERE user_id IS NULL;

alter table user_teams enable row level security;

drop policy if exists "user_teams: owner full access"  on user_teams;
create policy "user_teams: owner full access"
  on user_teams for all
  using  (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "user_teams: admin full access"  on user_teams;
create policy "user_teams: admin full access"
  on user_teams for all
  using  (is_admin())
  with check (is_admin());


-- ── 2. user_squads ───────────────────────────────────────────
alter table user_squads
  add column if not exists user_id uuid references auth.users(id) on delete cascade;

-- UPDATE user_squads SET user_id = '<YOUR_SUPABASE_USER_UUID>' WHERE user_id IS NULL;

alter table user_squads enable row level security;

drop policy if exists "user_squads: owner full access"  on user_squads;
create policy "user_squads: owner full access"
  on user_squads for all
  using  (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "user_squads: admin full access"  on user_squads;
create policy "user_squads: admin full access"
  on user_squads for all
  using  (is_admin())
  with check (is_admin());


-- ── 3. user_transfers ────────────────────────────────────────
alter table user_transfers
  add column if not exists user_id uuid references auth.users(id) on delete cascade;

-- UPDATE user_transfers SET user_id = '<YOUR_SUPABASE_USER_UUID>' WHERE user_id IS NULL;

alter table user_transfers enable row level security;

drop policy if exists "user_transfers: owner full access"  on user_transfers;
create policy "user_transfers: owner full access"
  on user_transfers for all
  using  (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "user_transfers: admin full access"  on user_transfers;
create policy "user_transfers: admin full access"
  on user_transfers for all
  using  (is_admin())
  with check (is_admin());


-- ── 4. user_match_xi ─────────────────────────────────────────
alter table user_match_xi
  add column if not exists user_id uuid references auth.users(id) on delete cascade;

-- UPDATE user_match_xi SET user_id = '<YOUR_SUPABASE_USER_UUID>' WHERE user_id IS NULL;

alter table user_match_xi enable row level security;

drop policy if exists "user_match_xi: owner full access"  on user_match_xi;
create policy "user_match_xi: owner full access"
  on user_match_xi for all
  using  (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "user_match_xi: admin full access"  on user_match_xi;
create policy "user_match_xi: admin full access"
  on user_match_xi for all
  using  (is_admin())
  with check (is_admin());


-- ── 5. Shared read-only tables (everyone authenticated can read; only admin writes) ──

-- teams
alter table teams enable row level security;

drop policy if exists "teams: authenticated read"  on teams;
create policy "teams: authenticated read"
  on teams for select
  using (auth.role() = 'authenticated');

drop policy if exists "teams: admin write"  on teams;
create policy "teams: admin write"
  on teams for all
  using  (is_admin())
  with check (is_admin());

-- players
alter table players enable row level security;

drop policy if exists "players: authenticated read"  on players;
create policy "players: authenticated read"
  on players for select
  using (auth.role() = 'authenticated');

drop policy if exists "players: admin write"  on players;
create policy "players: admin write"
  on players for all
  using  (is_admin())
  with check (is_admin());

-- tournaments
alter table tournaments enable row level security;

drop policy if exists "tournaments: authenticated read"  on tournaments;
create policy "tournaments: authenticated read"
  on tournaments for select
  using (auth.role() = 'authenticated');

drop policy if exists "tournaments: admin write"  on tournaments;
create policy "tournaments: admin write"
  on tournaments for all
  using  (is_admin())
  with check (is_admin());

-- tournament_players
alter table tournament_players enable row level security;

drop policy if exists "tournament_players: authenticated read"  on tournament_players;
create policy "tournament_players: authenticated read"
  on tournament_players for select
  using (auth.role() = 'authenticated');

drop policy if exists "tournament_players: admin write"  on tournament_players;
create policy "tournament_players: admin write"
  on tournament_players for all
  using  (is_admin())
  with check (is_admin());

-- matches
alter table matches enable row level security;

drop policy if exists "matches: authenticated read"  on matches;
create policy "matches: authenticated read"
  on matches for select
  using (auth.role() = 'authenticated');

drop policy if exists "matches: admin write"  on matches;
create policy "matches: admin write"
  on matches for all
  using  (is_admin())
  with check (is_admin());

-- player_match_stats
alter table player_match_stats enable row level security;

drop policy if exists "player_match_stats: authenticated read"  on player_match_stats;
create policy "player_match_stats: authenticated read"
  on player_match_stats for select
  using (auth.role() = 'authenticated');

drop policy if exists "player_match_stats: admin write"  on player_match_stats;
create policy "player_match_stats: admin write"
  on player_match_stats for all
  using  (is_admin())
  with check (is_admin());

-- sl_contests (if table exists)
-- alter table sl_contests enable row level security;
-- drop policy if exists "sl_contests: authenticated read"  on sl_contests;
-- create policy "sl_contests: authenticated read" on sl_contests for select using (auth.role() = 'authenticated');
-- drop policy if exists "sl_contests: admin write"  on sl_contests;
-- create policy "sl_contests: admin write" on sl_contests for all using (is_admin()) with check (is_admin());


-- ── 6. DEFAULT user_id on insert ─────────────────────────────
-- So new rows automatically get the calling user's ID without
-- the application having to pass it explicitly.

alter table user_teams     alter column user_id set default auth.uid();
alter table user_squads    alter column user_id set default auth.uid();
alter table user_transfers alter column user_id set default auth.uid();
alter table user_match_xi  alter column user_id set default auth.uid();


-- ── 7. Claiming existing data ────────────────────────────────
-- After running this migration AND signing in via Google for the
-- first time, get your UUID from Supabase Dashboard → Auth → Users,
-- then run these four UPDATE statements (substitute the real UUID):
--
--   UPDATE user_teams     SET user_id = '<UUID>' WHERE user_id IS NULL;
--   UPDATE user_squads    SET user_id = '<UUID>' WHERE user_id IS NULL;
--   UPDATE user_transfers SET user_id = '<UUID>' WHERE user_id IS NULL;
--   UPDATE user_match_xi  SET user_id = '<UUID>' WHERE user_id IS NULL;
--
-- You only need to do this once. All future rows will be tagged automatically.


-- ── Done ─────────────────────────────────────────────────────
-- Next steps:
--   1. In Supabase Dashboard → Auth → Providers, enable Google OAuth
--      and add your OAuth client ID + secret from Google Cloud Console.
--   2. Add your app URL (e.g. http://localhost or your hosted URL) to
--      Supabase Dashboard → Auth → URL Configuration → Redirect URLs.
--   3. Update db.js (v62) and index.html per the corresponding changes.
