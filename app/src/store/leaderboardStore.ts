/**
 * Leaderboard Store — Zustand
 * Aggregates user_match_xi_scores → user_squads → profiles to produce ranked entries.
 * Falls back gracefully (keeps existing data) on error or empty result.
 *
 * Real schema used:
 *   user_squads       (id, contest_id, user_id, name)
 *   user_match_xi_scores (squad_id, total_points)
 *   profiles          (id, display_name)
 */

import { create } from 'zustand';
import { supabase } from '../lib/supabase';
import { isMatchLocked, findNextUnlockedMatch } from '../lib/matchLock';
import { resolveDisplayName } from '../lib/profileUtils';
import { resolveBudgetWindow, MatchLite } from '../lib/transferCap';

// ─── Public type ──────────────────────────────────────────────────────────────

export type LBEntry = {
  rank:          number;
  userId:        string;
  squadId:       string;   // user_squads.id — needed to load this squad's per-match history
  displayName:   string;
  teamName:      string;
  points:        number;
  isCurrentUser: boolean;
  // SL/private-league only (mirrors web's getLeaderboardSL) — undefined for daily contests.
  transferCount?:    number;
  transfersAllowed?: number | null; // null = unlimited, shown as '-'
  boosterCount?:     number;
  boosterAllowed?:   number;        // 0 = contest has no booster budget configured
};

// ─── Store interface ──────────────────────────────────────────────────────────

interface LeaderboardState {
  entries:       Record<string, LBEntry[]>;  // keyed by contest UUID
  loading:       boolean;
  currentUserId: string | null;

  setCurrentUser:  (uid: string | null) => void;
  loadLeaderboard: (contestId: string) => Promise<void>;
}

// ─── Store ────────────────────────────────────────────────────────────────────

