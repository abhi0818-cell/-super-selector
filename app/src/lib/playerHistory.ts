/**
 * Player match-history + recent-form helpers — mobile port of the same
 * queries web already runs in db.js (getRecentFormForPlayers /
 * getPlayerMatchHistory) and the line-formatters in index.html
 * (formatBattingLine / formatBowlingLine / formatFieldingLine), so the
 * mobile picker's form strip + stats modal show identical data/labels to web.
 */

import { supabase } from './supabase';
import { BattingInnings, BowlingSpell, FieldingStats } from '../types';

export interface PlayerMatchHistoryRow {
  matchId:     string;
  matchNumber: number | null;
  homeTeam:    string;
  awayTeam:    string;
  startTime:   string | null;
  status:      string;
  rawPoints:   number | null;
  batting:     BattingInnings | null;
  bowling:     BowlingSpell | null;
  fielding:    FieldingStats | null;
}

/**
 * Match-by-match fantasy history for one player, newest match first.
 * Mirrors db.js's getPlayerMatchHistory exactly.
 */
export async function getPlayerMatchHistory(
  playerId: string,
  limit = 8,
  tournamentId: string | null = null,
): Promise<PlayerMatchHistoryRow[]> {
  const { data: stats, error: statsErr } = await supabase
    .from('player_match_stats')
    .select('match_id, raw_points, batting, bowling, fielding')
    .eq('player_id', playerId);
  if (statsErr) throw statsErr;
  if (!stats?.length) return [];

  const matchIds = stats.map((s: any) => s.match_id);
  let matchQuery = supabase
    .from('matches')
    .select('id, match_number, home_team_id, away_team_id, start_time, status, tournament_id')
    .in('id', matchIds);
  if (tournamentId) matchQuery = matchQuery.eq('tournament_id', tournamentId);

  const { data: matches, error: matchErr } = await matchQuery;
  if (matchErr) throw matchErr;
  const matchMap = Object.fromEntries((matches ?? []).map((m: any) => [m.id, m]));

  return stats
    .map((s: any) => ({ ...s, match: matchMap[s.match_id] || null }))
    .filter((s: any) => s.match)
    .sort((a: any, b: any) => (b.match.match_number || 0) - (a.match.match_number || 0))
    .slice(0, limit)
    .map((s: any) => ({
      matchId:     s.match_id,
      matchNumber: s.match.match_number,
      homeTeam:    s.match.home_team_id,
      awayTeam:    s.match.away_team_id,
      startTime:   s.match.start_time,
      status:      s.match.status,
      rawPoints:   s.raw_points != null ? Number(s.raw_points) : null,
      batting:     s.batting  ?? null,
      bowling:     s.bowling  ?? null,
      fielding:    s.fielding ?? null,
    }));
}

/**
 * Batched "recent form" lookup for many players at once — last `matchLimit`
 * fantasy-point totals per player, newest first. One round trip for the
 * whole visible pool instead of one query per card. Mirrors db.js's
 * getRecentFormForPlayers, including the tournament-scoping fix that keeps
 * the stats query bounded (PostgREST caps unbounded results at 1000).
 */
export async function getRecentFormForPlayers(
  playerIds: string[],
  matchLimit = 3,
  tournamentId: string | null = null,
): Promise<Record<string, (number | null)[]>> {
  if (!playerIds.length) return {};

  let stats: any[] | null | undefined;
  let matches: any[] | null | undefined;

  if (tournamentId) {
    const { data: tMatches, error: tMatchErr } = await supabase
      .from('matches')
      .select('id, match_number')
      .eq('tournament_id', tournamentId);
    if (tMatchErr) throw tMatchErr;

    const matchIds = (tMatches ?? []).map((m: any) => m.id);
    if (!matchIds.length) return {};

    const { data, error: statsErr } = await supabase
      .from('player_match_stats')
      .select('player_id, match_id, raw_points')
      .in('player_id', playerIds)
      .in('match_id', matchIds);
    if (statsErr) throw statsErr;
    stats   = data;
    matches = tMatches;
  } else {
    const { data, error: statsErr } = await supabase
      .from('player_match_stats')
      .select('player_id, match_id, raw_points')
      .in('player_id', playerIds);
    if (statsErr) throw statsErr;
    stats = data;
    if (!stats?.length) return {};

    const matchIds = [...new Set(stats.map((s: any) => s.match_id))];
    const { data: mData, error: matchErr } = await supabase
      .from('matches').select('id, match_number').in('id', matchIds);
    if (matchErr) throw matchErr;
    matches = mData;
  }

  if (!stats?.length) return {};

  const matchNumMap   = Object.fromEntries((matches ?? []).map((m: any) => [m.id, m.match_number || 0]));
  const validMatchIds = new Set((matches ?? []).map((m: any) => m.id));

  const byPlayer: Record<string, { matchNumber: number; points: number | null }[]> = {};
  stats
    .filter((s: any) => validMatchIds.has(s.match_id))
    .forEach((s: any) => {
      (byPlayer[s.player_id] = byPlayer[s.player_id] || []).push({
        matchNumber: matchNumMap[s.match_id] ?? 0,
        points: s.raw_points != null ? Number(s.raw_points) : null,
      });
    });

  const out: Record<string, (number | null)[]> = {};
  Object.entries(byPlayer).forEach(([pid, rows]) => {
    out[pid] = rows
      .sort((a, b) => b.matchNumber - a.matchNumber)
      .slice(0, matchLimit)
      .map(r => r.points);
  });
  return out;
}

// ─── Line formatters (ported 1:1 from index.html) ─────────────────────────────

export function formatBattingLine(b: BattingInnings | null | undefined): string {
  if (!b) return 'Did not bat';
  const runs = b.runs ?? 0, balls = b.ballsFaced ?? 0;
  const out = b.isDismissed === false ? '*' : '';
  let line = `${runs}${out} (${balls}b)`;
  const extras: string[] = [];
  if (b.fours) extras.push(`${b.fours}x4`);
  if (b.sixes) extras.push(`${b.sixes}x6`);
  if (extras.length) line += ` · ${extras.join(', ')}`;
  return line;
}

export function formatBowlingLine(b: BowlingSpell | null | undefined): string | null {
  if (!b || (!b.ballsBowled && !b.wickets && !b.runsConceded)) return null;
  const overs = b.ballsBowled
    ? (Math.floor(b.ballsBowled / 6) + (b.ballsBowled % 6) / 10).toFixed(1)
    : '0.0';
  let line = `${b.wickets ?? 0}/${b.runsConceded ?? 0} (${overs}ov)`;
  const extras: string[] = [];
  if (b.maidens) extras.push(`${b.maidens}m`);
  if (b.dotBalls) extras.push(`${b.dotBalls} dots`);
  if (extras.length) line += ` · ${extras.join(', ')}`;
  return line;
}

export function formatFieldingLine(f: FieldingStats | null | undefined): string | null {
  if (!f) return null;
  const bits: string[] = [];
  if (f.catches) bits.push(`${f.catches} ct`);
  if (f.stumpings) bits.push(`${f.stumpings} st`);
  const runOuts = (f.runOutDirect || 0) + (f.runOutIndirect || 0);
  if (runOuts) bits.push(`${runOuts} ro`);
  return bits.length ? bits.join(', ') : null;
}
