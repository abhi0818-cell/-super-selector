-- What transfers actually landed for abhi0818@gmail.com, across all their
-- squads/contests, so we can see whether the DB really only logged one row
-- or if it's a display/filter issue.

select
  ut.id,
  ut.squad_id,
  us.contest_id,
  c.name            as contest_name,
  ut.match_id,
  m.match_number,
  ut.player_out_id,
  po.name           as player_out,
  ut.player_in_id,
  pi.name           as player_in,
  ut.is_free,
  ut.points_deducted,
  ut.transferred_at
from user_transfers ut
join user_squads us on us.id = ut.squad_id
join contests    c  on c.id = us.contest_id
join profiles    p  on p.id = us.user_id
join matches     m  on m.id = ut.match_id
left join players po on po.id = ut.player_out_id
left join players pi on pi.id = ut.player_in_id
where p.email = 'abhi0818@gmail.com'
order by ut.transferred_at desc;

-- Also show the currently locked XI for whichever match you just saved, so
-- we can compare "who's actually in the XI now" against "how many transfer
-- rows exist for that match" — if the XI shows 3 new players but only 1
-- transfer row exists above, that confirms rows are missing rather than
-- just being mis-displayed.
select
  uxi.match_id,
  m.match_number,
  uxi.player_id,
  pl.name,
  uxi.is_captain,
  uxi.is_vc
from user_match_xi uxi
join user_squads us on us.id = uxi.squad_id
join profiles    p  on p.id = us.user_id
join matches     m  on m.id = uxi.match_id
join players     pl on pl.id = uxi.player_id
where p.email = 'abhi0818@gmail.com'
order by m.match_number desc, uxi.is_captain desc, uxi.is_vc desc;
