/**
 * Season Long match-by-match history for one squad — powers the leaderboard's
 * "tap a player → see their team for each matchweek" drill-down.
 *
 * Mirrors index.html's loadSLDetailInto() / db.getSquadSeason(), which reads
 * the same v_match_xi_with_scores view, but recomputes bat/bowl/field/bonus
 * point subtotals client-side from the stored batting/bowling/fielding JSONB
 * (via the ported cricketScoringEngine) instead of just itemizing lines —
 * this screen's UI shows one number per category rather than a line list.
 *
 * Category split (matches how the web's histBreakdownRowHtml groups lines):
 *   bat   = runs + boundary4 + boundary6
 *   bowl  = wickets + maidens + dotBalls
 *   field = catches + stumpings + runOutDirect + runOutIndirect (no separate
 *           fielding bonus exists in the scoring rules)
 *   bonus = everything else: century/half-century/duck/strike-rate bonus,
 *           lbw-bowled bonus, 4/5-wicket haul, economy bonus, no-ball/wide
 *           penalties
 *
 * total_points/multiplier on each row already come from the view pre-computed
 * (booster-aware) — bat/bowl/field/bonus here are the RAW, pre-multiplier
 * subtotals; the screen applies `multiplier` on top, same convention the web
 * version uses so the per-player number can never contradict the team total.
 */

import { supabase } from './supabase';
import {
  calcBattingPoints,
  calcBowlingPoints,
  calcFieldingPoints,
  SCORING_RULES,
} from '../engine/cricketScoringEngine';
import { MatchFormat, PlayerRole, CaptaincyRole } from '../types';
import { BOOSTER_META } from '../store/boosterStore';
import { isMatchPlayed } from './matchLock';
import { bowlingRulesFor } from './scoringUtils';

export type MatchWeek = { id: string; label: string; match: string; date: string };

export type MatchPlayer = {
  name: string;
  team: string;
  role: PlayerRole;
  captaincy: CaptaincyRole;
  bat: number;
  bowl: number;
  field: number;
  bonus: number;
  multiplier: number;   // booster-aware; prefer this over a hardcoded captain/VC guess
};

export type MatchTeam = {
  mwId: string;
  pts: number;
  boosters: Array<{ icon: string; name: string }>;
  players: MatchPlayer[];
};

