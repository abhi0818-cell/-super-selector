-- Confirm whether user_match_xi_scores for the whole MLC Season Long contest
-- crosses Supabase/PostgREST's default 1000-row .select() cap — if so, that
-- silently truncates getLeaderboardSL's bulk query, undercounting whichever
-- squads' rows land past row 1000 (order is whatever Postgres/PostgREST
-- returns by default, i.e. NOT guaranteed to be match/squad order).
select count(*) as total_score_rows
from user_match_xi_scores uxs
join user_squads us on us.id = uxs.squad_id
where us.contest_id = '4bdbf63d-90fd-4056-9fad-3d626a23369b';
