-- All booster activations for ShooterXI (MLC Season Long), squad_id
-- a5c2cde4-71e6-43bb-9be4-8876d75987d6, plus a per-booster-type count against
-- the contest's allowed uses (available_boosters), so you can see both what's
-- been used and how much is left of each.

-- A) Every activation, with match context.
select
  uba.booster,
  m.match_number,
  m.status,
  m.start_time,
  uba.match_id
from user_booster_activations uba
join matches m on m.id = uba.match_id
where uba.squad_id = 'a5c2cde4-71e6-43bb-9be4-8876d75987d6'
order by m.match_number;

-- B) Count used vs. allowed, per booster type.
select
  b.booster,
  count(uba.*) as times_used,
  (c.available_boosters->>b.booster)::int as uses_allowed
from (values ('triple_captain'), ('dual_captain'), ('team_double'),
             ('os_double'), ('indian_double'), ('wildcard'), ('free_hit')) as b(booster)
cross join (
  select available_boosters from contests where id = '4bdbf63d-90fd-4056-9fad-3d626a23369b'
) c
left join user_booster_activations uba
  on uba.squad_id = 'a5c2cde4-71e6-43bb-9be4-8876d75987d6'
 and uba.booster = b.booster
group by b.booster, c.available_boosters
order by b.booster;
