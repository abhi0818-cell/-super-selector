-- MasterBlaster's team was saved (intended) for M25, but never locked.
-- M25 already started (per earlier check: MLC M25, MNY vs SO, start_time
-- 2026-07-10 20:30 UTC) and the app is now sitting on M26 (16m out) — so if
-- the draft's last save happened AFTER M25 started, that's the smoking gun:
-- squad_draft_xi has no match_id column, it's one row per squad. If the user
-- made a NEW set of changes intended for M26 before M25 ever got picked up by
-- slCheckAutoLock's catch-up pass, the current draft no longer reflects what
-- was actually saved for M25 — there'd be nothing left for a later catch-up
-- to correctly lock M25 with.

-- A) M25 + M26 real times/status, for reference.
select id, match_number, tournament_id, status, start_time, lock_time, home_team_id, away_team_id
from matches
where match_number in (25, 26)
  and tournament_id = (
    select tournament_id from contests c
    join user_squads us on us.contest_id = c.id
    join profiles    p  on p.id = us.user_id
    where p.team_name = 'MasterBlaster'
  )
order by match_number;

-- B) Locked XI rows for MasterBlaster around M25 — confirm M25 is genuinely
--    missing (and check M24 too, to see if the pattern is isolated to M25).
select uxi.match_id, m.match_number, count(*) as players_locked, min(uxi.player_id) as sample_player
from user_match_xi uxi
join user_squads us on us.id = uxi.squad_id
join profiles    p  on p.id = us.user_id
join matches     m  on m.id = uxi.match_id
where p.team_name = 'MasterBlaster'
  and m.match_number in (23, 24, 25, 26)
group by uxi.match_id, m.match_number
order by m.match_number;

-- C) The draft's last-saved timestamp vs M25's start_time — if updated_at is
--    AFTER M25's start_time, the draft was very likely overwritten with
--    M26-intended picks before M25 ever got auto-locked, which means the
--    "use current draft" catch-up logic in slCheckAutoLock can no longer
--    recover M25's actual intended team even if it runs now.
select sdx.squad_id, sdx.updated_at,
       (select start_time from matches where match_number = 25
         and tournament_id = (select tournament_id from contests c
           join user_squads us2 on us2.contest_id = c.id
           join profiles p2 on p2.id = us2.user_id where p2.team_name = 'MasterBlaster')) as m25_start_time
from squad_draft_xi sdx
join user_squads us on us.id = sdx.squad_id
join profiles    p  on p.id = us.user_id
where p.team_name = 'MasterBlaster';

-- D) Squad creation date, in case MasterBlaster joined mid-season and M25 is
--    simply before they existed (slCheckAutoLock deliberately skips those —
--    see squadCreatedAt guard in index.html).
select us.id as squad_id, us.created_at
from user_squads us
join profiles p on p.id = us.user_id
where p.team_name = 'MasterBlaster';

-- E) The user also flagged that changes got "counted against M26 save" —
--    if M25 never locked, getPreviousMatchXI() falls back past M25 to
--    whatever WAS actually locked before it (M24, or earlier). saveMatchXI's
--    transfer diff then compares M26's new picks against that older baseline
--    instead of M25's real (never-recorded) team, which can inflate the
--    transfer count far beyond what the user actually changed between M25
--    and M26. This shows exactly what got logged for M26 and what the last
--    real locked baseline actually was, so we can see the size of the gap.
select ut.*, m.match_number
from user_transfers ut
join user_squads us on us.id = ut.squad_id
join profiles    p  on p.id = us.user_id
join matches     m  on m.id = ut.match_id
where p.team_name = 'MasterBlaster' and m.match_number = 26;

select uxi.match_id, m.match_number, uxi.player_id, pl.name, uxi.is_captain, uxi.is_vc
from user_match_xi uxi
join user_squads us on us.id = uxi.squad_id
join profiles    p  on p.id = us.user_id
join matches     m  on m.id = uxi.match_id
join players     pl on pl.id = uxi.player_id
where p.team_name = 'MasterBlaster'
  and m.match_number = (
    select max(m2.match_number) from user_match_xi uxi2
    join matches m2 on m2.id = uxi2.match_id
    join user_squads us2 on us2.id = uxi2.squad_id
    where us2.id = us.id and m2.match_number < 25
  )
order by uxi.is_captain desc, uxi.is_vc desc;