export const useLeaderboardStore = create<LeaderboardState>((set, get) => ({
  entries:       {},
  loading:       false,
  currentUserId: null,

  setCurrentUser: (uid) => set({ currentUserId: uid }),

  // Aggregate total_points per squad for a contest, join profiles for display info
  loadLeaderboard: async (contestId: string) => {
    if (!contestId) return;
    set({ loading: true });

    try {
      // Step 1: get all squads for this contest
      const { data: squads, error: squadsErr } = await supabase
        .from('user_squads')
        .select('id, user_id, name')
        .eq('contest_id', contestId);

      if (squadsErr) throw squadsErr;
      if (!squads || squads.length === 0) {
        // Nothing in DB yet → keep existing (mock) data
        return;
      }

      const squadIds = squads.map((s: any) => s.id);

      // Step 2: sum total_points per squad across all matches
      const { data: scores, error: scoresErr } = await supabase
        .from('user_match_xi_scores')
        .select('squad_id, total_points')
        .in('squad_id', squadIds);

      if (scoresErr) throw scoresErr;

      // Aggregate points per squad
      const pointsBySquad: Record<string, number> = {};
      (scores ?? []).forEach((s: any) => {
        pointsBySquad[s.squad_id] = (pointsBySquad[s.squad_id] ?? 0) + Number(s.total_points);
      });

      // Step 2b: fetch transfer penalties and subtract from totals; also
      // count rows per squad for the SL "Xfers used/allowed" column (mirrors
      // db.js's getLeaderboardSL). match_id is needed to gate the COUNT on
      // lock status below (points penalty is left as-is — not what was
      // reported).
      const { data: transfers } = await supabase
        .from('user_transfers')
        .select('squad_id, match_id, points_deducted')
        .in('squad_id', squadIds);

      const penaltyBySquad: Record<string, number> = {};
      (transfers ?? []).forEach((t: any) => {
        penaltyBySquad[t.squad_id] = (penaltyBySquad[t.squad_id] ?? 0) + Number(t.points_deducted ?? 0);
      });

      // Step 2c: SL/private-league-only columns — contest-level booster/transfer
      // caps, plus each squad's booster-activation count. Cheap no-ops for
      // daily contests (booster_allowed comes back 0, counts come back empty),
      // so it's safe to always fetch rather than branch on contest type here.
      //
      // Xfers cap is PHASE-AWARE, not a flat total_transfers_allowed — mirrors
      // web's getLeaderboardSL (db.js). Once the playoff phase starts, the
      // relevant cap is playoff_transfers_allowed (pooled across the playoff
      // matches), and if playoff_first_match_unlimited is set, the first
      // playoff match resolves to fully unlimited (null cap). Previously this
      // always used the flat season total, so it kept counting down from the
      // league-stage figure straight through the playoff opener.
      const { data: contestRow } = await supabase
        .from('contests')
        .select('tournament_id, available_boosters, total_transfers_allowed, start_match_number, playoff_start_match_number, playoff_transfers_allowed, playoff_first_match_unlimited')
        .eq('id', contestId)
        .maybeSingle();
      const boosterAllowed = contestRow?.available_boosters
        ? Object.values(contestRow.available_boosters as Record<string, number>)
            .reduce((sum: number, n) => sum + Number(n || 0), 0)
        : 0;

      let transfersAllowed = contestRow?.total_transfers_allowed ?? null;
      let phaseIds: Set<string> | null = null; // null = no phase filter (count everything, legacy behavior)
      if (contestRow?.tournament_id) {
        const { data: tournamentMatches } = await supabase
          .from('matches')
          .select('id, match_number, status, start_time, lock_time')
          .eq('tournament_id', contestRow.tournament_id);
        const allMatches = (tournamentMatches ?? []) as MatchLite[];
        const target = findNextUnlockedMatch(allMatches) ??
          allMatches.reduce<MatchLite | null>((best, m) =>
            (m.match_number ?? -Infinity) > (best?.match_number ?? -Infinity) ? m : best, null);
        const window = resolveBudgetWindow(
          target?.match_number ?? null,
          allMatches,
          contestRow.start_match_number         ?? null,
          contestRow.playoff_start_match_number ?? null,
          contestRow.total_transfers_allowed     ?? null,
          contestRow.playoff_transfers_allowed   ?? null,
          contestRow.playoff_first_match_unlimited ?? false,
        );
        transfersAllowed = window.activeCap;
        phaseIds = window.phaseIds;
      }

      const { data: boosterRows } = await supabase
        .from('user_booster_activations')
        .select('squad_id, match_id, booster')
        .in('squad_id', squadIds);

      // Both a booster activation AND a transfer are committed to the DB as
      // soon as a squad hits Save (mirrors the "save is the lock" model),
      // which can be well before the match they apply to actually starts.
      // Showing either on this PUBLIC leaderboard before that match locks
      // leaks strategy to opponents (e.g. "they've already burned Triple
      // Captain for next week" or "they just made 3 transfers") — so both
      // only count here once their match has actually locked.
      const candidateMatchIds = [
        ...(boosterRows ?? []).map((b: any) => b.match_id),
        ...(transfers ?? []).map((t: any) => t.match_id),
      ].filter(Boolean);
      const lockedMatchIds = new Set<string>();
      if (candidateMatchIds.length) {
        const { data: matchRows } = await supabase
          .from('matches')
          .select('id, lock_time, start_time, status')
          .in('id', [...new Set(candidateMatchIds)]);
        (matchRows ?? []).forEach((m: any) => {
          if (isMatchLocked(m)) lockedMatchIds.add(m.id);
        });
      }

      const boosterCountBySquad: Record<string, number> = {};
      // (squad_id, match_id) pairs where Wildcard/Free Hit was active — those
      // matches' transfers were free of cost and never actually charged
      // against the season cap, so transferCountBySquad below must exclude
      // them too, not just gate on lock status. Mirrors the equivalent fix
      // in web's getLeaderboardSL (db.js).
      const bypassedSquadMatch = new Set<string>();
      (boosterRows ?? []).forEach((b: any) => {
        if (!lockedMatchIds.has(b.match_id)) return; // match hasn't locked yet — don't count
        boosterCountBySquad[b.squad_id] = (boosterCountBySquad[b.squad_id] ?? 0) + 1;
        if (b.booster === 'wildcard' || b.booster === 'free_hit') {
          bypassedSquadMatch.add(b.squad_id + '::' + b.match_id);
        }
      });

      const transferCountBySquad: Record<string, number> = {};
      (transfers ?? []).forEach((t: any) => {
        if (!lockedMatchIds.has(t.match_id)) return; // match hasn't locked yet — don't count
        if (bypassedSquadMatch.has(t.squad_id + '::' + t.match_id)) return; // free transfer — never charged
        if (phaseIds !== null && !phaseIds.has(t.match_id)) return; // outside the current phase window
        transferCountBySquad[t.squad_id] = (transferCountBySquad[t.squad_id] ?? 0) + 1;
      });

      // Step 3: fetch leaderboard names from profiles (team_name preferred,
      // same convention as the web client — falls back to display_name for
      // pre-migration_v33 rows that haven't backfilled yet)
      const userIds = [...new Set(squads.map((s: any) => s.user_id))];
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, display_name, team_name')
        .in('id', userIds);

      const nameById: Record<string, string> = {};
      (profiles ?? []).forEach((p: any) => { nameById[p.id] = resolveDisplayName(p); });

      // Step 4: build ranked entries
      const uid = get().currentUserId;
      const unsorted: Omit<LBEntry, 'rank'>[] = squads.map((sq: any) => ({
        userId:           sq.user_id,
        squadId:          sq.id,
        displayName:      nameById[sq.user_id] ?? 'Player',
        teamName:         sq.name ?? 'My Squad',
        points:           (pointsBySquad[sq.id] ?? 0) - (penaltyBySquad[sq.id] ?? 0),
        isCurrentUser:    sq.user_id === uid,
        transferCount:    transferCountBySquad[sq.id] ?? 0,
        transfersAllowed,
        boosterCount:     boosterCountBySquad[sq.id] ?? 0,
        boosterAllowed,
      }));

      const sorted = unsorted
        .sort((a, b) => b.points - a.points)
        .map((e, i) => ({ ...e, rank: i + 1 }));

      if (sorted.length > 0) {
        set(state => ({ entries: { ...state.entries, [contestId]: sorted } }));
      }
    } catch (err) {
      console.warn('[leaderboardStore] loadLeaderboard failed:', err);
    } finally {
      set({ loading: false });
    }
  },
}));
