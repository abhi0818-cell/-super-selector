-- ============================================================
-- Super Selector — Supabase Schema + Seed
-- Run this entire file in the Supabase SQL Editor:
-- https://supabase.com/dashboard/project/gepltclaeczgtruvekci/sql
-- ============================================================


-- ── 1. PLAYERS ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS players (
  id         text        PRIMARY KEY,          -- e.g. 'p01'
  name       text        NOT NULL,
  team       text        NOT NULL,
  role       text        NOT NULL CHECK (role IN ('wk','bat','ar','bowl')),
  credits    numeric(4,1) NOT NULL,
  overseas   boolean     NOT NULL DEFAULT false,
  is_active  boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE players ENABLE ROW LEVEL SECURITY;

CREATE POLICY "players_public_read"
  ON players FOR SELECT USING (true);


-- ── 2. MATCHES ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS matches (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  team_a      text        NOT NULL,
  team_b      text        NOT NULL,
  format      text        NOT NULL DEFAULT 'T20' CHECK (format IN ('T20','ODI','TEST')),
  match_date  timestamptz NOT NULL,
  venue       text,
  status      text        NOT NULL DEFAULT 'upcoming'
                          CHECK (status IN ('upcoming','live','completed')),
  matchweek   integer,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE matches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "matches_public_read"
  ON matches FOR SELECT USING (true);


-- ── 3. PROFILES ──────────────────────────────────────────────────────────────
-- One row per auth user — auto-created via trigger on signup.

CREATE TABLE IF NOT EXISTS profiles (
  id           uuid    PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name text,
  team_name    text    NOT NULL DEFAULT 'My Team',
  created_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "profiles_public_read"
  ON profiles FOR SELECT USING (true);

CREATE POLICY "profiles_own_update"
  ON profiles FOR UPDATE USING (auth.uid() = id);

CREATE POLICY "profiles_own_insert"
  ON profiles FOR INSERT WITH CHECK (auth.uid() = id);

-- Auto-create profile on first sign-up
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name)
  VALUES (NEW.id, split_part(NEW.email, '@', 1))
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();


-- ── 4. USER_TEAMS ────────────────────────────────────────────────────────────
-- One row per user per match per contest type.
-- player_ids: array of player.id strings
-- captain_id / vice_captain_id: player.id of the chosen C and VC

CREATE TABLE IF NOT EXISTS user_teams (
  id               uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid    NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  match_id         uuid    REFERENCES matches(id) ON DELETE SET NULL,
  contest_type     text    NOT NULL DEFAULT 'sl'
                           CHECK (contest_type IN ('daily','sl','private')),
  league_id        text,                         -- null = main contest
  player_ids       text[]  NOT NULL DEFAULT '{}',
  captain_id       text,
  vice_captain_id  text,
  total_points     numeric NOT NULL DEFAULT 0,   -- updated after match
  matchweek        integer,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, match_id, contest_type, league_id)
);

ALTER TABLE user_teams ENABLE ROW LEVEL SECURITY;

-- Anyone signed in can read all teams (leaderboard needs this)
CREATE POLICY "user_teams_authenticated_read"
  ON user_teams FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "user_teams_own_insert"
  ON user_teams FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "user_teams_own_update"
  ON user_teams FOR UPDATE USING (auth.uid() = user_id);

-- Keep updated_at current
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS user_teams_updated_at ON user_teams;
CREATE TRIGGER user_teams_updated_at
  BEFORE UPDATE ON user_teams
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ── 5. LEADERBOARD VIEW ───────────────────────────────────────────────────────
-- Aggregates total points per user per contest, adds rank and display_name.

CREATE OR REPLACE VIEW leaderboard_summary AS
SELECT
  ut.user_id,
  ut.contest_type,
  ut.league_id,
  COALESCE(p.display_name, split_part(u.email, '@', 1))  AS display_name,
  COALESCE(p.team_name, 'My Team')                        AS team_name,
  SUM(ut.total_points)::numeric                           AS total_points,
  RANK() OVER (
    PARTITION BY ut.contest_type, ut.league_id
    ORDER BY SUM(ut.total_points) DESC
  )::integer AS rank
FROM user_teams ut
JOIN auth.users  u ON u.id  = ut.user_id
LEFT JOIN profiles p ON p.id = ut.user_id
GROUP BY ut.user_id, ut.contest_type, ut.league_id, p.display_name, p.team_name, u.email;


-- ── 6. SEED — PLAYERS ────────────────────────────────────────────────────────

INSERT INTO players (id, name, team, role, credits, overseas) VALUES
  ('p01', 'MS Dhoni',           'CSK', 'wk',    9.0, false),
  ('p02', 'Rishabh Pant',       'DC',  'wk',    9.5, false),
  ('p03', 'KL Rahul',           'SRH', 'wk',   10.0, false),
  ('p04', 'Sanju Samson',       'RR',  'wk',    9.5, false),
  ('p05', 'Rohit Sharma',       'MI',  'bat',  10.5, false),
  ('p06', 'Virat Kohli',        'RCB', 'bat',  11.0, false),
  ('p07', 'Shubman Gill',       'GT',  'bat',  10.0, false),
  ('p08', 'Faf du Plessis',     'RCB', 'bat',   9.0, true),
  ('p09', 'David Warner',       'DC',  'bat',   9.5, true),
  ('p10', 'Suryakumar Yadav',   'MI',  'bat',  10.0, false),
  ('p11', 'Ruturaj Gaikwad',    'CSK', 'bat',   9.0, false),
  ('p12', 'Yashasvi Jaiswal',   'RR',  'bat',   9.5, false),
  ('p13', 'Hardik Pandya',      'GT',  'ar',   10.5, false),
  ('p14', 'Ravindra Jadeja',    'CSK', 'ar',    9.5, false),
  ('p15', 'Andre Russell',      'KKR', 'ar',   10.0, true),
  ('p16', 'Sunil Narine',       'KKR', 'ar',    9.0, true),
  ('p17', 'Glenn Maxwell',      'RCB', 'ar',    9.5, true),
  ('p18', 'Axar Patel',         'DC',  'ar',    8.5, false),
  ('p19', 'Marcus Stoinis',     'SRH', 'ar',    8.5, true),
  ('p20', 'Jasprit Bumrah',     'MI',  'bowl', 10.5, false),
  ('p21', 'Mohammed Shami',     'GT',  'bowl',  9.5, false),
  ('p22', 'Yuzvendra Chahal',   'RR',  'bowl',  9.0, false),
  ('p23', 'Rashid Khan',        'GT',  'bowl', 10.0, true),
  ('p24', 'Kuldeep Yadav',      'DC',  'bowl',  9.0, false),
  ('p25', 'Mohammed Siraj',     'RCB', 'bowl',  9.0, false),
  ('p26', 'T Natarajan',        'SRH', 'bowl',  8.5, false),
  ('p27', 'Deepak Chahar',      'CSK', 'bowl',  8.5, false),
  ('p28', 'Trent Boult',        'RR',  'bowl',  9.5, true),
  ('p29', 'Varun Chakravarthy', 'KKR', 'bowl',  8.5, false),
  ('p30', 'Arshdeep Singh',     'SRH', 'bowl',  8.5, false)
ON CONFLICT (id) DO UPDATE SET
  name     = EXCLUDED.name,
  team     = EXCLUDED.team,
  role     = EXCLUDED.role,
  credits  = EXCLUDED.credits,
  overseas = EXCLUDED.overseas;


-- ── 7. SEED — CURRENT MATCH ──────────────────────────────────────────────────

INSERT INTO matches (id, team_a, team_b, format, match_date, venue, status, matchweek)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'CSK', 'MI', 'T20',
  (now() + interval '1 day')::timestamptz,
  'Wankhede Stadium, Mumbai',
  'upcoming',
  1
)
ON CONFLICT (id) DO NOTHING;
