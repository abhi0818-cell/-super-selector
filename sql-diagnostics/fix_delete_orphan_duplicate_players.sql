-- Deletes only the SAFE_DELETE bucket from classify_duplicate_players.sql:
-- duplicate-name player rows with ZERO usage anywhere (not rostered to any
-- tournament, no saved XI, no scored stats, no team rows, no transfers, not
-- referenced in any squad's current draft) — pure orphans, almost certainly
-- created by re-importing a roster with `id` left blank for someone who
-- already existed (see admin.js buildCsvRows/addPlayerHandler — both now
-- block this going forward, but these already slipped through).
--
-- Does NOT touch any row with real usage — those need find_duplicate_players.sql
-- / classify_duplicate_players.sql's NEEDS_REVIEW rows reviewed by hand first.
--
-- players is referenced with ON DELETE RESTRICT from several tables (see
-- schema.sql / migration_v2_squads_transfers.sql) — if any id here is
-- secretly still referenced somewhere this script didn't check, the DELETE
-- for that specific id will fail with a foreign-key error rather than
-- silently doing anything destructive. player_name_aliases cascades (fine to
-- lose an alias for a row that's otherwise entirely unused).
--
-- RUN classify_duplicate_players.sql FIRST and review its SAFE_DELETE rows
-- (should be roughly half the duplicate rows, all showing 0 in every usage
-- column) before running this. This script deletes exactly that same set —
-- identical CTEs, just DELETE instead of SELECT.

begin;

with norm as (
  select id, name,
    lower(regexp_replace(trim(name), '\s+', ' ', 'g')) as norm_name
  from players
),
dupes as (
  select norm_name from norm group by norm_name having count(*) > 1
),
usage as (
  select
    n.id, n.name,
    (select count(*) from tournament_players tp where tp.player_id = n.id)   as rosters,
    (select count(*) from user_match_xi umx     where umx.player_id = n.id) as xi_rows,
    (select count(*) from player_match_stats pms where pms.player_id = n.id) as scored,
    (select count(*) from user_team_players utp where utp.player_id = n.id) as team_rows,
    (select count(*) from user_transfers ut where ut.player_out_id = n.id or ut.player_in_id = n.id) as xfer_rows,
    (select count(*) from squad_draft_xi sdx
       where sdx.captain_id = n.id or sdx.vc_id = n.id or sdx.player_ids @> array[n.id]) as draft_rows
  from norm n
  join dupes d on d.norm_name = n.norm_name
),
safe_delete_ids as (
  select id from usage
  where rosters = 0 and xi_rows = 0 and scored = 0 and team_rows = 0 and xfer_rows = 0 and draft_rows = 0
)
delete from players
where id in (select id from safe_delete_ids);

-- 3. Verify — re-run find_duplicate_players.sql after this commits; the
--    remaining groups should only be the ones classify_duplicate_players.sql
--    marked NEEDS_REVIEW or KEEP.

commit;
