-- Scoped to the confirmed MLC squad: 1babca00-f4f3-42db-865f-c93ebe0bc6b6

-- C) Locked XI for M30 (real baseline) and M31 (suspect lock), with captain/vc.
select
  m.match_number,
  p.name as player_name,
  umx.player_id,
  umx.is_captain,
  umx.is_vc
from user_match_xi umx
join matches m on m.id = umx.match_id
join players p on p.id = umx.player_id
where umx.squad_id = '1babca00-f4f3-42db-865f-c93ebe0bc6b6'
and m.match_number in (30, 31)
order by m.match_number, umx.is_captain desc, umx.is_vc desc, p.name;

-- D) Transfers actually logged against M31.
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
where ut.squad_id = '1babca00-f4f3-42db-865f-c93ebe0bc6b6'
and m.match_number = 31;

-- E) Current squad_draft_xi row (what's queued for M32 right now).
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
where sdx.squad_id = '1babca00-f4f3-42db-865f-c93ebe0bc6b6';
