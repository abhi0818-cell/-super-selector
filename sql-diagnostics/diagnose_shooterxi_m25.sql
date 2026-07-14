-- Disambiguate: two ShooterXI squads (different contests) and three M25 rows
-- (different tournaments) showed up. Figure out which contest/match is the
-- live one being asked about before inserting anything.

-- A) Which of the three "M25" matches is actually live right now, and what
--    tournament/format is it?
select
  m.id            as match_id,
  m.match_number,
  m.tournament_id,
  t.name          as tournament_name,
  m.status,
  m.start_time,
  m.lock_time,
  m.home_team_id,
  m.away_team_id
from matches m
join tournaments t on t.id = m.tournament_id
where m.match_number = 25
order by m.start_time;

-- B) The two ShooterXI squads — which contest/tournament each belongs to,
--    and whether that contest even offers team_double.
select
  us.id            as squad_id,
  us.contest_id,
  c.name           as contest_name,
  c.tournament_id,
  t.name           as tournament_name,
  c.available_boosters
from user_squads us
join contests    c on c.id = us.contest_id
join tournaments t on t.id = c.tournament_id
join profiles    p on p.id = us.user_id
where p.team_name = 'ShooterXI';
