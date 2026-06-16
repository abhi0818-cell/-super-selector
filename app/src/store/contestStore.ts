/**
 * Contest Store
 * Loads active contests from Supabase and tracks which contest the user
 * is currently picking their XI for.
 */

import { create } from 'zustand';
import { ContestContext, ContestType, PrivateLeague, LeagueRuleType } from '../types';
import { supabase } from '../lib/supabase';

// ─── Map DB contest_type → app ContestType ────────────────────────────────────

function mapContestType(dbType: string, isPrivate: boolean): ContestType {
  if (isPrivate) return 'private';
  const t = (dbType ?? '').toLowerCase();
  if (t === 'sl' || t.includes('season') || t.includes('long')) return 'sl';
  return 'daily';
}

// ─── Exported for LeaderboardScreen tab building ──────────────────────────────

export type RealContest = {
  id:          string;   // UUID
  name:        string;
  contestType: ContestType;
  isPrivate:   boolean;
  inviteCode:  string | null;
  deadline:    string;   // ISO string (start_time of first locked match)
};

// ─── Fallback mock private leagues (used until real contests load) ─────────────

export const MOCK_PRIVATE_LEAGUES: PrivateLeague[] = [
  {
    id:       'pl01',
    name:     'Office Fantasy League',
    members:  8,
    rank:     3,
    ruleType: 'standard',
    deadline: '2026-06-01T14:30:00Z',
    isActive: true,
  },
  {
    id:       'pl02',
    name:     'Friends XI',
    members:  5,
    rank:     1,
    ruleType: 'standard',
    deadline: '2026-06-01T14:30:00Z',
    isActive: true,
  },
];

// ─── Store interface ──────────────────────────────────────────────────────────

interface ContestState {
  activeContext:   ContestContext | null;
  contests:        RealContest[];         // loaded from Supabase
  contestsLoading: boolean;

  setContext:    (ctx: ContestContext | null) => void;
  clearContext:  () => void;
  loadContests:  (tournamentId: string) => Promise<void>;
}

// ─── Store ────────────────────────────────────────────────────────────────────

export const useContestStore = create<ContestState>((set) => ({
  activeContext:   null,
  contests:        [],
  contestsLoading: false,

  setContext:  (ctx) => set({ activeContext: ctx }),
  clearContext: ()  => set({ activeContext: null }),

  loadContests: async (tournamentId) => {
    // Clear stale contests immediately so the UI never shows data from a previous tournament
    set({ contests: [], contestsLoading: true });
    try {
      const { data, error } = await supabase
        .from('contests')
        .select('id, name, contest_type, is_private, invite_code, is_active')
        .eq('tournament_id', tournamentId)
        .eq('is_active', true)
        .order('is_private', { ascending: true })   // public contests first
        .order('contest_type', { ascending: true }); // daily before season_long

      if (error) throw error;

      const mapped: RealContest[] = (data ?? []).map((c: any) => ({
        id:          c.id,
        name:        c.name,
        contestType: mapContestType(c.contest_type, c.is_private),
        isPrivate:   Boolean(c.is_private),
        inviteCode:  c.invite_code ?? null,
        deadline:    '2099-01-01T00:00:00Z',
      }));

      console.log('[contestStore] loaded', mapped.length, 'contests for tournament', tournamentId,
        mapped.map(c => `${c.name}(${c.contestType},private=${c.isPrivate})`));

      set({ contests: mapped });
    } catch (err) {
      console.warn('[contestStore] loadContests failed:', err);
    } finally {
      set({ contestsLoading: false });
    }
  },
}));

// ─── Helpers for ContestPicker and LeaderboardScreen ─────────────────────────

/** Convert a RealContest into a ContestContext for selection */
export function toContestContext(c: RealContest): ContestContext {
  return {
    contestId:   c.id,
    contestType: c.contestType,
    leagueId:    c.isPrivate ? c.id : null,
    leagueName:  c.name,
    ruleType:    'standard' as LeagueRuleType,
    deadline:    c.deadline,
  };
}

/** Returns active leagues as the old PrivateLeague[] shape (for backward compat) */
export function getActiveLeagues(leagues: PrivateLeague[]): PrivateLeague[] {
  return [...leagues]
    .filter(l => l.isActive)
    .sort((a, b) => new Date(a.deadline).getTime() - new Date(b.deadline).getTime());
}
