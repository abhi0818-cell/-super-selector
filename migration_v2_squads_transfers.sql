-- ─────────────────────────────────────────────────────────────────────────────
-- Super Selector — Migration v2: Contest Types + Season-Long Squad + Transfers
--
-- DESIGN INTENT
-- ─────────────────────────────────────────────────────────────────────────────
-- Two contest types live side-by-side under a shared `contests` table:
--
--   1. DAILY CONTEST ("daily")
--      Pick a fresh XI for each match independently.
--      Uses EXISTING tables — no changes to user_teams, user_team_players,
--      or user_team_match_scores. Daily teams just get an optional contest_id
--      tag so they can be grouped under a contest.
--
--   2. SEASON-LONG CONTEST ("season_long")
--      Build a 15-player squad at the start of the tournament.
--      Make limited transfers between matches.
--      Pick your XI from the squad each match.
--      Uses NEW tables — user_squads, user_squad_players, user_transfers,
--      user_match_xi, user_match_xi_scores.
--
-- All changes are ADDITIVE. Existing data is never touched.
-- Paste into Supabase SQL Editor → Run.
-- ─────────────────────────────────────────────────────────────────────────────


-- ═══════════════════════════════════════════════════════════════════════════
-- 1. EXTEND TOURNAMENTS
--    Add configuration columns for the season-long scoring engine.
--    Daily contests ignore these columns entirely.
-- ═══════════════════════════════════════════════════════════════════════════

alter table tournaments
  add column if not exists squad_size                  int          not null default 15,
  add column if not exists xi_size                     int          not null default 11,
  add column if not exists total_budget                numeric(5,1) not null default 100.0,
  add column if not exists free_transfers_per_match    int          not null default 1,
  add column if not exists max_free_transfer_rollover  int          not null default 2,
  add column if not exists extra_transfer_point_cost   int          not null default 4,
  add column if not exists max_overseas_in_xi          int          not null default 4;

update tournaments
  set squad_size                 = 15,
      xi_size                    = 11,
      total_budget               = 100.0,
      free_transfers_per_match   = 1,
      max_free_transfer_rollover = 2,
      extra_transfer_point_cost  = 4,
      max_overseas_in_xi         = 4
  where id = '00000000-0000-0000-0000-000000000001';


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. TOURNAMENT_PLAYERS
--    Player credit values per tournament.
--    Both daily and season-long contests use these credits.
--    Seeded from global players.credits so nothing breaks today.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists tournament_players (
  id            uuid         primary key default gen_random_uuid(),
  tournament_id uuid         not null references tournaments(id) on delete cascade,
  player_id     text         not null references players(id)     on delete cascade,
  team_id       text         references teams(id) on delete set null, -- tournament-specific team (e.g. post-auction)
  credit_value  numeric(4,1) not null check (credit_value >= 0),
  is_active     boolean      not null default true,   -- false = unavailable (injured/rested)
  updated_at    timestamptz  not null default now(),
  unique (tournament_id, player_id)
);

create index if not exists tp_tournament_active_idx on tournament_players(tournament_id, is_active);
create index if not exists tp_player_idx            on tournament_players(player_id);

-- Seed from existing global players for IPL 2026 (copies team + credits as starting point)
insert into tournament_players (tournament_id, player_id, team_id, credit_value)
  select '00000000-0000-0000-0000-000000000001', id, team_id, credits
  from   players
  on conflict (tournament_id, player_id) do nothing;


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. CONTESTS
--    The umbrella table. One row per contest.
--    contest_type determines which scoring path is used:
--      'daily'       → user_teams / user_team_players / user_team_match_scores
--      'season_long' → user_squads / user_squad_players / user_match_xi / user_match_xi_scores
--
--    Both types reference the same tournament, matches, and players.
--    Both can run simultaneously for the same tournament.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists contests (
  id            uuid        primary key default gen_random_uuid(),
  tournament_id uuid        not null references tournaments(id) on delete restrict,
  name          text        not null,
  contest_type  text        not null check (contest_type in ('daily', 'season_long')),
  description   text,
  is_active     boolean     not null default true,
  created_at    timestamptz not null default now()
);

create index if not exists contests_tournament_idx on contests(tournament_id, is_active);

-- Seed two default contests for IPL 2026
insert into contests (id, tournament_id, name, contest_type, description)
  values
    ('10000000-0000-0000-0000-000000000001',
     '00000000-0000-0000-0000-000000000001',
     'IPL 2026 Daily',
     'daily',
     'Pick a fresh XI for each match. No transfers.'),
    ('10000000-0000-0000-0000-000000000002',
     '00000000-0000-0000-0000-000000000001',
     'IPL 2026 Season Long',
     'season_long',
     'Build a 15-player squad. Make up to 1 free transfer per match.')
  on conflict (id) do nothing;


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. TAG EXISTING user_teams WITH A CONTEST (daily path)
--    Optional backfill — links existing saved XIs to the default daily contest.
--    contest_id is nullable so existing rows without it continue to work.
-- ═══════════════════════════════════════════════════════════════════════════

