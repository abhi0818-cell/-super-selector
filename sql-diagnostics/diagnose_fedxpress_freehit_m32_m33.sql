-- Fedxpress (note spelling — no "e") squad_id: 5f3b82ad-3fb5-496e-9771-857d408936d9
-- contest_id: 4bdbf63d-90fd-4056-9fad-3d626a23369b (MLC Season Long — same
-- contest as the MasterBlaster M31 incident already in this folder)

-- A) Matches for this contest's tournament — M31/M32/M33 only.
select id, match_number, status, lock_time, start_time
from matches
where tournament_id = (select tournament_id from contests where id = '4bdbf63d-90fd-4056-9fad-3d626a23369b')
  and match_number in (31, 32, 33)
order by match_number;

-- B) Current draft state — THE key check. target_match_id vs M33's id, and
--    what player_ids currently holds.
select
  sdx.squad_id,
  sdx.target_match_id,
  m.match_number as target_match_number,
  sdx.player_ids,
  sdx.captain_id,
  sdx.vc_id,
  sdx.pending_booster,
  sdx.pending_booster_match_id,
  sdx.updated_at
from squad_draft_xi sdx
left join matches m on m.id = sdx.target_match_id
where sdx.squad_id = '5f3b82ad-3fb5-496e-9771-857d408936d9';

-- C) What's actually locked for M31 and M32 right now (ground truth XIs).
select
  m.match_number,
  p.name,
  umx.player_id,
  umx.is_captain,
  umx.is_vc
from user_match_xi umx
join matches m on m.id = umx.match_id
join players p on p.id = umx.player_id
where umx.squad_id = '5f3b82ad-3fb5-496e-9771-857d408936d9'
  and m.match_number in (31, 32)
order by m.match_number, umx.is_captain desc, umx.is_vc desc;

-- D) Free Hit activation + stored snapshot for M32 — confirms whether the
--    pre-free-hit (M31) baseline was actually captured, and what's in it.
select
  uba.match_id,
  m.match_number,
  uba.booster,
  uba.snapshot
from user_booster_activations uba
join matches m on m.id = uba.match_id
where uba.squad_id = '5f3b82ad-3fb5-496e-9771-857d408936d9'
order by m.match_number;
