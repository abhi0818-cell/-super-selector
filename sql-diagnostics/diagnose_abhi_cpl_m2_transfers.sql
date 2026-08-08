-- CPL 2026 Season Long — contest_id 3d66c13f-d7fb-497c-baff-bdc50edede61
-- tournament_id b434446d-f817-4fe3-a930-cedc88084b24
-- Read-only. Run in Supabase SQL editor.

-- 1) This user's squad for CPL, if any.
select
  us.id            as squad_id,
  us.contest_id,
  us.user_id,
  us.name,
  us.created_at
from user_squads us
join profiles p on p.id = us.user_id
where p.email = 'abhi0818@gmail.com'
  and us.contest_id = '3d66c13f-d7fb-497c-baff-bdc50edede61';

-- 2) Any transfer rows at all for this contest (any user) — sanity check
--    that the table isn't just missing this user's rows specifically.
select
  ut.id, ut.squad_id, us.user_id, ut.match_id, m.match_number,
  ut.player_out_id, ut.player_in_id, ut.transferred_at
from user_transfers ut
join user_squads us on us.id = ut.squad_id
join matches     m  on m.id = ut.match_id
where us.contest_id = '3d66c13f-d7fb-497c-baff-bdc50edede61'
order by ut.transferred_at desc
limit 20;

-- 3) Has this user's CPL squad locked ANY XI yet (M1)? If not, prev.length
--    would be 0 on save, which changes what the info bar should show.
select
  uxi.match_id, m.match_number, uxi.player_id, pl.name, uxi.is_captain, uxi.is_vc
from user_match_xi uxi
join user_squads us on us.id = uxi.squad_id
join profiles    p  on p.id = us.user_id
join matches     m  on m.id = uxi.match_id
join players     pl on pl.id = uxi.player_id
where p.email = 'abhi0818@gmail.com'
  and us.contest_id = '3d66c13f-d7fb-497c-baff-bdc50edede61'
order by m.match_number desc;

-- 4) CPL matches list — confirm M1/M2's real id/status/start_time.
select m.id, m.match_number, m.status, m.start_time
from matches m
where m.tournament_id = 'b434446d-f817-4fe3-a930-cedc88084b24'
order by m.match_number;
