/**
 * Daily contest leaderboard + personal history — PER-MATCH model.
 *
 * Daily is architecturally different from SL/private leagues: there's no
 * persistent "squad" for Daily — every match gets its own fresh `user_teams`
 * row (contest_id, user_id, match_id, squad_id IS NULL — see schema.sql's
 * `user_teams_one_per_match_idx` unique constraint). So "the Daily leaderboard"
 * is inherently scoped to ONE match at a time: only the people who actually
 * picked a team for that specific match show up, and rankings start fresh
 * each match-day. This mirrors web's db.js:
 *   - getLeaderboardDaily(matchId)   → ranked entries for one match
 *   - getMatchHistoryDetailed(ids)   → one user's picks across every match
 *
 * (Contrast with SL/private, which DO have a persistent squad accumulating
 * points across the whole season — see leaderboardStore.ts / seasonHistory.ts.
 * Don't reuse this file's functions for those contest types.)
 */

import { supabase } from './supabase';
import {
  calcBattingPoints,
  calcBowlingPoints,
  calcFieldingPoints,
} from '../engine/cricketScoringEngine';
import { MatchFormat, PlayerRole, CaptaincyRole } from '../types';
import { isMatchPlayed } from './matchLock';
import { MatchWeek, MatchPlayer, MatchTeam } from './seasonHistory';

// ─── Match picker (for the main ranked list) ──────────────────────────────────

export type DailyMatchOption = { id: string; label: string; matchNumber: number; date: string };

/**
 * Which match-days have at least one Daily entry for this contest, already
 * played (an upcoming/scheduled match nobody's leaderboard should show yet),
 * newest first. Gated on match status, not lock_time/start_time — those are
 * for edit-locking only and most matches never get them populated, which
 * would otherwise make every match disappear here. See matchLock.ts.
 */
export async function getDailyMatchOptions(contestId: string): Promise<DailyMatchOption[]> {
  if (!contestId) return [];

  const { data: teamRows, error: e1 } = await supabase
    .from('user_teams')
    .select('match_id')
    .eq('contest_id', contestId)
    .is('squad_id', null);
  if (e1) throw e1;

  const matchIds = [...new Set((teamRows || []).map((r: any) => r.match_id).filter(Boolean))];
  if (matchIds.length === 0) return [];

  const { data: matches, error: e2 } = await supabase
    .from('matches')
    .select('id, match_number, played_on, status')
    .in('id', matchIds);
  if (e2) throw e2;

  return (matches || [])
    .filter(isMatchPlayed)
    .sort((a: any, b: any) => (b.match_number ?? 0) - (a.match_number ?? 0))
    .map((m: any) => ({
      id:          m.id,
      matchNumber: m.match_number ?? 0,
      label:       `M${m.match_number ?? '?'}`,
      date:        m.played_on
        ? new Date(m.played_on).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        : '',
    }));
}

// ─── Ranked entries for one match ─────────────────────────────────────────────

export type DailyEntry = {
  rank:          number;
  userId:        string;
  teamId:        string;
  displayName:   string;
  teamName:      string;
  points:        number;
  isCurrentUser: boolean;
};

/** Mirrors web's db.getLeaderboardDaily(matchId). */
export async function loadDailyLeaderboard(matchId: string, currentUserId: string | null): Promise<DailyEntry[]> {
  if (!matchId) return [];

  const { data, error } = await supabase
    .from('user_teams')
    .select('id, name, user_id, user_team_match_scores(total_points)')
    .eq('match_id', matchId)
    .is('squad_id', null);
  if (error) throw error;
  if (!data?.length) return [];

  const userIds = [...new Set(data.map((t: any) => t.user_id))];
  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, display_name')
    .in('id', userIds);
  const nameById: Record<string, string> = {};
  (profiles || []).forEach((p: any) => { nameById[p.id] = p.display_name ?? 'Player'; });

  const unsorted = data.map((t: any) => ({
    userId:        t.user_id,
    teamId:        t.id,
    displayName:   nameById[t.user_id] ?? 'Player',
    teamName:      t.name ?? 'My XI',
    points:        Number(t.user_team_match_scores?.[0]?.total_points ?? 0),
    isCurrentUser: t.user_id === currentUserId,
  }));

  return unsorted
    .sort((a, b) => b.points - a.points)
    .map((e, i) => ({ ...e, rank: i + 1 }));
}

// ─── One user's personal history across every match ──────────────────────────

/**
 * One user's full Daily pick history across every match they've played in
 * this contest. Mirrors web's getMatchHistoryDetailed, reshaped into the same
 * MatchWeek/MatchTeam/MatchPlayer types seasonHistory.ts uses so the existing
 * TeamDetailModal UI can render either source interchangeably.
 */
