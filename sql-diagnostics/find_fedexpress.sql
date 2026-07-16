-- Broad search: "Fedexpress" isn't matching team_name/display_name as a
-- contiguous substring. Likely causes: a space/casing variant ("Fed Express",
-- "FedExpress FC"), it's stored on user_squads.name instead, or it only shows
-- up via user_metadata (never synced to profiles). Cast a wide net.

-- 1. Split-word search across profiles (catches "Fed Express", "FedExpress11", etc.)
select id, team_name, display_name, email, updated_at
from profiles
where team_name    ilike '%fed%'
   or team_name    ilike '%express%'
   or display_name ilike '%fed%'
   or display_name ilike '%express%'
   or email        ilike '%fed%'
   or email        ilike '%express%';

-- 2. Same split-word search on user_squads.name directly (in case the squad
--    itself was renamed and that's the "Fedexpress" identity, independent of
--    the owning profile's team_name).
select id, user_id, name, contest_id, created_at
from user_squads
where name ilike '%fed%'
   or name ilike '%express%';

-- 3. All season_long squads with their owning profile's identity fields side
--    by side, sorted by most recently active — useful to eyeball if
--    Fedexpress just isn't spelled the way we assumed.
select
  us.id as squad_id, us.name as squad_name, us.updated_at as squad_updated_at,
  p.team_name, p.display_name, p.email
from user_squads us
left join profiles p on p.id = us.user_id
join contests c on c.id = us.contest_id
where c.contest_type = 'season_long'
order by us.updated_at desc
limit 50;
