-- Which of MasterBlaster's 4 squads is actually the "MLC Season Long" one
-- shown in the screenshot? Unambiguous, no subqueries that can silently
-- match multiple tournaments.
select
  us.id            as squad_id,
  us.contest_id,
  c.name           as contest_name,
  c.contest_type,
  c.tournament_id,
  t.name           as tournament_name,
  us.created_at
from user_squads us
join contests    c on c.id = us.contest_id
join tournaments t on t.id = c.tournament_id
join profiles    p on p.id = us.user_id
where p.team_name = 'MasterBlaster'
order by us.created_at;
