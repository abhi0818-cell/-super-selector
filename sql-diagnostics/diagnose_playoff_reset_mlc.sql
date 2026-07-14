-- Diagnose: MLC SL contest playoff transfer reset not taking effect.
-- Read-only. Run in Supabase SQL editor.

-- 1) Confirm the contest's phase config actually saved as expected
--    (Start=31, Budget=blank/NULL per what you set in the admin panel).
select
  c.id,
  c.name,
  c.contest_type,
  c.start_match_number,
  c.playoff_start_match_number,
  c.total_transfers_allowed,
  c.playoff_transfers_allowed,
  c.playoff_first_match_unlimited
from contests c
where c.name ilike '%MLC%'
  and c.contest_type = 'season_long';

-- 2) Confirm the *actual* match_number stored for "M31"-"M34" matches this
--    tournament's matches table — a mismatch here (e.g. match_number is NULL,
--    or "M31" the label doesn't equal integer 31) is the #1 cause of the
--    phase check silently staying in 'regular'.
select
  m.id,
  m.match_number,
  m.status,
  m.start_time,
  t.name as tournament_name
from matches m
join tournaments t on t.id = m.tournament_id
where t.name ilike '%Major%'
order by m.match_number;

-- 3) For abhi0818@gmail.com specifically: what phase would the app compute
--    for M31 right now, and how many transfer rows already exist that would
--    get scoped into 'playoff' vs 'regular'.
select
  ut.id,
  us.contest_id,
  c.name as contest_name,
  ut.match_id,
  m.match_number,
  case
    when c.playoff_start_match_number is not null
     and m.match_number >= c.playoff_start_match_number then 'playoff'
    when c.start_match_number is not null
     and m.match_number > c.start_match_number then 'regular'
    else 'pre_season/other'
  end as computed_phase,
  ut.transferred_at
from user_transfers ut
join user_squads us on us.id = ut.squad_id
join contests    c  on c.id = us.contest_id
join profiles    p  on p.id = us.user_id
join matches     m  on m.id = ut.match_id
where p.email = 'abhi0818@gmail.com'
  and c.name ilike '%MLC%'
order by m.match_number desc;
