-- Removes the "Mukhtar Ahmed" ghost duplicate (scr_1781924937882) from squad
-- Shooter XI's (a5c2cde4-71e6-43bb-9be4-8876d75987d6) locked XI for M29 and
-- M30 — confirmed via diagnose_mukhtar_ahmed_xi_collision.sql: during the
-- M29 transfer window the squad made two separate transfers that both
-- brought in "Mukhtar Ahmed" (once as the real p636, once as this
-- duplicate), because the duplicate catalog entry made it look like two
-- different players. scr_1781924937882 has zero player_match_stats rows —
-- that 11th slot never scored anything, it was just a wasted transfer and a
-- roster slot that was really empty. Leaving M29/M30's recorded XI at 10
-- named players is the accurate record (per user decision — not rewriting
-- history to insert a different 11th player, not recalculating scores).
--
-- players has ON DELETE RESTRICT from user_match_xi, user_team_players and
-- user_transfers, so all of those have to be cleared/repointed before the
-- duplicate players row itself can go.

begin;

-- 0. Safety check — should show exactly the 2 ghost rows about to be removed.
select squad_id, match_id, player_id from user_match_xi
where player_id = 'scr_1781924937882';

-- 1. Remove the ghost slot from the locked XI + its computed scores.
delete from user_match_xi_scores
where player_id = 'scr_1781924937882'
  and squad_id = 'a5c2cde4-71e6-43bb-9be4-8876d75987d6';

delete from user_match_xi
where player_id = 'scr_1781924937882'
  and squad_id = 'a5c2cde4-71e6-43bb-9be4-8876d75987d6';

-- 2. Remove it from the standalone user_team_players rows (Pick XI mirror).
delete from user_team_players
where player_id = 'scr_1781924937882'
  and user_team_id in (
    select id from user_teams where squad_id = 'a5c2cde4-71e6-43bb-9be4-8876d75987d6'
  );

-- 3. The transfer log entries referencing the ghost id (M29 in, and
--    whichever later transfer swapped it back out — not caught in the
--    earlier diagnostic's pasted output, but the FK violation on the first
--    run of this script confirmed one exists) are still accurate in spirit —
--    just pointing at the wrong id for the real player. Repoint both
--    directions to p636 so the audit trail reads correctly and nothing
--    still references the duplicate id.
--
-- Guard first: user_transfers has check(player_out_id <> player_in_id). If
-- any single row already has the ghost id on one side and p636 on the other
-- (i.e. a transfer that swapped the ghost directly for the real one, or vice
-- versa), repointing both sides would collapse it into a same-id row and
-- violate that check. Such a row isn't a real transfer anyway (swapping a
-- player for themselves) — delete it instead of repointing it.
delete from user_transfers
where (player_out_id = 'scr_1781924937882' and player_in_id = 'p636')
   or (player_out_id = 'p636' and player_in_id = 'scr_1781924937882');

update user_transfers
set player_in_id = 'p636'
where player_in_id = 'scr_1781924937882';

update user_transfers
set player_out_id = 'p636'
where player_out_id = 'scr_1781924937882';

-- 4. Now safe to remove the duplicate from the roster and the catalog.
delete from tournament_players where player_id = 'scr_1781924937882';
delete from players where id = 'scr_1781924937882';

-- 5. Verify — should return 0 rows for all three.
select * from user_match_xi where player_id = 'scr_1781924937882';
select * from user_transfers where player_in_id = 'scr_1781924937882' or player_out_id = 'scr_1781924937882';
select * from players where id = 'scr_1781924937882';

-- 6. Verify Shooter XI's M29/M30 XI now shows 10 named players (was 11 with
--    the ghost duplicate) — matches what actually scored.
select m.match_number, count(*) as xi_player_count
from user_match_xi umx
join matches m on m.id = umx.match_id
where umx.squad_id = 'a5c2cde4-71e6-43bb-9be4-8876d75987d6'
  and m.match_number in (29, 30)
group by m.match_number
order by m.match_number;

commit;
