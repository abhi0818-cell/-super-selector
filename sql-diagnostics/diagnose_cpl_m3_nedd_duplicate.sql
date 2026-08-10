-- Diagnose: CPL M3 fantasy scorecard shows both "Darren Nedd" and "Darron
-- Nedd" scoring points — 23 players credited instead of the expected 22.
-- The CPL squad list only has one Nedd batter (Darren Nedd, SLK); "Darron"
-- is a one-letter misspelling, so this is almost certainly the classic
-- pattern from diagnose_true_duplicate_merges.sql: a scorecard source spelled
-- the name "Darron", the unmatched-name resolver hit "+ Add" instead of "Map
-- to existing player", and a second players row was created — which is why
-- no review line ever appeared for it (it fully "resolved," just to the
-- wrong/new id instead of getting flagged).

-- 1. Confirm both rows exist and see their ids/team/role.
select id, name, team_id, role, is_overseas
from players
where name ilike '%nedd%';

-- 2. Confirm the CPL M3 match_id.
select id as match_id, tournament_id, match_number, home_team_id, away_team_id, status, format
from matches
where match_number = 3
  and tournament_id in (select id from tournaments where name ilike '%CPL%');

-- 3. Which of the two Nedd ids actually got scored in M3, and with what stats?
--    (Swap in the real match_id from step 2 if you want to scope it further.)
select pms.match_id, pms.player_id, p.name, p.team_id, pms.batting, pms.bowling, pms.raw_points, pms.source
from player_match_stats pms
join players p on p.id = pms.player_id
where p.name ilike '%nedd%';

-- 4. Sanity check on the "23 players scored" claim — full scorer count for
--    M3. Should be 22 (or 24 only if this were IPL).
select pms.match_id, count(*) as scored_player_count
from player_match_stats pms
where pms.match_id = (
  select id from matches
  where match_number = 3
    and tournament_id in (select id from tournaments where name ilike '%CPL%')
)
group by pms.match_id;

-- 5. Why didn't this hit the review queue? Check both places a name variant
--    would normally get flagged.
select * from scraper_unmatched where raw_name ilike '%nedd%';
select * from player_name_aliases where alias ilike '%nedd%';

-- 6. Usage inventory for whichever id turns out to be the accidental
--    duplicate — run once you know keep_id vs drop_id from steps 1 & 3.
-- select 'tournament_players', count(*) from tournament_players where player_id = '<drop_id>'
-- union all select 'player_match_stats', count(*) from player_match_stats where player_id = '<drop_id>'
-- union all select 'user_match_xi', count(*) from user_match_xi where player_id = '<drop_id>'
-- union all select 'user_team_players', count(*) from user_team_players where player_id = '<drop_id>';
