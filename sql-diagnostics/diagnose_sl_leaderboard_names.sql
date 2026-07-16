-- Lists every Season Long squad in the MLC Season Long contest alongside the
-- exact profile fields getLeaderboardSL()/resolvePersonName() use to build
-- the leaderboard's two name lines:
--   bold line  = user_squads.name          (squad_name below)
--   sub line   = resolvePersonName(profile) = first+last name, else
--                display_name (if it differs from team_name), else email
--
-- Run this to see WHY a given row's sub-line still matches (or nearly
-- matches) the squad name — either the account genuinely has no first/last
-- name and no distinct display_name on file (a data gap, not a code bug),
-- or something else is going on that this makes visible.

select
  us.name        as squad_name,
  us.user_id,
  p.first_name,
  p.last_name,
  p.display_name,
  p.team_name,
  p.email,
  -- Mirrors resolvePersonName()'s exact logic so you can see the computed
  -- result without re-deploying anything.
  case
    when nullif(trim(concat_ws(' ', p.first_name, p.last_name)), '') is not null
      then trim(concat_ws(' ', p.first_name, p.last_name))
    when p.display_name is not null and p.display_name is distinct from p.team_name
      then p.display_name
    else coalesce(p.email, left(p.id::text, 8))
  end as resolved_sub_line
from user_squads us
join contests c on c.id = us.contest_id
left join profiles p on p.id = us.user_id
where c.name = 'MLC Season Long'
order by us.name;
