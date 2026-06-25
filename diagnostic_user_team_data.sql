-- ============================================================
-- diagnostic_user_team_data.sql
-- Run section by section in Supabase SQL Editor.
-- ============================================================


-- ════════════════════════════════════════════════════════════
-- 1. PROFILES  (email, first_name, last_name, team_name)
-- ════════════════════════════════════════════════════════════

-- 1a. Show what's stored for every user
select id, email, first_name, last_name, team_name, display_name, updated_at
from profiles
order by updated_at desc;

-- 1b. Just the incomplete rows
select id, email, first_name, last_name, team_name, display_name
from profiles
where first_name is null or last_name is null or team_name is null;

-- 1c. Fill in what's missing — same fallback logic as migration_v33
-- (display_name first, then the email username as a last resort)
update profiles
   set team_name = coalesce(team_name, display_name, split_part(email, '@', 1))
 where team_name is null;

update profiles
   set first_name = coalesce(first_name, split_part(display_name, ' ', 1), split_part(email, '@', 1))
 where first_name is null;

update profiles
   set last_name = coalesce(last_name,
         case when display_name is not null and position(' ' in display_name) > 0
              then trim(substring(display_name from position(' ' in display_name) + 1))
              else null end)
 where last_name is null;


-- ════════════════════════════════════════════════════════════
-- 2. USER_TEAMS  (Daily XI — one row per match)
-- ════════════════════════════════════════════════════════════

-- 2a. Show what's stored for every Daily team
select
  ut.id, ut.match_id, ut.format, ut.name,
  p.email, p.team_name,
  ut.captain_id, ut.vice_captain_id,
  count(utp.player_id)            as player_count,
  ut.created_at
from user_teams ut
left join profiles           p   on p.id = ut.user_id
left join user_team_players  utp on utp.user_team_id = ut.id
group by ut.id, ut.match_id, ut.format, ut.name, p.email, p.team_name,
         ut.captain_id, ut.vice_captain_id, ut.created_at
order by ut.created_at desc;

-- 2b. Flag incomplete teams (missing captain/VC, <11 players, or no match_id)
select
  ut.id, p.email, ut.match_id, ut.captain_id, ut.vice_captain_id,
  count(utp.player_id) as player_count
from user_teams ut
left join profiles          p   on p.id = ut.user_id
left join user_team_players utp on utp.user_team_id = ut.id
group by ut.id, p.email, ut.match_id, ut.captain_id, ut.vice_captain_id
having count(utp.player_id) < 11
    or ut.captain_id is null
    or ut.vice_captain_id is null
    or ut.match_id is null;

-- 2c. NOTE: there's no safe auto-fix for missing player picks or
-- captain/vice-captain — there's no source of truth for what the user
-- actually intended to pick. Use 2b to find affected teams, then either
-- have the user re-save that match's XI, or manually decide values.
-- The one thing that IS safe to backfill: if a team has all 11 players
-- but captain/VC are null, default both to two players already in the
-- team (review before running — this is a guess, not a recovery of intent):
--
-- update user_teams ut set captain_id = (
--   select player_id from user_team_players where user_team_id = ut.id order by player_id limit 1
-- ) where ut.captain_id is null
--   and (select count(*) from user_team_players where user_team_id = ut.id) = 11;


-- ════════════════════════════════════════════════════════════
-- 3. USER_SQUADS  (Season Long — persistent squad per contest)
-- ════════════════════════════════════════════════════════════

-- 3a. Show what's stored for every SL squad
select
  us.id, us.contest_id, us.name,
  p.email, p.team_name,
  us.budget_remaining, us.free_transfers_available,
  count(usp.player_id) filter (where usp.released_before_match_id is null) as current_player_count,
  sdx.captain_id, sdx.vc_id,
  coalesce(array_length(sdx.player_ids, 1), 0) as draft_xi_count,
  us.created_at, us.updated_at
from user_squads us
left join profiles          p   on p.id = us.user_id
left join user_squad_players usp on usp.squad_id = us.id
left join squad_draft_xi    sdx on sdx.squad_id = us.id
group by us.id, us.contest_id, us.name, p.email, p.team_name,
         us.budget_remaining, us.free_transfers_available,
         sdx.captain_id, sdx.vc_id, sdx.player_ids, us.created_at, us.updated_at
order by us.created_at desc;

-- 3b. Flag incomplete squads (no current 15-player squad, no draft XI row,
-- or a draft XI missing captain/VC)
select
  us.id, p.email, us.contest_id,
  count(usp.player_id) filter (where usp.released_before_match_id is null) as current_player_count,
  sdx.captain_id, sdx.vc_id,
  coalesce(array_length(sdx.player_ids, 1), 0) as draft_xi_count
from user_squads us
left join profiles           p   on p.id = us.user_id
left join user_squad_players usp on usp.squad_id = us.id
left join squad_draft_xi     sdx on sdx.squad_id = us.id
group by us.id, p.email, us.contest_id, sdx.captain_id, sdx.vc_id, sdx.player_ids
having count(usp.player_id) filter (where usp.released_before_match_id is null) < 15
    or sdx.squad_id is null
    or sdx.captain_id is null
    or sdx.vc_id is null;

-- 3c. Safe-ish backfill: a squad with a 15-player roster but no
-- squad_draft_xi row at all (so the app has nothing to render) — seed an
-- empty draft XI row so it stops erroring; the user still has to pick
-- their actual XI/captain in-app, this just unblocks the screen:
--
-- insert into squad_draft_xi (squad_id, player_ids, captain_id, vc_id)
-- select us.id, '{}', null, null
-- from user_squads us
-- left join squad_draft_xi sdx on sdx.squad_id = us.id
-- where sdx.squad_id is null
-- on conflict (squad_id) do nothing;
