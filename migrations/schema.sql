-- ─────────────────────────────────────────────────────────────────────────────
-- Super Selector — Postgres schema (Supabase)
-- Single-user prototype. No auth tables yet — all rows belong to one implicit
-- user. To go multi-user later, add a `user_id uuid references auth.users` to
-- `user_teams` and enable row-level security.
-- ─────────────────────────────────────────────────────────────────────────────

-- Real cricket teams (CSK, MI, ...)
create table if not exists teams (
  id         text primary key,        -- 'CSK', 'MI', ...
  name       text not null,           -- 'Chennai Super Kings'
  color      text                     -- optional hex for UI
);

-- Player pool
create table if not exists players (
  id          text primary key,        -- 'p01', 'p02', ...
  name        text not null,
  team_id     text not null references teams(id) on delete restrict,
  role        text not null check (role in ('wk', 'bat', 'ar', 'bowl')),
  credits     numeric(4,1) not null check (credits >= 0),
  is_overseas boolean not null default false
);
-- Migration-safe add for existing tables.
alter table players add column if not exists is_overseas boolean not null default false;
create index if not exists players_team_idx on players(team_id);
create index if not exists players_role_idx on players(role);

-- A drafted XI saved by the user. May be tied to a specific match (then the
-- XI is "the playing XI for match N") or float free for general drafting.
create table if not exists user_teams (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  format          text not null check (format in ('T20', 'ODI', 'TEST')),
  captain_id      text references players(id) on delete set null,
  vice_captain_id text references players(id) on delete set null,
  match_id        uuid references matches(id) on delete set null,
  created_at      timestamptz not null default now()
);
-- Migration-safe add for existing user_teams tables
alter table user_teams add column if not exists match_id uuid references matches(id) on delete set null;
create index if not exists user_teams_match_idx on user_teams(match_id);
-- Enforce one XI per match (re-saving overwrites the previous one).
-- Partial: rows with NULL match_id (standalone XIs) are unaffected.
create unique index if not exists user_teams_one_per_match_idx
  on user_teams(match_id) where match_id is not null;

-- 11 player slots per user_team
create table if not exists user_team_players (
  user_team_id uuid not null references user_teams(id) on delete cascade,
  player_id    text not null references players(id) on delete restrict,
  primary key (user_team_id, player_id)
);
create index if not exists utp_team_idx on user_team_players(user_team_id);

-- Tournament (umbrella for a set of matches — e.g. "IPL 2026")
create table if not exists tournaments (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  format     text not null check (format in ('T20', 'ODI', 'TEST')),
  start_date date,
  end_date   date,
  created_at timestamptz not null default now()
);

-- Default IPL 2026 tournament — fixed UUID so app can reference it directly
insert into tournaments (id, name, format, start_date)
  values ('00000000-0000-0000-0000-000000000001', 'IPL 2026', 'T20', '2026-03-22')
  on conflict (id) do nothing;

-- A real cricket match (referenced when saving scores)
create table if not exists matches (
  id            uuid primary key default gen_random_uuid(),
  tournament_id uuid references tournaments(id) on delete set null,
  match_number  int,
  external_id   text,                 -- e.g. CricAPI match id (nullable)
  format        text not null check (format in ('T20', 'ODI', 'TEST')),
  home_team_id  text references teams(id) on delete set null,
  away_team_id  text references teams(id) on delete set null,
  played_on     date not null default current_date,
  start_time    timestamptz,          -- kickoff time (UTC) — used for time-based XI lock
  status        text,                 -- 'scheduled' | 'in_progress' | 'completed' | etc.
  notes         text
);
-- Migration-safe adds for existing matches tables.
alter table matches add column if not exists tournament_id uuid references tournaments(id) on delete set null;
alter table matches add column if not exists match_number  int;
alter table matches add column if not exists status        text;
-- Kickoff time (UTC). Used for time-based XI locking.
alter table matches add column if not exists start_time    timestamptz;
create index if not exists matches_tournament_idx on matches(tournament_id, match_number);
-- For CricAPI sync: external_id is the upstream match UUID. Full unique index
-- (no WHERE clause) so ON CONFLICT (external_id) works without index_predicate.
-- Multiple NULLs are still allowed because Postgres treats NULLs as distinct.
create unique index if not exists matches_external_id_idx on matches(external_id);

-- Per-player totals per match (fed by the scoring engine output)
create table if not exists player_match_stats (
  match_id     uuid not null references matches(id)  on delete cascade,
  player_id    text not null references players(id)  on delete cascade,
  -- Compact totals. JSONB blobs let the schema follow the engine's shape
  -- (runs, ballsFaced, fours, sixes, wickets, etc.) without exploding columns.
  batting      jsonb,
  bowling      jsonb,
  fielding     jsonb,
  raw_points   numeric(6,1) not null default 0,
  primary key (match_id, player_id)
);

-- Raw CricAPI scorecard payload cached after a match completes.
-- One row per match — completed matches are never re-fetched from CricAPI;
-- the live poller bypasses this table entirely.
create table if not exists match_scorecards (
  match_id   uuid primary key references matches(id) on delete cascade,
  payload    jsonb        not null,
  fetched_at timestamptz  not null default now()
);

-- Per-saved-XI score for a match — what shows up on the leaderboard / history
create table if not exists user_team_match_scores (
  user_team_id uuid not null references user_teams(id) on delete cascade,
  match_id     uuid not null references matches(id)    on delete cascade,
  total_points numeric(7,1) not null default 0,
  computed_at  timestamptz  not null default now(),
  primary key (user_team_id, match_id)
);
create index if not exists utms_team_idx on user_team_match_scores(user_team_id, computed_at desc);