alter table user_teams
  add column if not exists contest_id uuid references contests(id) on delete set null;

create index if not exists user_teams_contest_idx on user_teams(contest_id);

-- Backfill: tag all existing match-linked teams to the default daily contest
update user_teams
  set contest_id = '10000000-0000-0000-0000-000000000001'
  where match_id is not null
    and contest_id is null;


-- ═══════════════════════════════════════════════════════════════════════════
-- 5. USER_SQUADS  (season_long path only)
--    One per (user, contest). Persists all season.
--    user_id is nullable for now (single-user prototype).
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists user_squads (
  id                       uuid         primary key default gen_random_uuid(),
  contest_id               uuid         not null references contests(id) on delete restrict,
  user_id                  uuid,                                     -- null = single implicit user
  name                     text         not null default 'My Squad',
  budget_remaining         numeric(5,1) not null default 100.0,
  free_transfers_available int          not null default 1,
  created_at               timestamptz  not null default now(),
  updated_at               timestamptz  not null default now()
);

-- One squad per authenticated user per contest
create unique index if not exists user_squads_user_contest_idx
  on user_squads(user_id, contest_id)
  where user_id is not null;

create index if not exists user_squads_contest_idx on user_squads(contest_id);


-- ═══════════════════════════════════════════════════════════════════════════
-- 6. USER_SQUAD_PLAYERS  (season_long path only)
--    The 15-player pool with full acquisition / release history.
--    released_before_match_id IS NULL  →  player is currently in the squad.
--    released_before_match_id = M      →  player was transferred out before match M.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists user_squad_players (
  id                       uuid        primary key default gen_random_uuid(),
  squad_id                 uuid        not null references user_squads(id)  on delete cascade,
  player_id                text        not null references players(id)      on delete restrict,
  acquired_before_match_id uuid        references matches(id) on delete set null,  -- null = initial build
  released_before_match_id uuid        references matches(id) on delete set null,  -- null = still in squad
  acquired_at              timestamptz not null default now()
);

create index if not exists usp_squad_current_idx on user_squad_players(squad_id, released_before_match_id);
create index if not exists usp_player_idx        on user_squad_players(player_id);


-- ═══════════════════════════════════════════════════════════════════════════
-- 7. USER_TRANSFERS  (season_long path only)
--    One row per player swapped. match_id = the match BEFORE WHICH the
--    transfer applies. Window closes at that match's start_time.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists user_transfers (
  id              uuid        primary key default gen_random_uuid(),
  squad_id        uuid        not null references user_squads(id)  on delete cascade,
  match_id        uuid        not null references matches(id)      on delete cascade,
  player_out_id   text        not null references players(id)      on delete restrict,
  player_in_id    text        not null references players(id)      on delete restrict,
  is_free         boolean     not null default true,
  points_deducted int         not null default 0,
  transferred_at  timestamptz not null default now(),
  check (player_out_id <> player_in_id)
);

create index if not exists ut_squad_match_idx on user_transfers(squad_id, match_id);
create index if not exists ut_match_idx       on user_transfers(match_id);


-- ═══════════════════════════════════════════════════════════════════════════
-- 8. USER_MATCH_XI  (season_long path only)
--    The 11 picked from the squad for a specific match.
--    Equivalent of user_team_players but bound to a squad, not a fresh team.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists user_match_xi (
  id         uuid    primary key default gen_random_uuid(),
  squad_id   uuid    not null references user_squads(id)  on delete cascade,
  match_id   uuid    not null references matches(id)      on delete cascade,
  player_id  text    not null references players(id)      on delete restrict,
  is_captain boolean not null default false,
  is_vc      boolean not null default false,
  role       text    not null check (role in ('wk','bat','ar','bowl')),
  unique (squad_id, match_id, player_id)
);

create index if not exists umxi_squad_match_idx on user_match_xi(squad_id, match_id);


-- ═══════════════════════════════════════════════════════════════════════════
-- 9. USER_MATCH_XI_SCORES  (season_long path only)
--    Per-player points per match, after captain/VC multipliers.
--    Mirrors user_team_match_scores but for the squad-based path.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists user_match_xi_scores (
  id           uuid         primary key default gen_random_uuid(),
  squad_id     uuid         not null references user_squads(id)  on delete cascade,
  match_id     uuid         not null references matches(id)      on delete cascade,
  player_id    text         not null references players(id)      on delete restrict,
  base_points  numeric(6,1) not null default 0,
  multiplier   numeric(3,1) not null default 1.0,   -- 1.0 normal / 2.0 VC / 3.0 captain
  total_points numeric(6,1) not null default 0,
  computed_at  timestamptz  not null default now(),
  unique (squad_id, match_id, player_id)
);

create index if not exists umxis_squad_match_idx on user_match_xi_scores(squad_id, match_id);


