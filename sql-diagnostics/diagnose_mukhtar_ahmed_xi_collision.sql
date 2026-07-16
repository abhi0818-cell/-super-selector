-- Obus Pienaar and Ali Sheikh/Anirudh Immanuel came back clean (no collisions —
-- safe to repoint/delete). Mukhtar Ahmed (p636 vs scr_1781924937882) did NOT:
-- both ids show up in user_match_xi (and user_match_xi_scores, and
-- user_team_players) for the SAME squad + SAME match, which means that
-- squad's actual locked lineup has "Mukhtar Ahmed" occupying two different
-- roster slots at once under two different ids for at least 2 matches —
-- either a genuine accidental double-pick, or the two id's stats/points got
-- attributed inconsistently across saves. Need to see the full picture
-- before deciding the fix (a blind repoint would violate the
-- (squad_id, match_id, player_id) unique constraint anyway).
--
-- A: which squad(s), which matches.
select 'A - squad+match' as step, umx.squad_id, sq.name as squad_name,
       umx.match_id, m.match_number, umx.player_id, umx.is_captain, umx.is_vc
from user_match_xi umx
join user_squads sq on sq.id = umx.squad_id
join matches m on m.id = umx.match_id
where umx.player_id in ('p636', 'scr_1781924937882')
order by umx.squad_id, m.match_number;

-- B: the FULL 11-man locked XI for each squad+match found above, so we can
-- see whether this is really "both Mukhtar Ahmeds in the same XI" (11 slots
-- but only 10 distinct real players) or something else.
select 'B - full XI' as step, umx.squad_id, m.match_number,
       umx.player_id, p.name as player_name, p.team_id,
       umx.is_captain, umx.is_vc
from user_match_xi umx
join matches m on m.id = umx.match_id
join players p on p.id = umx.player_id
where umx.squad_id in (
  select distinct squad_id from user_match_xi where player_id in ('p636', 'scr_1781924937882')
)
and umx.match_id in (
  select distinct match_id from user_match_xi where player_id in ('p636', 'scr_1781924937882')
)
order by umx.squad_id, m.match_number, p.name;

-- C: the transfer log around these matches for the same squad(s) — did the
-- squad transfer FROM one Mukhtar Ahmed id TO the other at some point,
-- thinking they were different players?
select 'C - transfers' as step, ut.squad_id, m.match_number,
       po.name as player_out, ut.player_out_id,
       pi.name as player_in, ut.player_in_id, ut.is_free, ut.points_deducted
from user_transfers ut
join matches m on m.id = ut.match_id
left join players po on po.id = ut.player_out_id
left join players pi on pi.id = ut.player_in_id
where ut.squad_id in (
  select distinct squad_id from user_match_xi where player_id in ('p636', 'scr_1781924937882')
)
order by ut.squad_id, m.match_number;
