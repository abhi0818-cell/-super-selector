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

// ─── Public type ──────────────────────────────────────────────────────────────

export type LBEntry = {
  rank:          number;
  userId:        string;
  squadId:       string;   // user_squads.id — needed to load this squad's per-match history
  displayName:   string;
  teamName:      string;
  points:        number;
  isCurrentUser: boolean;
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

      // Step 2b: fetch transfer penalties and subtract from totals
      const { data: transfers } = await supabase
        .from('user_transfers')
        .select('squad_id, points_deducted')
        .in('squad_id', squadIds);

      const penaltyBySquad: Record<string, number> = {};
      (transfers ?? []).forEach((t: any) => {
        penaltyBySquad[t.squad_id] = (penaltyBySquad[t.squad_id] ?? 0) + Number(t.points_deducted ?? 0);
      });

      // Step 3: fetch display names from profiles
      const userIds = [...new Set(squads.map((s: any) => s.user_id))];
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, display_name')
        .in('id', userIds);

      const nameById: Record<string, string> = {};
      (profiles ?? []).forEach((p: any) => { nameById[p.id] = p.display_name ?? 'Player'; });

      // Step 4: build ranked entries
      const uid = get().currentUserId;
      const unsorted: Omit<LBEntry, 'rank'>[] = squads.map((sq: any) => ({
        userId:        sq.user_id,
        squadId:       sq.id,
        displayName:   nameById[sq.user_id] ?? 'Player',
        teamName:      sq.name ?? 'My Squad',
        points:        (pointsBySquad[sq.id] ?? 0) - (penaltyBySquad[sq.id] ?? 0),
        isCurrentUser: sq.user_id === uid,
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
