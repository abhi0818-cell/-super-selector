-- Check dot-ball data coverage for Women's T20 WC and MLC matches.
-- Run in Supabase SQL Editor.

select
  t.name                                as tournament,
  m.match_number,
  m.status,
  m.data_source,
  t.scraper_enabled,
  m.scorecard_url,
  p.name                                as player,
  pms.source                            as stat_source,
  (pms.bowling->>'wickets')::numeric    as wkts,
  (pms.bowling->>'ballsBowled')::numeric as balls_bowled,
  (pms.bowling->>'dotBalls')::numeric   as dot_balls,
  pms.raw_points
from player_match_stats pms
join matches m       on m.id = pms.match_id
join tournaments t   on t.id = m.tournament_id
join players p       on p.id = pms.player_id
where (t.name ilike '%T20%WC%' or t.name ilike '%Women%T20%' or t.name ilike '%MLC%' or t.name ilike '%Major League%')
  and pms.bowling is not null
  and (pms.bowling->>'ballsBowled')::numeric > 0
order by t.name, m.match_number, dot_balls asc;

-- What to look for:
--   * dot_balls = 0 across the board for a whole match/tournament while
--     balls_bowled is clearly > 6 → that source isn't capturing dots at all
--     (confirmed bug for stat_source='scraper' rows whose scorecard_url is
--     a business-standard.com link; possible bug for stat_source='cricapi').
--   * dot_balls populated and plausible (roughly balls_bowled minus runs-scoring
--     balls) for stat_source='scraper' rows on a cricketaddictor.com URL →
--     that path is working as expected.
