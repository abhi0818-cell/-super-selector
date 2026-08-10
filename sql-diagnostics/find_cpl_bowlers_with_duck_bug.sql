-- Candidate rows for the "bowler wrongly got duck penalty" bug (fixed in
-- admin.js renderFantasyScorecard/rescoreCurrentMatch/saveFantasyScorecard
-- and index.html's live CricAPI poller).
--
-- Root cause: those 4 call sites scored with the CricAPI-derived role
-- (which fromCricAPI silently promotes to 'ar' for anyone who both batted
-- AND bowled) instead of the DB role. Only role === 'bowl' is exempt from
-- the duck check, so a specialist bowler batting low-order lost his
-- exemption. The scraper's own write path was independently confirmed to
-- already use the correct DB role, so this is scoped to source = 'cricapi'
-- rows only — a scraper-sourced row matching this same shape was not
-- affected by this bug.
--
-- This is a CANDIDATE list, not a guaranteed diff — it flags every row that
-- COULD have been hit (role is bowl, dismissed for 0, cricapi-sourced). For
-- a definitive stored-vs-recomputed diff, use the admin app's "Run Score
-- Audit" (Score Audit panel) instead, which recomputes every row using the
-- already-fixed calculateScore() and role. This query is just to eyeball
-- scope/scale before running that.

select
  m.match_number,
  p.id   as player_id,
  p.name as player_name,
  p.role,
  pms.batting,
  pms.raw_points,
  pms.source,
  pms.match_id
from player_match_stats pms
join players p       on p.id = pms.player_id
join matches m        on m.id = pms.match_id
join tournaments t    on t.id = m.tournament_id
where p.role = 'bowl'
  and pms.source = 'cricapi'
  and (pms.batting->>'isDismissed')::boolean = true
  and coalesce((pms.batting->>'runs')::int, 0) = 0
  and t.name ilike '%CPL%'
order by m.match_number, p.name;
