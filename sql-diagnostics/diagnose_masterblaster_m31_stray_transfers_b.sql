-- Which of the two "MasterBlaster" squads is the MLC Season Long one?
select
  us.id as squad_id,
  us.contest_id,
  t.id as tournament_id,
  t.name as tournament_name,
  c.contest_type,
  c.total_transfers_allowed
from user_squads us
join contests c on c.id = us.contest_id
join tournaments t on t.id = c.tournament_id
where us.name ilike '%masterblaster%';
