-- Follow-up to classify_duplicate_players.sql's NEEDS_REVIEW bucket.
--
-- Most NEEDS_REVIEW rows turned out to be FALSE POSITIVES: the same real
-- player legitimately rostered under two different ids in TWO DIFFERENT
-- TOURNAMENTS (e.g. Ben Dwarshuis is WF in MLC and PBKS in IPL 2026 — two
-- separate team_ids, two separate roster entries, by design, not a bug).
--
-- A small number are TRUE duplicates: same name, SAME team_id (so same
-- tournament), split across two ids because the "Scraper Unmatched" admin
-- panel's "Add new player" button was used instead of "Map to existing
-- player" for a scorecard name variant (db.js resolveUnmatchedAsNewPlayer —
-- now patched to block this going forward). These need a real merge:
--   Mukhtar Ahmed    (WF):  p636 vs scr_1781924937882
--   Obus Pienaar     (WF):  p635 vs scr_1781924976282
--   Ali Sheikh       (SO):  p603 vs scr_1781986951959   (2nd id has 0 usage)
--   Anirudh Immanuel (SFU): scr_1783595977490 vs scr_1783595979405 (both 0 usage)
--
-- Before writing the merge/delete SQL: inventories every row the drop_id
-- appears in, and flags (keep_id_also_has_this) whether the keep_id ALREADY
-- has a row for that same key (squad/team + match, or match alone for
-- player_match_stats). A true flag means a blind "repoint player_id from
-- drop to keep" would hit a unique-constraint conflict there and the merge
-- has to combine the two rows instead of just re-pointing one.

with pairs(name, keep_id, drop_id) as (
  values
    ('Mukhtar Ahmed',    'p636', 'scr_1781924937882'),
    ('Obus Pienaar',     'p635', 'scr_1781924976282'),
    ('Ali Sheikh',       'p603', 'scr_1781986951959'),
    ('Anirudh Immanuel', 'scr_1783595977490', 'scr_1783595979405')
)
select 'tournament_players' as source, p.name, p.drop_id,
       tp.tournament_id::text as ref,
       exists (
         select 1 from tournament_players k
         where k.player_id = p.keep_id and k.tournament_id = tp.tournament_id
       ) as keep_id_also_has_this
from pairs p
join tournament_players tp on tp.player_id = p.drop_id

union all

select 'user_match_xi', p.name, p.drop_id, umx.match_id::text,
       exists (
         select 1 from user_match_xi k
         where k.player_id = p.keep_id and k.squad_id = umx.squad_id and k.match_id = umx.match_id
       )
from pairs p
join user_match_xi umx on umx.player_id = p.drop_id

union all

select 'user_match_xi_scores', p.name, p.drop_id, s.match_id::text,
       exists (
         select 1 from user_match_xi_scores k
         where k.player_id = p.keep_id and k.squad_id = s.squad_id and k.match_id = s.match_id
       )
from pairs p
join user_match_xi_scores s on s.player_id = p.drop_id

union all

select 'player_match_stats', p.name, p.drop_id, pms.match_id::text,
       exists (
         select 1 from player_match_stats k
         where k.player_id = p.keep_id and k.match_id = pms.match_id
       )
from pairs p
join player_match_stats pms on pms.player_id = p.drop_id

union all

select 'user_team_players', p.name, p.drop_id, utp.user_team_id::text,
       exists (
         select 1 from user_team_players k
         where k.player_id = p.keep_id and k.user_team_id = utp.user_team_id
       )
from pairs p
join user_team_players utp on utp.player_id = p.drop_id

union all

select 'user_transfers_out', p.name, p.drop_id, ut.id::text, false
from pairs p
join user_transfers ut on ut.player_out_id = p.drop_id

union all

select 'user_transfers_in', p.name, p.drop_id, ut.id::text, false
from pairs p
join user_transfers ut on ut.player_in_id = p.drop_id

union all

select 'squad_draft_xi', p.name, p.drop_id, sdx.squad_id::text,
       exists (
         select 1 from squad_draft_xi k
         where k.squad_id = sdx.squad_id
           and (k.captain_id = p.keep_id or k.vc_id = p.keep_id or k.player_ids @> array[p.keep_id])
       )
from pairs p
join squad_draft_xi sdx
  on sdx.captain_id = p.drop_id or sdx.vc_id = p.drop_id or sdx.player_ids @> array[p.drop_id]

union all

select 'player_name_aliases', p.name, p.drop_id, pna.alias, false
from pairs p
join player_name_aliases pna on pna.player_id = p.drop_id

order by 1, 2;
