-- Classifies every duplicate-name player row (from find_duplicate_players.sql)
-- into SAFE_DELETE (zero usage anywhere — an orphan, almost certainly created
-- by a re-import that left `id` blank for someone who already existed) versus
-- NEEDS_REVIEW (has real usage — a merge decision, not an auto-delete).
--
-- "Zero usage anywhere" checks every place a player id can appear, including
-- squad_draft_xi.player_ids/captain_id/vc_id — that column is a plain TEXT[]
-- with no foreign key, so a stale reference there wouldn't show up as a
-- delete error the way a real FK violation would.

with norm as (
  select id, name, team_id, role, credits, is_overseas,
    lower(regexp_replace(trim(name), '\s+', ' ', 'g')) as norm_name
  from players
),
dupes as (
  select norm_name from norm group by norm_name having count(*) > 1
),
usage as (
  select
    n.id, n.name, n.team_id, n.norm_name,
    (select count(*) from tournament_players tp where tp.player_id = n.id)   as rosters,
    (select count(*) from user_match_xi umx     where umx.player_id = n.id) as xi_rows,
    (select count(*) from player_match_stats pms where pms.player_id = n.id) as scored,
    (select count(*) from user_team_players utp where utp.player_id = n.id) as team_rows,
    (select count(*) from user_transfers ut where ut.player_out_id = n.id or ut.player_in_id = n.id) as xfer_rows,
    (select count(*) from squad_draft_xi sdx
       where sdx.captain_id = n.id or sdx.vc_id = n.id or sdx.player_ids @> array[n.id]) as draft_rows
  from norm n
  join dupes d on d.norm_name = n.norm_name
)
select
  norm_name, id, name, team_id,
  rosters, xi_rows, scored, team_rows, xfer_rows, draft_rows,
  case
    when rosters = 0 and xi_rows = 0 and scored = 0 and team_rows = 0 and xfer_rows = 0 and draft_rows = 0
      then 'SAFE_DELETE — zero usage anywhere'
    when (xi_rows > 0 or scored > 0 or team_rows > 0 or xfer_rows > 0 or draft_rows > 0)
      then 'NEEDS_REVIEW — has real usage, check for a sibling row with real usage too'
    else 'KEEP — rostered but not yet used (e.g. tournament hasn''t started scoring)'
  end as verdict
from usage
order by
  (case
    when rosters = 0 and xi_rows = 0 and scored = 0 and team_rows = 0 and xfer_rows = 0 and draft_rows = 0 then 2
    when (xi_rows > 0 or scored > 0 or team_rows > 0 or xfer_rows > 0 or draft_rows > 0) then 0
    else 1
  end),
  norm_name, id;
