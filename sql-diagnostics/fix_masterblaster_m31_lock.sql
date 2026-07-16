-- Fix: MasterBlaster squad's M31 lock used the wrong XI (mobile wrote
-- directly into user_match_xi before the real lock time, silently
-- pre-empting the web draft that was correctly saved for M31 at
-- 2026-07-15 21:25:48, target_match_id = M31). Confirmed via
-- diagnose_masterblaster_m31_stray_transfers*.sql and user confirmation
-- that the Short(C)/Holder(VC) draft is the real intended M31 team.
--
--   squad_id = 1babca00-f4f3-42db-865f-c93ebe0bc6b6   (MLC Season Long)
--   match_id = fdc45831-7f3e-4d74-b7af-dc1b0ee2a6b0   (M31, LAKR vs SFU, live)
--
-- Correct XI (from squad_draft_xi, target_match_id = M31):
--   captain: p571 (Short)
--   vc:      scr_1781916475717 (Holder)
--   players: p541, scr_1781916475717, p538, p571, p574, p552, p582, p579,
--            p547, p549, p551
--
-- Transfer baseline = M30's locked XI (Fletcher C / Holder VC, Lamba,
-- Hosein, Ali Khan, Russell, Faf du Plessis, Mukkamalla, Schalkwyk,
-- Narine, Chand). Diff = 7 players out/in. Contest has
-- free_transfers_per_match = null, i.e. every transfer this contest is
-- free — matches how lock-matches would have scored this had it locked
-- the right draft in the first place.

begin;

-- 0. Safety check — confirm what's currently locked for M31 before touching
--    anything. Expect the WRONG team (Fletcher C / Finn Allen VC / Azam swap).
select p.name, umx.player_id, umx.is_captain, umx.is_vc
from user_match_xi umx
join players p on p.id = umx.player_id
where umx.squad_id = '1babca00-f4f3-42db-865f-c93ebe0bc6b6'
  and umx.match_id = 'fdc45831-7f3e-4d74-b7af-dc1b0ee2a6b0'
order by umx.is_captain desc, umx.is_vc desc, p.name;

-- 1. Replace user_match_xi for M31 with the correct XI.
delete from user_match_xi
where squad_id = '1babca00-f4f3-42db-865f-c93ebe0bc6b6'
  and match_id = 'fdc45831-7f3e-4d74-b7af-dc1b0ee2a6b0';

insert into user_match_xi (squad_id, match_id, player_id, is_captain, is_vc, role, user_id)
select
  '1babca00-f4f3-42db-865f-c93ebe0bc6b6',
  'fdc45831-7f3e-4d74-b7af-dc1b0ee2a6b0',
  pid,
  pid = 'p571',
  pid = 'scr_1781916475717',
  'bat',  -- lock-matches always writes 'bat' here regardless of real role; matching that convention
  (select user_id from user_squads where id = '1babca00-f4f3-42db-865f-c93ebe0bc6b6')
from unnest(array['p541','scr_1781916475717','p538','p571','p574','p552','p582','p579','p547','p549','p551']) as pid;

-- 2. Replace user_transfers for M31 with the correct diff vs M30's baseline.
delete from user_transfers
where squad_id = '1babca00-f4f3-42db-865f-c93ebe0bc6b6'
  and match_id = 'fdc45831-7f3e-4d74-b7af-dc1b0ee2a6b0';

