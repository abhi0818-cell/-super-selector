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
 * performances per player, aligned to each player's OWN TEAM'S most recent
 * matches (not the player's own stats rows). Mirrors db.js's
 * getRecentFormForPlayers: a player who was rested/dropped for a match has
 * no player_match_stats row for it at all (there's no "did not play"
 * sentinel row — the row is simply absent), so aligning to the player's own
 * stats rows directly would silently skip any match he sat out and pull in
 * an older match to fill the slot, hiding the gap. Aligning to the team's
 * match list instead means a missed match still claims its slot — the
 * player just has no points for it, which the caller renders as "-" / DNP.
 *
 * Any match with a result counts as a used slot — completed, abandoned, or
 * cancelled all occupy a place in "the team's last N fixtures"; upcoming/
 * live matches don't yet.
 *
 * @param teamByPlayerId - playerId → team_id map. The store already has this
 *   on each Player (p.team), so passing it in avoids an extra players-table
 *   round trip; when omitted, it's looked up here instead.
 * @returns playerId → [pts most-recent..older], with `null` for a team match
 *   the player has no stats row for (DNP or not yet scored — both render the
 *   same "-" in the strip).
 */
export async function getRecentFormForPlayers(
  playerIds: string[],
  matchLimit = 3,
  tournamentId: string | null = null,
  teamByPlayerId: Record<string, string> | null = null,
): Promise<Record<string, (number | null)[]>> {
  if (!playerIds.length) return {};

  // Resolve each player's team so slots can be aligned to the team's
  // fixture list. Prefer the caller-supplied map; fall back to a
  // players-table lookup if it wasn't given.
  let teamByPlayer: Record<string, string> = teamByPlayerId ?? {};
  if (!teamByPlayerId) {
    const { data: prows, error: pErr } = await supabase
      .from('players').select('id, team_id').in('id', playerIds);
    if (pErr) throw pErr;
    teamByPlayer = Object.fromEntries((prows ?? []).map((p: any) => [p.id, p.team_id]));
  }
  const teamIds = [...new Set(playerIds.map(pid => teamByPlayer[pid]).filter(Boolean))];
  if (!teamIds.length) return {};

  // Fetch every match involving these teams (any status) up front and scope
  // everything else to it — keeps the query bounded instead of pulling all
  // player_match_stats rows for these players, which PostgREST silently
  // caps at 1000 and can truncate before the newest match's row even
  // appears (a player's latest points could otherwise vanish from this
  // batched lookup while still showing up fine in the single-player
  // getPlayerMatchHistory(), which never gets near the cap).
  const teamList = teamIds.map(t => `"${t}"`).join(',');
  let matchQuery = supabase
    .from('matches')
    .select('id, match_number, home_team_id, away_team_id, status')
    .or(`home_team_id.in.(${teamList}),away_team_id.in.(${teamList})`);
  if (tournamentId) matchQuery = matchQuery.eq('tournament_id', tournamentId);
  const { data: allMatches, error: matchErr } = await matchQuery;
  if (matchErr) throw matchErr;
  if (!allMatches?.length) return {};

  // A match "counts" toward a team's fixture history once it has a result —
  // completed, or a no-result (abandoned/cancelled). Still upcoming/live
  // matches don't claim a slot yet.
  const playedStatuses = new Set(['completed', 'abandoned', 'cancelled']);
  const finished = allMatches.filter((m: any) => playedStatuses.has(m.status));

  // Per team, the last `matchLimit` finished matches, newest first.
  const matchesByTeam: Record<string, any[]> = {};
  finished.forEach((m: any) => {
    [m.home_team_id, m.away_team_id].forEach((t: string) => {
      if (!t || !teamIds.includes(t)) return;
      (matchesByTeam[t] = matchesByTeam[t] || []).push(m);
    });
  });
  Object.keys(matchesByTeam).forEach(t => {
    matchesByTeam[t] = matchesByTeam[t]
      .sort((a, b) => (b.match_number || 0) - (a.match_number || 0))
      .slice(0, matchLimit);
  });

  const relevantMatchIds = [...new Set(Object.values(matchesByTeam).flat().map((m: any) => m.id))];
  if (!relevantMatchIds.length) return {};

  const { data: stats, error: statsErr } = await supabase
    .from('player_match_stats')
    .select('player_id, match_id, raw_points')
    .in('player_id', playerIds)
    .in('match_id', relevantMatchIds);
  if (statsErr) throw statsErr;

  // player_id:match_id → points, only for rows that actually exist — a
  // missing key means the player has no stats row for that match (DNP, or
  // not yet scored), which the caller renders as "-".
  const pointsByKey: Record<string, number | null> = {};
  (stats ?? []).forEach((s: any) => {
    pointsByKey[`${s.player_id}:${s.match_id}`] =
      s.raw_points != null ? Number(s.raw_points) : null;
  });

  const out: Record<string, (number | null)[]> = {};
  playerIds.forEach(pid => {
    const team = teamByPlayer[pid];
    const teamMatches = team ? (matchesByTeam[team] || []) : [];
    out[pid] = teamMatches.map((m: any) => {
      const key = `${pid}:${m.id}`;
      return key in pointsByKey ? pointsByKey[key] : null;
    });
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