-- ─── Seed: 10 IPL teams ──────────────────────────────────────────────────────
insert into teams (id, name, color) values
  ('CSK',  'Chennai Super Kings',         '#fbbf24'),
  ('MI',   'Mumbai Indians',              '#1e3a8a'),
  ('RCB',  'Royal Challengers Bengaluru', '#dc2626'),
  ('KKR',  'Kolkata Knight Riders',       '#7c3aed'),
  ('SRH',  'Sunrisers Hyderabad',         '#ea580c'),
  ('DC',   'Delhi Capitals',              '#2563eb'),
  ('RR',   'Rajasthan Royals',            '#ec4899'),
  ('GT',   'Gujarat Titans',              '#0f172a'),
  ('LSG',  'Lucknow Super Giants',        '#06b6d4'),
  ('PBKS', 'Punjab Kings',                '#b91c1c')
on conflict (id) do nothing;

-- ─── Seed: 30 players (matches the IDs used in index.html) ───────────────────
insert into players (id, name, team_id, role, credits) values
  ('p01', 'MS Dhoni',          'CSK', 'wk',   9.0),
  ('p02', 'Rishabh Pant',      'DC',  'wk',   9.5),
  ('p03', 'KL Rahul',          'SRH', 'wk',  10.0),
  ('p04', 'Sanju Samson',      'RR',  'wk',   9.5),
  ('p05', 'Rohit Sharma',      'MI',  'bat', 10.5),
  ('p06', 'Virat Kohli',       'RCB', 'bat', 11.0),
  ('p07', 'Shubman Gill',      'GT',  'bat', 10.0),
  ('p08', 'Faf du Plessis',    'RCB', 'bat',  9.0),
  ('p09', 'David Warner',      'DC',  'bat',  9.5),
  ('p10', 'Suryakumar Yadav',  'MI',  'bat', 10.0),
  ('p11', 'Ruturaj Gaikwad',   'CSK', 'bat',  9.0),
  ('p12', 'Yashasvi Jaiswal',  'RR',  'bat',  9.5),
  ('p13', 'Hardik Pandya',     'GT',  'ar',  10.5),
  ('p14', 'Ravindra Jadeja',   'CSK', 'ar',   9.5),
  ('p15', 'Andre Russell',     'KKR', 'ar',  10.0),
  ('p16', 'Sunil Narine',      'KKR', 'ar',   9.0),
  ('p17', 'Glenn Maxwell',     'RCB', 'ar',   9.5),
  ('p18', 'Axar Patel',        'DC',  'ar',   8.5),
  ('p19', 'Marcus Stoinis',    'SRH', 'ar',   8.5),
  ('p20', 'Jasprit Bumrah',    'MI',  'bowl',10.5),
  ('p21', 'Mohammed Shami',    'GT',  'bowl', 9.5),
  ('p22', 'Yuzvendra Chahal',  'RR',  'bowl', 9.0),
  ('p23', 'Rashid Khan',       'GT',  'bowl',10.0),
  ('p24', 'Kuldeep Yadav',     'DC',  'bowl', 9.0),
  ('p25', 'Mohammed Siraj',    'RCB', 'bowl', 9.0),
  ('p26', 'T Natarajan',       'SRH', 'bowl', 8.5),
  ('p27', 'Deepak Chahar',     'CSK', 'bowl', 8.5),
  ('p28', 'Trent Boult',       'RR',  'bowl', 9.5),
  ('p29', 'Varun Chakravarthy','KKR', 'bowl', 8.5),
  ('p30', 'Arshdeep Singh',    'SRH', 'bowl', 8.5)
on conflict (id) do nothing;

-- Mark overseas players (IPL rule: max 4 overseas in the playing XI).
update players set is_overseas = true where id in (
  'p08', -- Faf du Plessis (South Africa)
  'p09', -- David Warner (Australia)
  'p15', -- Andre Russell (West Indies)
  'p16', -- Sunil Narine (West Indies)
  'p17', -- Glenn Maxwell (Australia)
  'p19', -- Marcus Stoinis (Australia)
  'p23', -- Rashid Khan (Afghanistan)
  'p28'  -- Trent Boult (New Zealand)
);
update players set is_overseas = false where id not in (
  'p08','p09','p15','p16','p17','p19','p23','p28'
);

-- ─── Convenience views ───────────────────────────────────────────────────────

-- A saved XI flattened to one row per player with team + role for the UI.
create or replace view user_team_xi as
  select ut.id   as user_team_id,
         ut.name as team_name,
         ut.format,
         ut.captain_id,
         ut.vice_captain_id,
         ut.created_at,
         p.id    as player_id,
         p.name  as player_name,
         p.role,
         p.credits,
         p.team_id
  from user_teams ut
  join user_team_players utp on utp.user_team_id = ut.id
  join players p on p.id = utp.player_id;

-- ─── Scoring rules (one row per format, edited from the UI) ─────────────────
create table if not exists scoring_rules (
  format     text primary key check (format in ('T20', 'ODI', 'TEST')),
  rules      jsonb not null,
  updated_at timestamptz not null default now()
);

-- Match history rolled up per saved XI.
create or replace view user_team_history as
  select uts.user_team_id,
         ut.name           as team_name,
         m.id              as match_id,
         m.played_on,
         m.format,
         m.external_id,
         m.notes,
         uts.total_points,
         uts.computed_at
  from user_team_match_scores uts
  join matches m   on m.id = uts.match_id
  join user_teams ut on ut.id = uts.user_team_id
  order by m.played_on desc, uts.computed_at desc;