export async function getDailyUserHistory(contestId: string, userId: string): Promise<{
  matchWeeks: MatchWeek[];
  history: MatchTeam[];
}> {
  if (!contestId || !userId) return { matchWeeks: [], history: [] };

  const { data: teams, error: e1 } = await supabase
    .from('user_teams')
    .select('id, match_id, captain_id, vice_captain_id')
    .eq('contest_id', contestId)
    .eq('user_id', userId)
    .is('squad_id', null)
    .not('match_id', 'is', null);
  if (e1) throw e1;
  if (!teams?.length) return { matchWeeks: [], history: [] };

  const teamIds  = teams.map((t: any) => t.id);
  const matchIds = [...new Set(teams.map((t: any) => t.match_id))];

  const [{ data: scores }, { data: teamPlayers }, { data: matches }] = await Promise.all([
    supabase.from('user_team_match_scores').select('user_team_id, total_points').in('user_team_id', teamIds),
    supabase.from('user_team_players').select('user_team_id, player_id').in('user_team_id', teamIds),
    supabase.from('matches')
      .select('id, match_number, played_on, home_team_id, away_team_id, format, status')
      .in('id', matchIds),
  ]);

  const matchById: Record<string, any> = {};
  (matches || []).forEach((m: any) => { matchById[m.id] = m; });
  // Status-gated, not lock_time/start_time — see getDailyMatchOptions above.
  const playedMatchIds = new Set((matches || []).filter(isMatchPlayed).map((m: any) => m.id));

  const playerIdsByTeam: Record<string, string[]> = {};
  (teamPlayers || []).forEach((tp: any) => {
    (playerIdsByTeam[tp.user_team_id] ??= []).push(tp.player_id);
  });

  const allPlayerIds = [...new Set((teamPlayers || []).map((tp: any) => tp.player_id))];
  const [{ data: playerMeta }, { data: statRows }] = await Promise.all([
    supabase.from('players').select('id, name, team_id, role').in('id', allPlayerIds),
    supabase.from('player_match_stats')
      .select('match_id, player_id, batting, bowling, fielding')
      .in('match_id', matchIds).in('player_id', allPlayerIds),
  ]);
  const metaById: Record<string, any> = {};
  (playerMeta || []).forEach((p: any) => { metaById[p.id] = p; });
  const statIdx: Record<string, Record<string, any>> = {};
  (statRows || []).forEach((s: any) => { (statIdx[s.match_id] ??= {})[s.player_id] = s; });

  const scoreByTeam: Record<string, number> = {};
  (scores || []).forEach((s: any) => { scoreByTeam[s.user_team_id] = Number(s.total_points ?? 0); });

  // Only matches actually played, oldest first (tabs read left-to-right;
  // screen defaults to the most recent tab, same convention as seasonHistory.ts).
  const groups = teams
    .filter((t: any) => t.match_id && playedMatchIds.has(t.match_id) && matchById[t.match_id])
    .map((t: any) => ({ team: t, match: matchById[t.match_id] }))
    .sort((a: any, b: any) => (a.match.match_number ?? 0) - (b.match.match_number ?? 0));

  const matchWeeks: MatchWeek[] = groups.map(({ match }: any) => ({
    id:    match.id,
    label: `M${match.match_number ?? '?'}`,
    match: `${match.home_team_id ?? '?'} vs ${match.away_team_id ?? '?'}`,
    date:  match.played_on
      ? new Date(match.played_on).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      : '',
  }));

  const history: MatchTeam[] = groups.map(({ team, match }: any) => {
    const fmt   = (match.format ?? 'T20') as MatchFormat;
    const stats = statIdx[match.id] || {};
    const pids  = playerIdsByTeam[team.id] || [];

    const players: MatchPlayer[] = pids.map(pid => {
      const st   = stats[pid];
      const meta = metaById[pid] || {};
      const role = (meta.role || 'bat') as PlayerRole;
      let bat = 0, bowl = 0, field = 0, bonus = 0;

      if (st?.batting) {
        const { breakdown } = calcBattingPoints({ ...st.batting, role }, fmt);
        bat   += (breakdown.runs ?? 0) + (breakdown.boundary4 ?? 0) + (breakdown.boundary6 ?? 0);
        bonus += (breakdown.century ?? 0) + (breakdown.half_century ?? 0)
               + (breakdown.duck ?? 0) + (breakdown.strikeRateBonus ?? 0);
      }
      if (st?.bowling) {
        const { breakdown } = calcBowlingPoints(st.bowling, fmt);
        bowl  += (breakdown.wickets ?? 0) + (breakdown.maidens ?? 0) + (breakdown.dotBalls ?? 0);
        bonus += (breakdown.lbwBowledBonus ?? 0) + (breakdown.fiveWicket ?? 0) + (breakdown.fourWicket ?? 0)
               + (breakdown.economyBonus ?? 0) + (breakdown.noBalls ?? 0) + (breakdown.wides ?? 0);
      }
      if (st?.fielding) {
        field += calcFieldingPoints(st.fielding, fmt).points;
      }

      // Old Daily picks have no per-row multiplier column (no booster system
      // existed) — derive straight from captain_id/vice_captain_id, same
      // doubling rule web's getTeamMatchPlayers/scoreDailyTeamsForMatch use.
      const isCap = pid === team.captain_id;
      const isVc  = pid === team.vice_captain_id;
      const captaincy: CaptaincyRole = isCap ? 'captain' : isVc ? 'vice_captain' : 'normal';

      return {
        name: meta.name || pid, team: meta.team_id || '', role, captaincy,
        bat, bowl, field, bonus,
        multiplier: isCap ? 2 : isVc ? 1.5 : 1,
      };
    });

    return {
      mwId:     match.id,
      pts:      scoreByTeam[team.id] ?? 0,
      boosters: [],   // Daily has no booster system
      players,
    };
  });

  return { matchWeeks, history };
}