-- ═══════════════════════════════════════════════════════════════════════════
-- 10. CONVENIENCE VIEWS
-- ═══════════════════════════════════════════════════════════════════════════

-- Current 15-player squad (season_long)
create or replace view v_squad_current_players as
  select
    us.id                                           as squad_id,
    us.contest_id,
    us.name                                         as squad_name,
    us.budget_remaining,
    us.free_transfers_available,
    p.id                                            as player_id,
    p.name                                          as player_name,
    coalesce(tp.team_id, p.team_id)                 as team_id,  -- tournament-specific team wins
    p.role,
    p.is_overseas,
    coalesce(tp.credit_value, p.credits)            as credit_value,
    tp.is_active                                    as tournament_available,
    usp.acquired_at
  from      user_squads         us
  join      contests            c   on c.id = us.contest_id
  join      user_squad_players  usp on usp.squad_id = us.id
                                   and usp.released_before_match_id is null
  join      players             p   on p.id = usp.player_id
  left join tournament_players  tp  on tp.tournament_id = c.tournament_id
                                   and tp.player_id     = p.id;

-- Per-match XI with points (season_long history)
create or replace view v_match_xi_with_scores as
  select
    xi.squad_id,
    xi.match_id,
    xi.player_id,
    xi.is_captain,
    xi.is_vc,
    xi.role,
    p.name                                          as player_name,
    p.team_id,
    m.match_number,
    m.played_on,
    m.home_team_id,
    m.away_team_id,
    m.status                                        as match_status,
    coalesce(s.base_points,  0)                     as base_points,
    coalesce(s.multiplier,   1.0)                   as multiplier,
    coalesce(s.total_points, 0)                     as total_points
  from      user_match_xi        xi
  join      players              p  on p.id  = xi.player_id
  join      matches              m  on m.id  = xi.match_id
  left join user_match_xi_scores s  on s.squad_id  = xi.squad_id
                                   and s.match_id  = xi.match_id
                                   and s.player_id = xi.player_id;

-- Transfer log with player names
create or replace view v_transfer_history as
  select
    ut.id,
    ut.squad_id,
    ut.match_id,
    m.match_number,
    m.played_on,
    p_out.id      as player_out_id,
    p_out.name    as player_out_name,
    p_out.team_id as player_out_team,
    p_in.id       as player_in_id,
    p_in.name     as player_in_name,
    p_in.team_id  as player_in_team,
    ut.is_free,
    ut.points_deducted,
    ut.transferred_at
  from      user_transfers ut
  join      matches        m     on m.id     = ut.match_id
  join      players        p_out on p_out.id = ut.player_out_id
  join      players        p_in  on p_in.id  = ut.player_in_id
  order by  ut.transferred_at desc;

-- Contest leaderboard — works for BOTH contest types
-- Daily:       ranks by sum of user_team_match_scores per contest
-- Season-long: ranks by sum of user_match_xi_scores per squad
create or replace view v_contest_leaderboard as
  -- Daily path
  select
    c.id                                       as contest_id,
    c.name                                     as contest_name,
    c.contest_type,
    ut.id                                      as entry_id,
    ut.name                                    as entry_name,
    coalesce(sum(utms.total_points), 0)        as total_points
  from      contests               c
  join      user_teams             ut   on ut.contest_id   = c.id
  left join user_team_match_scores utms on utms.user_team_id = ut.id
  where c.contest_type = 'daily'
  group by c.id, c.name, c.contest_type, ut.id, ut.name

  union all

  -- Season-long path
  select
    c.id                                       as contest_id,
    c.name                                     as contest_name,
    c.contest_type,
    us.id                                      as entry_id,
    us.name                                    as entry_name,
    coalesce(sum(s.total_points), 0)
      - coalesce(sum(xfr.points_deducted), 0) as total_points
  from      contests            c
  join      user_squads         us  on us.contest_id  = c.id
  left join user_match_xi_scores s  on s.squad_id     = us.id
  left join user_transfers       xfr on xfr.squad_id  = us.id
  where c.contest_type = 'season_long'
  group by c.id, c.name, c.contest_type, us.id, us.name;


-- ═══════════════════════════════════════════════════════════════════════════
-- 11. HELPER FUNCTION — transfers_open()
--     Returns true if the transfer window for a given match is open.
--     Call this before committing any row to user_transfers.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function transfers_open(p_match_id uuid)
returns boolean
language sql stable as $$
  select coalesce(
    (select start_time > now() from matches where id = p_match_id),
    true   -- no start_time set → window open
  );
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- Done.
--
-- New tables:  tournament_players, contests, user_squads, user_squad_players,
--              user_transfers, user_match_xi, user_match_xi_scores
-- Modified:    tournaments (new config columns), user_teams (contest_id added)
-- New views:   v_squad_current_players, v_match_xi_with_scores,
--              v_transfer_history, v_contest_leaderboard
-- Existing:    user_teams, user_team_players, user_team_match_scores — UNTOUCHED
-- ═══════════════════════════════════════════════════════════════════════════
