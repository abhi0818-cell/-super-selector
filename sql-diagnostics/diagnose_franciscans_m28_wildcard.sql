-- Diagnose: Franciscans squad — Wildcard used for M27, appears "on by
-- default" for M28 even after removing it, and M28's transfers aren't
-- being counted (bypassTransfers stuck true).

-- A) Resolve the squad + its contest + M27/M28's real match ids/status.
select
  us.id as squad_id,
  us.contest_id,
  c.available_boosters,
  c.total_transfers_allowed
from user_squads us
join contests c on c.id = us.contest_id
where us.name ilike '%franciscans%';

-- B) Every booster activation for this squad, with match context — this is
-- the key one: check whether Wildcard's row is tied to M27's id or M28's id.
select
  uba.booster,
  uba.match_id,
  m.match_number,
  m.status,
  m.lock_time,
  m.start_time
from user_booster_activations uba
join matches m on m.id = uba.match_id
where uba.squad_id = (select id from user_squads where name ilike '%franciscans%' limit 1)
order by m.match_number;

-- C) user_transfers rows for M28 specifically (squad_id + match M28) — are
-- any rows present at all, and is match_id here really M28 or something else?
select
  ut.*,
  m.match_number
from user_transfers ut
join matches m on m.id = ut.match_id
where ut.squad_id = (select id from user_squads where name ilike '%franciscans%' limit 1)
order by m.match_number, ut.id;

-- D) squad_draft_xi's target_match_id — for web parity checks; on mobile this
-- is just a mirror, but worth seeing if it's pointing at the id you expect.
select squad_id, target_match_id, pending_booster, pending_booster_match_id, updated_at
from squad_draft_xi
where squad_id = (select id from user_squads where name ilike '%franciscans%' limit 1);
