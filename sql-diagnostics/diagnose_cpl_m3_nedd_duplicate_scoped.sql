-- Follow-up to diagnose_cpl_m3_nedd_duplicate.sql. Step 1 showed only one
-- Nedd player row (p22 Darren Nedd) — no duplicate players row. Step 5 showed
-- a player_name_aliases row "darron nedd" -> p22, source cricketaddictor,
-- created TODAY (tournament b434446d-f817-4fe3-a930-cedc88084b24) — almost
-- certainly the M3 scoring run. Step 3's data wasn't scoped to one match, so
-- it can't show whether p22 has TWO player_match_stats rows for the SAME
-- match_id (one per source) — which would explain the scorecard showing him
-- twice under two different display names. This scopes it down.

-- 1. Pin down the exact M3 match_id using the tournament_id from the alias.
select id as match_id, tournament_id, match_number, home_team_id, away_team_id, status, format
from matches
where tournament_id = 'b434446d-f817-4fe3-a930-cedc88084b24'
  and match_number = 3;

-- 2. All player_match_stats rows for p22, scoped to that match_id — if this
--    returns MORE THAN ONE ROW, that's the duplicate (one row per source
--    for the same player/match, and the scorecard isn't collapsing them).
select pms.match_id, pms.player_id, p.name, pms.batting, pms.bowling, pms.raw_points, pms.source
from player_match_stats pms
join players p on p.id = pms.player_id
where pms.player_id = 'p22'
  and pms.match_id = (
    select id from matches
    where tournament_id = 'b434446d-f817-4fe3-a930-cedc88084b24' and match_number = 3
  );

-- 3. Full scorer list for M3 — total row count vs distinct player count.
--    If row count = 23 and distinct player count = 22, that confirms it's
--    exactly one player (p22) double-counted, not 23 genuinely different ids.
select count(*) as total_rows, count(distinct pms.player_id) as distinct_players
from player_match_stats pms
where pms.match_id = (
  select id from matches
  where tournament_id = 'b434446d-f817-4fe3-a930-cedc88084b24' and match_number = 3
);

-- 4. Confirm whether the table's unique constraint includes `source` (which
--    would explain how two rows for the same match+player are even allowed
--    to coexist in the first place).
select conname, pg_get_constraintdef(oid)
from pg_constraint
where conrelid = 'player_match_stats'::regclass
  and contype in ('u', 'p');
