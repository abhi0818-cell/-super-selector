/**
 * Per-match cumulative-points history for the leaderboard progress chart.
 * Mirrors db.js → getLeaderboardSLHistory() exactly:
 *   - locked matches only (same gate as getLeaderboardSL)
 *   - applies transfer penalties per (squad, match)
 *   - maps booster keys to display emoji
 */

import { supabase } from './supabase';

export type HistorySquad = {
  squadId:     string;
  userId:      string;
  squadName:   string;
  displayName: string | null;
};

export type HistorySeries = {
  [squadId: string]: { matchNumber: number; pts: number; cumulative: number }[];
};

export type HistoryBooster = {
  squadId:     string;
  matchNumber: number;
  booster:     string; // emoji
};

export type LeaderboardHistory = {
  squads:   HistorySquad[];
  series:   HistorySeries;
  boosters: HistoryBooster[];
};

// ── Pagination helper (same 1000-row cap as Supabase default) ─────────────────

async function fetchAllRows<T>(
  queryFn: (from: number, to: number) => any,
  pageSize = 1000,
): Promise<T[]> {
  const result: T[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await queryFn(from, from + pageSize - 1);
    if (error) throw error;
    if (!data?.length) break;
    result.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return result;
}

const BOOSTER_EMOJI: Record<string, string> = {
  triple_captain: '⚡',
  dual_captain:   '👥',
  team_double:    '🚀',
  free_hit:       '🔄',
  wildcard:       '♾️',
  indian_double:  '🇺🇸',
  os_double:      '✈️',
};

// ─────────────────────────────────────────────────────────────────────────────

export async function getLeaderboardHistory(contestId: string): Promise<LeaderboardHistory> {
  const { data: squadRows, error: sErr } = await supabase
    .from('user_squads')
    .select('id, name, user_id')
    .eq('contest_id', contestId);
  if (sErr) throw sErr;
  if (!squadRows?.length) return { squads: [], series: {}, boosters: [] };

  const squadIds = squadRows.map((s: any) => s.id);

  // Display names from profiles
  const userIds = [...new Set(squadRows.map((s: any) => s.user_id).filter(Boolean))] as string[];
  const profileMap: Record<string, string> = {};
  if (userIds.length) {
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, display_name, email, team_name, first_name, last_name')
      .in('id', userIds);
    (profiles || []).forEach((p: any) => {
      profileMap[p.id] =
        p.display_name || p.team_name ||
        (p.first_name && p.last_name ? `${p.first_name} ${p.last_name}` : null) ||
        p.email || 'Unknown';
    });
  }

  const [scores, xferRows, boosterRows] = await Promise.all([
    fetchAllRows<any>((from, to) =>
      supabase.from('user_match_xi_scores')
        .select('squad_id, match_id, total_points')
        .in('squad_id', squadIds).range(from, to)),
    fetchAllRows<any>((from, to) =>
      supabase.from('user_transfers')
        .select('squad_id, match_id, points_deducted')
        .in('squad_id', squadIds).range(from, to)),
    fetchAllRows<any>((from, to) =>
      supabase.from('user_booster_activations')
        .select('squad_id, match_id, booster')
        .in('squad_id', squadIds).range(from, to)),
  ]);

  // Fetch match metadata (match_number + lock status) for all referenced matches
  const allMatchIds = [...new Set([
    ...scores.map((s: any) => s.match_id),
    ...xferRows.map((t: any) => t.match_id),
    ...boosterRows.map((b: any) => b.match_id),
  ].filter(Boolean))] as string[];

  const matchMeta: Record<string, { matchNumber: number; locked: boolean }> = {};
  if (allMatchIds.length) {
    const { data: matchRows } = await supabase
      .from('matches')
      .select('id, match_number, lock_time, start_time')
      .in('id', allMatchIds);
    const now = Date.now();
    (matchRows || []).forEach((m: any) => {
      const lockAt = m.lock_time ?? m.start_time ?? null;
      matchMeta[m.id] = {
        matchNumber: m.match_number,
        locked: !!(lockAt && new Date(lockAt).getTime() <= now),
      };
    });
  }

  const isLocked = (id: string) => matchMeta[id]?.locked ?? false;

  // Transfer penalties per (squad::match) — locked only
  const penMap: Record<string, number> = {};
  xferRows.forEach((t: any) => {
    if (!isLocked(t.match_id)) return;
    const k = `${t.squad_id}::${t.match_id}`;
    penMap[k] = (penMap[k] || 0) + Number(t.points_deducted ?? 0);
  });

  // Raw points per (squad, match) — locked only
  const rawBySquadMatch: Record<string, Record<string, number>> = {};
  scores.forEach((s: any) => {
    if (!isLocked(s.match_id) || !matchMeta[s.match_id]) return;
    if (!rawBySquadMatch[s.squad_id]) rawBySquadMatch[s.squad_id] = {};
    rawBySquadMatch[s.squad_id][s.match_id] =
      (rawBySquadMatch[s.squad_id][s.match_id] || 0) + Number(s.total_points ?? 0);
  });

  // Build cumulative series per squad
  const series: HistorySeries = {};
  for (const sq of squadRows) {
    const byMatch = rawBySquadMatch[sq.id] || {};
    const entries = Object.entries(byMatch)
      .map(([mid, raw]) => ({
        matchNumber: matchMeta[mid].matchNumber,
        pts:         (raw as number) - (penMap[`${sq.id}::${mid}`] || 0),
      }))
      .sort((a, b) => a.matchNumber - b.matchNumber);
    let cum = 0;
    series[sq.id] = entries.map(e => {
      cum += e.pts;
      return { matchNumber: e.matchNumber, pts: e.pts, cumulative: Math.round(cum * 10) / 10 };
    });
  }

  const boosters: HistoryBooster[] = boosterRows
    .filter((b: any) => isLocked(b.match_id) && matchMeta[b.match_id])
    .map((b: any) => ({
      squadId:     b.squad_id,
      matchNumber: matchMeta[b.match_id].matchNumber,
      booster:     BOOSTER_EMOJI[b.booster] ?? '⚡',
    }));

  return {
    squads: squadRows.map((s: any) => ({
      squadId:     s.id,
      userId:      s.user_id,
      squadName:   s.name,
      displayName: profileMap[s.user_id] ?? null,
    })),
    series,
    boosters,
  };
}
