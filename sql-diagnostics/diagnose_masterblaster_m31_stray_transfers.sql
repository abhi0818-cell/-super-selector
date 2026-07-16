-- Diagnose: MasterBlaster squad — M31 locked with "stray" transfers that
-- don't match the single intended web edit made before lock. Investigating
-- whether lock-matches consumed a squad_draft_xi row whose target_match_id
-- didn't actually match M31 (the bug fixed in lock-matches/index.ts).

-- A) Resolve the squad + contest.
select
  us.id as squad_id,
  us.contest_id,
  us.user_id,
  c.tournament_id,
  c.total_transfers_allowed,
  c.free_transfers_per_match
from user_squads us
join contests c on c.id = us.contest_id
where us.name ilike '%masterblaster%';

-- B) M29/M30/M31/M32 match ids/status/lock times for this squad's tournament.
select id, match_number, home_team_id, away_team_id, status, lock_time, start_time
from matches
where tournament_id = (
  select c.tournament_id from user_squads us
  join contests c on c.id = us.contest_id
  where us.name ilike '%masterblaster%' limit 1
)
and match_number between 29 and 32
order by match_number;

-- C) Locked XI for M30 (the real baseline) and M31 (the suspect lock),
-- with captain/vc flags and player names.
select
  m.match_number,
  p.name as player_name,
  umx.player_id,
  umx.is_captain,
  umx.is_vc
from user_match_xi umx
join matches m on m.id = umx.match_id
join players p on p.id = umx.player_id
where umx.squad_id = (select id from user_squads where name ilike '%masterblaster%' limit 1)
and m.match_number in (30, 31)
order by m.match_number, umx.is_captain desc, umx.is_vc desc, p.name;

-- D) Transfers actually logged against M31 (player_out -> player_in, free/cost).
select
  m.match_number,
  po.name as player_out,
  pi.name as player_in,
  ut.is_free,
  ut.points_deducted
from user_transfers ut
join matches m on m.id = ut.match_id
join players po on po.id = ut.player_out_id
join players pi on pi.id = ut.player_in_id
where ut.squad_id = (select id from user_squads where name ilike '%masterblaster%' limit 1)
and m.match_number = 31;

-- E) Current squad_draft_xi row — player_ids/captain/vc + target_match_id,
-- and which match_number that target currently resolves to.
select
  sdx.squad_id,
  sdx.player_ids,
  sdx.captain_id,
  sdx.vc_id,
  sdx.target_match_id,
  m.match_number as target_match_number,
  sdx.updated_at
from squad_draft_xi sdx
left join matches m on m.id = sdx.target_match_id
where sdx.squad_id = (select id from user_squads where name ilike '%masterblaster%' limit 1);
