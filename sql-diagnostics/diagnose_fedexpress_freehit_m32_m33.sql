-- Diagnose: Free Hit used on M32 not reverting to M31's baseline for M33.
--
-- v2: the first pass (name ilike on user_squads.name) returned zero rows —
-- "Fedexpress" is very likely the user's profiles.team_name (the persistent
-- leaderboard identity added in migration_v33), not the internal
-- user_squads.name column (which defaults to 'My Squad' and often never gets
-- renamed). This version resolves the squad via profiles instead.
--
-- Also: section B of the first pass returned SIX rows for match_number
-- 31/32/33 — two tournaments both using the same match numbering. Only one
-- of the M33 rows is `scheduled` with a real start_time
-- (05eea7b1-e196-468e-85ba-dc8290cb721f, 2026-07-17 01:30 UTC) — that's
-- almost certainly tonight's lock. This version scopes every query to
-- Fedexpress's own contest/tournament so we're not looking at the wrong
-- tournament's matches.

-- A) Resolve the user + squad via profiles.team_name / display_name.
select p.id as user_id, p.team_name, p.display_name, p.email,
       us.id as squad_id, us.name as squad_internal_name, us.contest_id,
       c.tournament_id, c.name as contest_name
from profiles p
join user_squads us on us.user_id = p.id
join contests   c  on c.id = us.contest_id
where p.team_name ilike '%fedexpress%'
   or p.display_name ilike '%fedexpress%';

-- If (A) still returns nothing, Fedexpress may be a private-league *shared*
-- squad (primary_squad_id set) rather than the season's primary squad — try:
-- select * from user_squads where name ilike '%fedexpress%';
-- select id, team_name, display_name, email from profiles where team_name ilike '%fedex%' or display_name ilike '%fedex%' or email ilike '%fedex%';

-- B) M31 / M32 / M33 for Fedexpress's OWN tournament only (replace
--    :tournament_id with the value from (A), or leave the subquery as-is
--    once (A) resolves).
select id, match_number, status, lock_time, start_time
from matches
where tournament_id = (
        select c.tournament_id
        from profiles p
        join user_squads us on us.user_id = p.id
        join contests   c  on c.id = us.contest_id
        where p.team_name ilike '%fedexpress%' or p.display_name ilike '%fedexpress%'
        limit 1
      )
  and match_number in (31, 32, 33)
order by match_number;

-- C) Current draft state — THE key check. Is target_match_id already M33's
--    id? What content does it hold right now?
select
  sdx.squad_id,
  sdx.target_match_id,
  m.match_number   as target_match_number,
  sdx.player_ids,
  sdx.captain_id,
  sdx.vc_id,
  sdx.pending_booster,
  sdx.pending_booster_match_id,
  sdx.updated_at
from squad_draft_xi sdx
left join matches m on m.id = sdx.target_match_id
where sdx.squad_id = (
  select us.id
  from profiles p
  join user_squads us on us.user_id = p.id
  where p.team_name ilike '%fedexpress%' or p.display_name ilike '%fedexpress%'
  limit 1
);

-- D) What's actually locked for M31 and M32 right now (ground truth XIs).
select
  m.match_number,
  p2.name,
  umx.player_id,
  umx.is_captain,
  umx.is_vc
from user_match_xi umx
join matches  m  on m.id = umx.match_id
join players  p2 on p2.id = umx.player_id
where umx.squad_id = (
  select us.id
  from profiles p
  join user_squads us on us.user_id = p.id
  where p.team_name ilike '%fedexpress%' or p.display_name ilike '%fedexpress%'
  limit 1
)
and m.match_number in (31, 32)
order by m.match_number, umx.is_captain desc, umx.is_vc desc;

-- E) Free Hit activation + stored snapshot for M32 — confirms whether the
--    pre-free-hit (M31) baseline was actually captured, and what it contains.
select
  uba.match_id,
  m.match_number,
  uba.booster,
  uba.snapshot
from user_booster_activations uba
join matches m on m.id = uba.match_id
where uba.squad_id = (
  select us.id
  from profiles p
  join user_squads us on us.user_id = p.id
  where p.team_name ilike '%fedexpress%' or p.display_name ilike '%fedexpress%'
  limit 1
)
order by m.match_number;
