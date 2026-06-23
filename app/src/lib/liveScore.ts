/**
 * Live score — mirrors web's admin "Live scorecard" panel (index.html's
 * renderScorecard()/renderScores(), fed by state.lastScorecard), but reads
 * from match_scorecards directly instead of holding API state client-side.
 *
 * Data path: poll-cricapi/scrape-scorecard (Edge Functions) run server-side
 * every 15-30 min while a match is in_progress and upsert the raw CricAPI/
 * scraper payload into `match_scorecards.payload` (one row per match,
 * public-read RLS — see migration_v17_rls.sql). That's the SAME row web's
 * admin panel reads via state.lastScorecard, so this is a faithful port, not
 * a re-derivation — no CricAPI key or admin access needed on the client.
 *
 * payload shape (CricAPI's own scorecard endpoint, passed through as-is):
 *   { data: { matchInfo, scorecard: [ { inning, r|runs, w|wickets, o|overs,
 *             batting: [...], bowling: [...] }, ... ] } }
 * (some payloads have `data` flattened to the top level — handled below,
 * same as web's `payload.data ?? payload`.)
 */

import { useEffect, useState } from 'react';
import { supabase } from './supabase';

// ─── Types ─────────────────────────────────────────────────────────────────

export type LiveBatter = {
  name: string; runs: number; balls: number; fours: number; sixes: number;
  dismissal: string;
};

export type LiveBowler = {
  name: string; overs: number; maidens: number; runs: number; wickets: number;
};

export type LiveInningsScore = {
  team: string; runs: number; wickets: number; overs: number;
};

export type LiveInnings = LiveInningsScore & {
  batting: LiveBatter[];
  bowling: LiveBowler[];
};

export type LiveScore = {
  matchId:   string;
  status:    string;
  innings:   LiveInnings[];
  fetchedAt: string | null;
};

export type LiveMatch = {
  id:          string;
  matchNumber: number | null;
  homeTeamId:  string | null;
  awayTeamId:  string | null;
  format:      string;
};

// ─── Parsing helpers (mirror index.html's renderScores/renderBatRow/renderBowlRow) ──

function num(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function dismissalText(b: any): string {
  if (b.isDismissed === false || b.out === false) return 'not out';
  const raw = b.dismissal || b.outDesc || b['dismissal-text'] || '';
  return raw || (b.isDismissed || b.out ? 'out' : 'not out');
}

function parseInnings(raw: any): LiveInnings {
  const team = raw.inning || raw.battingteam || raw.batting_team || 'Innings';
  const batting: LiveBatter[] = (raw.batting || []).map((b: any) => ({
    name:      b.batsman?.name || b.batsman || b.name || b.player?.name || 'Unknown',
    runs:      num(b.r ?? b.runs),
    balls:     num(b.b ?? b.balls),
    fours:     num(b['4s'] ?? b.fours),
    sixes:     num(b['6s'] ?? b.sixes),
    dismissal: dismissalText(b),
  }));
  const bowling: LiveBowler[] = (raw.bowling || raw.bowlers || raw.bowl || []).map((bw: any) => ({
    name:    bw.bowler?.name || bw.bowler || bw.name || bw.player?.name || 'Unknown',
    overs:   num(bw.o ?? bw.overs),
    maidens: num(bw.m ?? bw.maidens),
    runs:    num(bw.r ?? bw.runs),
    wickets: num(bw.w ?? bw.wickets),
  }));
  return {
    team,
    runs:    num(raw.r ?? raw.runs),
    wickets: num(raw.w ?? raw.wickets),
    overs:   num(raw.o ?? raw.overs),
    batting,
    bowling,
  };
}

// ─── Data fetchers ─────────────────────────────────────────────────────────

/**
 * Current in_progress match for a tournament (at most one, normally) —
 * mirrors the scope poll-cricapi/scrape-scorecard query server-side.
 */
export async function getLiveMatch(tournamentId: string | null): Promise<LiveMatch | null> {
  if (!tournamentId) return null;
  // Two distinct writers flag a match as "live": lock-matches sets 'live' at
  // kickoff, poll-cricapi later sets 'in_progress' once CricAPI confirms play.
  // Every other consumer (teamStore.ts, PlayerPickerScreen.tsx, index.html)
  // treats both as "currently live" — match this convention.
  const { data, error } = await supabase
    .from('matches')
    .select('id, match_number, home_team_id, away_team_id, format')
    .eq('tournament_id', tournamentId)
    .in('status', ['live', 'in_progress'])
    .order('match_number', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    id:          data.id,
    matchNumber: data.match_number ?? null,
    homeTeamId:  data.home_team_id ?? null,
    awayTeamId:  data.away_team_id ?? null,
    format:      data.format,
  };
}

/** Reads the cached scorecard payload for one match — see file header. */
export async function getLiveScore(matchId: string | null): Promise<LiveScore | null> {
  if (!matchId) return null;
  const { data, error } = await supabase
    .from('match_scorecards')
    .select('payload, fetched_at')
    .eq('match_id', matchId)
    .maybeSingle();
  if (error) throw error;
  if (!data?.payload) return null;

  const payload: any = data.payload;
  const body         = payload.data ?? payload;
  const rawInnings: any[] = body.scorecard ?? body.innings ?? body.scores ?? [];
  const info          = body.matchInfo || body;
  const status        = info.status || body.status || '';

  return {
    matchId,
    status,
    innings:   rawInnings.map(parseInnings),
    fetchedAt: data.fetched_at ?? null,
  };
}

/** Compact "IND 145/3 (15.2)" line — mirrors web's renderScores(). Shows
 * every innings with any runs/wickets/overs recorded so far, joined with " · ". */
export function formatLiveScoreLine(score: LiveScore | null): string {
  if (!score || !score.innings.length) return '';
  return score.innings
    .filter(i => i.runs || i.wickets || i.overs)
    .map(i => `${i.team} ${i.runs}/${i.wickets} (${i.overs})`)
    .join('  ·  ');
}

// ─── Hooks ─────────────────────────────────────────────────────────────────

const POLL_MS = 30_000;

/** Polls for the current in_progress match in a tournament. */
export function useLiveMatch(tournamentId: string | null): LiveMatch | null {
  const [match, setMatch] = useState<LiveMatch | null>(null);
  useEffect(() => {
    if (!tournamentId) { setMatch(null); return; }
    let cancelled = false;
    const refresh = async () => {
      try {
        const m = await getLiveMatch(tournamentId);
        if (!cancelled) setMatch(m);
      } catch (e) {
        console.warn('[useLiveMatch] failed:', e);
      }
    };
    refresh();
    const iv = setInterval(refresh, POLL_MS);
    return () => { cancelled = true; clearInterval(iv); };
  }, [tournamentId]);
  return match;
}

/** Polls the scorecard for one match. */
export function useLiveScore(matchId: string | null): { score: LiveScore | null; loading: boolean } {
  const [score, setScore]     = useState<LiveScore | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!matchId) { setScore(null); return; }
    let cancelled = false;
    const refresh = async () => {
      setLoading(true);
      try {
        const s = await getLiveScore(matchId);
        if (!cancelled) setScore(s);
      } catch (e) {
        console.warn('[useLiveScore] failed:', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    refresh();
    const iv = setInterval(refresh, POLL_MS);
    return () => { cancelled = true; clearInterval(iv); };
  }, [matchId]);
  return { score, loading };
}