export async function getSquadSeasonHistory(squadId: string): Promise<{
  matchWeeks: MatchWeek[];
  history: MatchTeam[];
}> {
  if (!squadId) return { matchWeeks: [], history: [] };

  const [
    { data: xiRows, error: e1 },
    { data: xferRows, error: e2 },
    { data: boosterRows, error: e3 },
  ] = await Promise.all([
    supabase.from('v_match_xi_with_scores').select('*').eq('squad_id', squadId).order('match_number'),
    supabase.from('user_transfers').select('match_id, points_deducted').eq('squad_id', squadId),
    supabase.from('user_booster_activations').select('match_id, booster').eq('squad_id', squadId),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;
  if (e3) throw e3;
  if (!xiRows?.length) return { matchWeeks: [], history: [] };

  const matchIds  = [...new Set(xiRows.map((r: any) => r.match_id))];
  const playerIds = [...new Set(xiRows.map((r: any) => r.player_id))];

  const [{ data: roleRows }, { data: statRows }, { data: matchRows }] = await Promise.all([
    supabase.from('players').select('id, role').in('id', playerIds),
    supabase.from('player_match_stats')
      .select('match_id, player_id, batting, bowling, fielding')
      .in('match_id', matchIds).in('player_id', playerIds),
    supabase.from('matches').select('id, format, status, tournament_id').in('id', matchIds),
  ]);

  // dot_ball_enabled per tournament (migration_v30) — without this, a
  // tournament with the toggle OFF would still show dot-ball points baked
  // into the locally-recomputed `bowl` subtotal below, even though the
  // server-computed `total_points` (used for `xiTotal`/`pts`) already
  // excludes them. Default false (hidden) if the tournament can't be
  // resolved, matching the server-side default.
  const tournamentIds = [...new Set((matchRows || []).map((m: any) => m.tournament_id).filter(Boolean))];
  const dotBallEnabledByTournament: Record<string, boolean> = {};
  if (tournamentIds.length) {
    const { data: tRows } = await supabase
      .from('tournaments').select('id, dot_ball_enabled').in('id', tournamentIds);
    (tRows || []).forEach((t: any) => { dotBallEnabledByTournament[t.id] = !!t.dot_ball_enabled; });
  }
  const tournamentIdByMatch: Record<string, string> = {};
  (matchRows || []).forEach((m: any) => { tournamentIdByMatch[m.id] = m.tournament_id; });

  // Real role from `players`, not the role stored on user_match_xi (which was
  // historically hardcoded to 'bat' for every player — see db.js's
  // getSquadSeason for the same caveat/fix).
  const roleById: Record<string, PlayerRole> = {};
  (roleRows || []).forEach((p: any) => { roleById[p.id] = p.role; });

  const statIdx: Record<string, Record<string, any>> = {};
  (statRows || []).forEach((s: any) => {
    (statIdx[s.match_id] ??= {})[s.player_id] = s;
  });

  const formatById: Record<string, MatchFormat> = {};
  (matchRows || []).forEach((m: any) => { formatById[m.id] = (m.format ?? 'T20') as MatchFormat; });

  // Don't show a match in history until it has actually been played — a
  // squad may have a saved/pre-picked XI for an upcoming match (carry-forward
  // etc.), but that match hasn't happened yet so it shouldn't appear as a
  // completed matchweek. Gate on match status (mirrors web's own filter),
  // NOT lock_time/start_time — most matches never get those populated, which
  // would otherwise make every match disappear from history.
  const playedMatchIds = new Set(
    (matchRows || []).filter(isMatchPlayed).map((m: any) => m.id),
  );

  const penaltyByMatch: Record<string, number> = {};
  (xferRows || []).forEach((t: any) => {
    penaltyByMatch[t.match_id] = (penaltyByMatch[t.match_id] ?? 0) + Number(t.points_deducted ?? 0);
  });

  const boosterByMatch: Record<string, string[]> = {};
  (boosterRows || []).forEach((b: any) => {
    (boosterByMatch[b.match_id] ??= []).push(b.booster);
  });

  type Group = {
    match_id: string; match_number: number; played_on: string | null;
    home_team_id: string | null; away_team_id: string | null;
    xiTotal: number; rows: any[];
  };
  const byMatch: Record<string, Group> = {};
  xiRows.forEach((r: any) => {
    if (!byMatch[r.match_id]) {
      byMatch[r.match_id] = {
        match_id: r.match_id, match_number: r.match_number, played_on: r.played_on,
        home_team_id: r.home_team_id, away_team_id: r.away_team_id,
        xiTotal: 0, rows: [],
      };
    }
    byMatch[r.match_id].rows.push(r);
    byMatch[r.match_id].xiTotal += Number(r.total_points ?? 0);
  });

  // Ascending by match number — tabs read left-to-right, oldest first, and
  // the screen defaults to the LAST (most recent) tab on open. Not-yet-played
  // matches are excluded — see playedMatchIds above.
  const groups = Object.values(byMatch)
    .filter(g => playedMatchIds.has(g.match_id))
    .sort((a, b) => (a.match_number ?? 0) - (b.match_number ?? 0));

  const matchWeeks: MatchWeek[] = groups.map(g => ({
    id:    g.match_id,
    label: `M${g.match_number ?? '?'}`,
    match: `${g.home_team_id ?? '?'} vs ${g.away_team_id ?? '?'}`,
    date:  g.played_on
      ? new Date(g.played_on).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      : '',
  }));

  const history: MatchTeam[] = groups.map(g => {
    const fmt   = formatById[g.match_id] ?? 'T20';
    const stats = statIdx[g.match_id] || {};
    const net   = g.xiTotal - (penaltyByMatch[g.match_id] ?? 0);
    // Gate dot_ball the same way the server/web do (migration_v30): only
    // honour the rule's configured weight when the tournament has it on.
    const dotBallOn = dotBallEnabledByTournament[tournamentIdByMatch[g.match_id]] ?? false;
    const bowlingRules = bowlingRulesFor(fmt, dotBallOn);

    const players: MatchPlayer[] = g.rows.map((r: any) => {
      const st = stats[r.player_id];
      const role = (roleById[r.player_id] || r.role || 'bat') as PlayerRole;
      let bat = 0, bowl = 0, field = 0, bonus = 0;

      if (st?.batting) {
        const { breakdown } = calcBattingPoints({ ...st.batting, role }, fmt);
        bat   += (breakdown.runs ?? 0) + (breakdown.boundary4 ?? 0) + (breakdown.boundary6 ?? 0);
        bonus += (breakdown.century ?? 0) + (breakdown.half_century ?? 0)
               + (breakdown.duck ?? 0) + (breakdown.strikeRateBonus ?? 0);
      }
      if (st?.bowling) {
        const { breakdown } = calcBowlingPoints(st.bowling, fmt, bowlingRules);
        bowl  += (breakdown.wickets ?? 0) + (breakdown.maidens ?? 0) + (breakdown.dotBalls ?? 0);
        bonus += (breakdown.lbwBowledBonus ?? 0) + (breakdown.fiveWicket ?? 0) + (breakdown.fourWicket ?? 0)
               + (breakdown.economyBonus ?? 0) + (breakdown.noBalls ?? 0) + (breakdown.wides ?? 0);
      }
      if (st?.fielding) {
        field += calcFieldingPoints(st.fielding, fmt).points;
      }

      const captaincy: CaptaincyRole = r.is_captain ? 'captain' : r.is_vc ? 'vice_captain' : 'normal';

      return {
        name: r.player_name, team: r.team_id || '', role, captaincy,
        bat, bowl, field, bonus,
        multiplier: Number(r.multiplier ?? 1),
      };
    });

    const boosters = (boosterByMatch[g.match_id] || []).map(id => {
      const meta = BOOSTER_META[id];
      return meta ? { icon: meta.icon, name: meta.name } : { icon: '🎯', name: id };
    });

    return { mwId: g.match_id, pts: Math.round(net * 10) / 10, boosters, players };
  });

  return { matchWeeks, history };
}
