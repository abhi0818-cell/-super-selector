-- Find likely duplicate player rows — e.g. created by leaving `id` blank on
-- a CSV import row (or "Add Player") for someone who already existed under a
-- different id, instead of mapping to the existing row. buildCsvRows()/
-- addPlayerHandler() in admin.js only dedupe on id, never on name — nothing
-- stops a second row for the same real person going in under a new id.
--
-- Groups players by a normalized name (lowercased, whitespace-collapsed) and
-- shows every id in that group, plus how much each id is actually USED
-- elsewhere — tournament rosters, saved XIs, scored stats, transfers. The id
-- with real usage is almost always the "real" one to keep; an id with all
-- zeros is almost always the accidental duplicate, safe to fold in.

with norm as (
  select
    id, name, team_id, role, credits, is_overseas,
    lower(regexp_replace(trim(name), '\s+', ' ', 'g')) as norm_name
  from players
),
dupes as (
  select norm_name
  from norm
  group by norm_name
  having count(*) > 1
)
select
  n.norm_name,
  n.id,
  n.name,
  n.team_id,
  n.role,
  n.credits,
  n.is_overseas,
  (select count(*) from tournament_players tp where tp.player_id = n.id)   as tournament_rosters,
  (select count(*) from user_match_xi umx     where umx.player_id = n.id) as saved_xi_rows,
  (select count(*) from player_match_stats pms where pms.player_id = n.id) as scored_matches,
  (select count(*) from user_team_players utp where utp.player_id = n.id) as team_rows,
  (select count(*) from user_transfers ut where ut.player_out_id = n.id or ut.player_in_id = n.id) as transfer_rows
from norm n
join dupes d on d.norm_name = n.norm_name
order by n.norm_name, n.id;
