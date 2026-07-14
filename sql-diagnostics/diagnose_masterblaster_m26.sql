-- Is MasterBlaster's (abhi0818@gmail.com, MLC Season Long) M26 actually locked,
-- and if not, what does the current draft/match state look like?

-- A) M26 itself — is this the match we think it is? Real start/lock time, status.
select id, match_number, tournament_id, status, start_time, lock_time, home_team_id, away_team_id
from matches
where match_number = 26
  and tournament_id = (
    select tournament_id from contests c
    join user_squads us on us.contest_id = c.id
    join profiles    p  on p.id = us.user_id
    where p.team_name = 'MasterBlaster'
  );

-- B) Does a locked XI row exist for MasterBlaster + M26?
select uxi.*
from user_match_xi uxi
join user_squads us on us.id = uxi.squad_id
join profiles    p  on p.id = us.user_id
where p.team_name = 'MasterBlaster'
  and uxi.match_id = (select id from matches where match_number = 26
    and tournament_id = (select tournament_id from contests c
      join user_squads us2 on us2.contest_id = c.id
      join profiles p2 on p2.id = us2.user_id where p2.team_name = 'MasterBlaster'));

-- C) Current draft state (squad_draft_xi) — what's actually saved right now,
--    and (once migration_v34 is applied) whether a pending_booster is attached.
select sdx.*
from squad_draft_xi sdx
join user_squads us on us.id = sdx.squad_id
join profiles    p  on p.id = us.user_id
where p.team_name = 'MasterBlaster';

-- D) All of MasterBlaster's locked matches so far, most recent first — to see
--    whether M26 is simply missing from an otherwise-continuous streak, or
--    whether there's a wider gap (multiple missed locks).
select uxi.match_id, m.match_number, m.status, m.start_time, count(*) as players_locked
from user_match_xi uxi
join user_squads us on us.id = uxi.squad_id
join profiles    p  on p.id = us.user_id
join matches     m  on m.id = uxi.match_id
where p.team_name = 'MasterBlaster'
group by uxi.match_id, m.match_number, m.status, m.start_time
order by m.match_number desc
limit 10;
