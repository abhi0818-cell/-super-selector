-- Diagnose: booster appears still "active" for M32 after it was used in M31.
-- Squad: 1babca00-f4f3-42db-865f-c93ebe0bc6b6 (MLC Season Long, MasterBlaster)

-- A) Contest's configured booster uses — confirms whether each booster is
--    really capped at 1 use, or something looser is configured.
select c.id as contest_id, c.name, c.available_boosters
from contests c
where c.id = '4bdbf63d-90fd-4056-9fad-3d626a23369b';

-- B) Every booster activation row for this squad, with match context — is
--    there one row (M31 only, correct) or two (M31 AND M32, the bug)?
select
  uba.booster,
  uba.match_id,
  m.match_number,
  m.status,
  m.lock_time,
  m.start_time
from user_booster_activations uba
join matches m on m.id = uba.match_id
where uba.squad_id = '1babca00-f4f3-42db-865f-c93ebe0bc6b6'
order by m.match_number;
