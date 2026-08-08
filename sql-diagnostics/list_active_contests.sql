-- List everything currently active so we can find CPL's real contest_id
-- without guessing the name string. Read-only.

select
  c.id            as contest_id,
  c.name          as contest_name,
  c.contest_type,
  c.is_active,
  c.tournament_id,
  t.name          as tournament_name,
  c.start_match_number,
  c.playoff_start_match_number,
  c.total_transfers_allowed,
  c.free_transfers_per_match
from contests c
join tournaments t on t.id = c.tournament_id
where c.is_active = true
order by c.name;
