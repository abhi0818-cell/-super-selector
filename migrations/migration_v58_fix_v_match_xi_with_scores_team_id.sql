-- ═══════════════════════════════════════════════════════════════════════════
-- Super Selector — Migration v58: fix v_match_xi_with_scores team_id
--
-- v_match_xi_with_scores (migration_v2) selected p.team_id straight from the
-- global players table. Per migration_v43, team_id is tournament-scoped on
-- tournament_players — the global players.team_id is only the bootstrap
-- default, same relationship as is_overseas. v_squad_current_players
-- (used by squad selection) already coalesces tp.team_id first and has
-- always been correct; this view (used by Season Long match history /
-- leaderboard breakdown — getSquadSeason in db.js, getSquadSeasonHistory in
-- mobile's seasonHistory.ts) never did, so a mid-tournament team correction
-- (made on tournament_players, same place selection reads from) never
-- showed up in past-match breakdowns — they kept reading the stale global
-- column forever, independent of any app-code deploy.
--
-- Mirrors the equivalent fix already applied at the JS layer to db.js's
-- getTeamMatchPlayers/getMatchHistoryDetailed (Daily contest history) and
-- app/src/lib/dailyLeaderboard.ts's getDailyUserHistory.
--
-- Paste into Supabase SQL Editor → Run.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace view v_match_xi_with_scores as
  select
    xi.squad_id,
    xi.match_id,
    xi.player_id,
    xi.is_captain,
    xi.is_vc,
    xi.role,
    p.name                                          as player_name,
    coalesce(tp.team_id, p.team_id)                 as team_id,  -- tournament-specific team wins
    m.match_number,
    m.played_on,
    m.home_team_id,
    m.away_team_id,
    m.status                                        as match_status,
    coalesce(s.base_points,  0)                     as base_points,
    coalesce(s.multiplier,   1.0)                   as multiplier,
    coalesce(s.total_points, 0)                     as total_points
  from      user_match_xi        xi
  join      players              p  on p.id  = xi.player_id
  join      matches              m  on m.id  = xi.match_id
  left join tournament_players   tp on tp.tournament_id = m.tournament_id
                                   and tp.player_id      = p.id
  left join user_match_xi_scores s  on s.squad_id  = xi.squad_id
                                   and s.match_id  = xi.match_id
                                   and s.player_id = xi.player_id;
