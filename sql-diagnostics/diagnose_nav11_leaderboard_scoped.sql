-- Diagnose: nav11's leaderboard points, scoped to ONE specific contest (MLC
-- Season Long) — the earlier diagnose_nav11_leaderboard.sql query wasn't
-- contest-scoped, so if nav11 has squads in more than one contest, its
-- "running total" summed scores across ALL of them, not just the one shown
-- on this leaderboard. Read-only.

-- 1) The exact squad row the MLC leaderboard is scoring, and whether nav11
--    has any OTHER squads elsewhere (for context only — not summed below).
select
  us.id as squad_id,
  us.name as squad_name,
  us.contest_id,
  c.name as contest_name,
  c.contest_type
from user_squads us
join contests c on c.id = us.contest_id
join profiles p on p.id = us.user_id
where p.team_name ilike '%nav11%' or us.name ilike '%nav11%' or p.display_name ilike '%nav11%';

-- 2) Raw score sum for ONLY the MLC Season Long squad — this is what
--    getLeaderboardSL actually sums as "rawPts" before subtracting penalty.
select
  m.match_number,
  sum(uxs.total_points) as match_points,
  sum(sum(uxs.total_points)) over (order by m.match_number) as running_total
from user_match_xi_scores uxs
join matches m on m.id = uxs.match_id
where uxs.squad_id = (
  select us.id from user_squads us
  where us.contest_id = '4bdbf63d-90fd-4056-9fad-3d626a23369b'
    and us.id in (
      select us2.id from user_squads us2
      join profiles p on p.id = us2.user_id
      where p.team_name ilike '%nav11%' or us2.name ilike '%nav11%' or p.display_name ilike '%nav11%'
    )
  limit 1
)
group by m.match_number
order by m.match_number;

-- 3) Total transfer-penalty points for that same squad — leaderboard points
--    = rawPts (query 2's final running_total) minus this sum.
select sum(points_deducted) as total_penalty
from user_transfers
where squad_id = (
  select us.id from user_squads us
  where us.contest_id = '4bdbf63d-90fd-4056-9fad-3d626a23369b'
    and us.id in (
      select us2.id from user_squads us2
      join profiles p on p.id = us2.user_id
      where p.team_name ilike '%nav11%' or us2.name ilike '%nav11%' or p.display_name ilike '%nav11%'
    )
  limit 1
);
