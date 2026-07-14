-- nav11's MLC Season Long match-by-match totals.
-- squad_id c9ca135b-8ddb-40e4-b179-ec71360c8ff9 (confirmed MLC squad, not the IPL one).
-- Read-only.

with pts as (
  select
    uxs.match_id,
    m.match_number,
    sum(uxs.total_points) as raw_points
  from user_match_xi_scores uxs
  join matches m on m.id = uxs.match_id
  where uxs.squad_id = 'c9ca135b-8ddb-40e4-b179-ec71360c8ff9'
  group by uxs.match_id, m.match_number
),
pen as (
  select
    ut.match_id,
    sum(ut.points_deducted) as penalty
  from user_transfers ut
  where ut.squad_id = 'c9ca135b-8ddb-40e4-b179-ec71360c8ff9'
  group by ut.match_id
)
select
  pts.match_number,
  pts.raw_points,
  coalesce(pen.penalty, 0) as penalty,
  pts.raw_points - coalesce(pen.penalty, 0) as net_points,
  sum(pts.raw_points - coalesce(pen.penalty, 0)) over (order by pts.match_number) as running_total
from pts
left join pen on pen.match_id = pts.match_id
order by pts.match_number;
