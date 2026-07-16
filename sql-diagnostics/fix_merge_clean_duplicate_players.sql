-- Fixes the 3 duplicate-player pairs that diagnose_true_duplicate_merges.sql
-- confirmed have NO collisions (safe to repoint/delete outright). Does NOT
-- touch Mukhtar Ahmed — that one needs manual review first, see
-- diagnose_mukhtar_ahmed_xi_collision.sql.
--
--   Obus Pienaar     (WF):  keep p635,  drop scr_1781924976282
--                            → 3 player_match_stats rows get repointed to
--                              p635 (no collision — p635 has no stats for
--                              those same 3 matches), then the drop's
--                              tournament_players + players rows are deleted.
--   Ali Sheikh       (SO):  keep p603,  drop scr_1781986951959
--                            → drop_id has zero real usage anywhere except
--                              being rostered (which p603 already covers) —
--                              just delete tournament_players + players.
--   Anirudh Immanuel (SFU): keep scr_1783595977490, drop scr_1783595979405
--                            → same as Ali Sheikh, zero usage on both sides,
--                              just delete the newer duplicate roster row.

begin;

-- 0. Safety check — should show only the 3 pairs' drop ids about to be
--    touched, matching what diagnose_true_duplicate_merges.sql showed.
select id, name, team_id from players
where id in ('scr_1781924976282', 'scr_1781986951959', 'scr_1783595979405');

-- 1. Obus Pienaar — repoint the 3 player_match_stats rows to the real id.
update player_match_stats
set player_id = 'p635'
where player_id = 'scr_1781924976282';

-- 2. Remove the now-redundant tournament_players rows for all 3 drop ids
--    (each tournament already has the keep_id rostered).
delete from tournament_players
where player_id in ('scr_1781924976282', 'scr_1781986951959', 'scr_1783595979405');

-- 3. Delete the 3 orphaned duplicate player rows themselves.
delete from players
where id in ('scr_1781924976282', 'scr_1781986951959', 'scr_1783595979405');

-- 4. Verify — should return 0 rows.
select id, name from players
where id in ('scr_1781924976282', 'scr_1781986951959', 'scr_1783595979405');

-- 5. Verify Obus Pienaar's stats now live under one id.
select match_id, player_id, raw_points from player_match_stats
where player_id = 'p635'
order by match_id;

commit;