insert into user_transfers (squad_id, match_id, player_out_id, player_in_id, is_free, points_deducted)
values
  ('1babca00-f4f3-42db-865f-c93ebe0bc6b6', 'fdc45831-7f3e-4d74-b7af-dc1b0ee2a6b0', 'p624', 'p571', true, 0), -- Lamba -> Short
  ('1babca00-f4f3-42db-865f-c93ebe0bc6b6', 'fdc45831-7f3e-4d74-b7af-dc1b0ee2a6b0', 'p614', 'p574', true, 0), -- Hosein -> ?
  ('1babca00-f4f3-42db-865f-c93ebe0bc6b6', 'fdc45831-7f3e-4d74-b7af-dc1b0ee2a6b0', 'p540', 'p552', true, 0), -- Russell -> ?
  ('1babca00-f4f3-42db-865f-c93ebe0bc6b6', 'fdc45831-7f3e-4d74-b7af-dc1b0ee2a6b0', 'p607', 'p582', true, 0), -- Faf du Plessis -> Azam
  ('1babca00-f4f3-42db-865f-c93ebe0bc6b6', 'fdc45831-7f3e-4d74-b7af-dc1b0ee2a6b0', 'p616', 'p579', true, 0), -- Mukkamalla -> ?
  ('1babca00-f4f3-42db-865f-c93ebe0bc6b6', 'fdc45831-7f3e-4d74-b7af-dc1b0ee2a6b0', 'p550', 'p547', true, 0), -- Schalkwyk -> ?
  ('1babca00-f4f3-42db-865f-c93ebe0bc6b6', 'fdc45831-7f3e-4d74-b7af-dc1b0ee2a6b0', 'p545', 'p549', true, 0); -- Chand -> ?

-- 3. Update user_teams + user_team_players (feeds the scoring pipeline).
do $$
declare
  v_team_id uuid;
begin
  select id into v_team_id
  from user_teams
  where squad_id = '1babca00-f4f3-42db-865f-c93ebe0bc6b6'
    and match_id = 'fdc45831-7f3e-4d74-b7af-dc1b0ee2a6b0'
  limit 1;

  if v_team_id is not null then
    update user_teams
    set captain_id = 'p571', vice_captain_id = 'scr_1781916475717'
    where id = v_team_id;

    delete from user_team_players where user_team_id = v_team_id;
  else
    insert into user_teams (squad_id, match_id, user_id, name, format, captain_id, vice_captain_id)
    values (
      '1babca00-f4f3-42db-865f-c93ebe0bc6b6',
      'fdc45831-7f3e-4d74-b7af-dc1b0ee2a6b0',
      (select user_id from user_squads where id = '1babca00-f4f3-42db-865f-c93ebe0bc6b6'),
      'SL Team', 'T20', 'p571', 'scr_1781916475717'
    )
    returning id into v_team_id;
  end if;

  insert into user_team_players (user_team_id, player_id)
  select v_team_id, pid
  from unnest(array['p541','scr_1781916475717','p538','p571','p574','p552','p582','p579','p547','p549','p551']) as pid;
end $$;

-- 4. Verify — should now show the Short(C)/Holder(VC) team for M31.
select p.name, umx.player_id, umx.is_captain, umx.is_vc
from user_match_xi umx
join players p on p.id = umx.player_id
where umx.squad_id = '1babca00-f4f3-42db-865f-c93ebe0bc6b6'
  and umx.match_id = 'fdc45831-7f3e-4d74-b7af-dc1b0ee2a6b0'
order by umx.is_captain desc, umx.is_vc desc, p.name;

select po.name as player_out, pi.name as player_in, ut.is_free, ut.points_deducted
from user_transfers ut
join players po on po.id = ut.player_out_id
join players pi on pi.id = ut.player_in_id
where ut.squad_id = '1babca00-f4f3-42db-865f-c93ebe0bc6b6'
  and ut.match_id = 'fdc45831-7f3e-4d74-b7af-dc1b0ee2a6b0';

commit;

-- After this commits: Admin → Matches → M31 (LAKR vs SFU) → Recalculate.
-- computeAndSaveSLScoresForMatch re-reads user_match_xi from scratch every
-- run, so MasterBlaster's M31 score will recompute off the corrected XI —
-- no code change needed. The "6 pending transfers" banner on M32's Pick XI
-- should also resolve on its own next load, since it diffs your current
-- draft against the (now-correct) M31 lock instead of the wrong one.
