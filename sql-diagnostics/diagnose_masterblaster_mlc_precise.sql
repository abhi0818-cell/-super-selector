-- Precise, unambiguous checks for MasterBlaster's MLC Season Long squad only:
--   squad_id  = 1babca00-f4f3-42db-865f-c93ebe0bc6b6
--   contest_id= 4bdbf63d-90fd-4056-9fad-3d626a23369b  (MLC Season Long)

-- A) MLC matches 23-27, real times/status.
select id as match_id, match_number, status, start_time, lock_time
from matches
where tournament_id = 'fd011ab4-43cf-4e3e-a97d-4de297a1558d'
  and match_number in (23, 24, 25, 26, 27)
order by match_number;

-- B) Locked XI rows for THIS squad only, MLC matches 23-27 — confirms
--    exactly which matches actually locked and which are missing.
select uxi.match_id, m.match_number, count(*) as players_locked
from user_match_xi uxi
join matches m on m.id = uxi.match_id
where uxi.squad_id = '1babca00-f4f3-42db-865f-c93ebe0bc6b6'
  and m.tournament_id = 'fd011ab4-43cf-4e3e-a97d-4de297a1558d'
  and m.match_number in (23, 24, 25, 26, 27)
group by uxi.match_id, m.match_number
order by m.match_number;

-- C) Current draft state + last-saved timestamp for this squad.
select *
from squad_draft_xi
where squad_id = '1babca00-f4f3-42db-865f-c93ebe0bc6b6';

-- D) Transfers logged against M26 for this squad specifically.
select ut.*
from user_transfers ut
join matches m on m.id = ut.match_id
where ut.squad_id = '1babca00-f4f3-42db-865f-c93ebe0bc6b6'
  and m.match_number = 26
  and m.tournament_id = 'fd011ab4-43cf-4e3e-a97d-4de297a1558d';

-- E) The actual last-locked XI before M25, for this squad — this is the
--    baseline getPreviousMatchXI() would have used for M26's transfer diff
--    if M25 never locked.
select uxi.match_id, m.match_number, uxi.player_id, pl.name, uxi.is_captain, uxi.is_vc
from user_match_xi uxi
join matches m on m.id = uxi.match_id
join players pl on pl.id = uxi.player_id
where uxi.squad_id = '1babca00-f4f3-42db-865f-c93ebe0bc6b6'
  and m.tournament_id = 'fd011ab4-43cf-4e3e-a97d-4de297a1558d'
  and m.match_number = (
    select max(m2.match_number)
    from user_match_xi uxi2
    join matches m2 on m2.id = uxi2.match_id
    where uxi2.squad_id = '1babca00-f4f3-42db-865f-c93ebe0bc6b6'
      and m2.tournament_id = 'fd011ab4-43cf-4e3e-a97d-4de297a1558d'
      and m2.match_number < 25
  )
order by uxi.is_captain desc, uxi.is_vc desc;
