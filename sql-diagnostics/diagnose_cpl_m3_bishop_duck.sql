-- Diagnose: CPL M3, Joshua Bishop shows a duck penalty despite being a bowler.
-- The scoring engine's duck check is `isDismissed && runs === 0 && role !== 'bowl'`
-- (scoringEngine.shared.js:283), and players.role is DB-constrained to
-- 'wk'|'bat'|'ar'|'bowl' — so if the penalty is firing, either (a) his stored
-- role isn't 'bowl', or (b) the scraper matched his innings to the wrong
-- player_id. Run each block below in the Supabase SQL editor and compare.

-- 1. Is there more than one "Joshua Bishop" (or a near-duplicate) in players,
--    and what role does each have? A duplicate is the classic cause of a
--    scraper resolving to the wrong id.
select id, name, role, is_overseas
from players
where name ilike '%bishop%';

-- 2. Which player_id actually got credited for the batting/duck in CPL M3,
--    and what role does *that specific id* have? (Swap in the real match_id
--    once you have it from step 3.)
select pms.match_id, pms.player_id, p.name, p.role, pms.batting, pms.raw_points, pms.source
from player_match_stats pms
join players p on p.id = pms.player_id
where p.name ilike '%bishop%';

-- 3. Confirm the match_id for CPL M3 and its tournament, to scope step 2/4
--    if step 2 returns rows across multiple matches/tournaments.
select id as match_id, tournament_id, match_number, home_team_id, away_team_id, status, format
from matches
where match_number = 3
  and tournament_id in (select id from tournaments where name ilike '%CPL%');

-- 4. Any unresolved/ambiguous name matches for "Bishop" in this tournament —
--    would explain the scraper silently picking the wrong candidate instead
--    of surfacing it for review.
select *
from scraper_unmatched
where raw_name ilike '%bishop%';

select *
from player_name_aliases
where alias ilike '%bishop%';
