-- Diagnose: leaderboard shows squad "nav11" with 608 points — sanity-check
-- whether that's real (sum of legitimate per-match scores) or inflated by
-- duplicate rows / a duplicate squad / shared-league double-counting.
-- Read-only.

-- 1) Find the squad(s) — team_name or user_squads.name might both say "nav11".
--    More than one row here would itself explain an inflated leaderboard total
--    (getLeaderboardSL sums per squad_id, but if two squads both exist for the
--    same real team, only one shows on the board while scores could be split
--    or duplicated between them).
select
  us.id as squad_id,
  us.name as squad_name,
  us.user_id,
  us.contest_id,
  us.primary_squad_id,
  p.team_name,
  p.display_name,
  p.email
from user_squads us
join profiles p on p.id = us.user_id
where p.team_name ilike '%nav11%' or us.name ilike '%nav11%' or p.display_name ilike '%nav11%';

-- 2) Per-match score rows for that squad — look for MULTIPLE rows for the
--    SAME (squad_id, match_id) pair (should be exactly one aggregate row per
--    match per the leaderboard's summing logic) or an implausible number of
--    scored matches for how far the season has gotten.
select
  uxs.squad_id,
  uxs.match_id,
  m.match_number,
  count(*) as row_count,
  sum(uxs.total_points) as points_this_match
from user_match_xi_scores uxs
join matches m on m.id = uxs.match_id
where uxs.squad_id in (
  select us.id from user_squads us
  join profiles p on p.id = us.user_id
  where p.team_name ilike '%nav11%' or us.name ilike '%nav11%' or p.display_name ilike '%nav11%'
)
group by uxs.squad_id, uxs.match_id, m.match_number
order by m.match_number;

-- 3) Running total, to see which match(es) the inflation shows up on.
select
  m.match_number,
  sum(uxs.total_points) as match_points,
  sum(sum(uxs.total_points)) over (order by m.match_number) as running_total
from user_match_xi_scores uxs
join matches m on m.id = uxs.match_id
where uxs.squad_id in (
  select us.id from user_squads us
  join profiles p on p.id = us.user_id
  where p.team_name ilike '%nav11%' or us.name ilike '%nav11%' or p.display_name ilike '%nav11%'
)
group by m.match_number
order by m.match_number;

-- 4) Compare against a "normal" squad for the same matches, as a sanity gut-check.
-- (Run manually with a known-good squad_id if the above looks off.)
