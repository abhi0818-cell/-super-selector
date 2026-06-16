/**
 * Booster Store
 * Season Long / private leagues only.
 *
 * Booster definitions live in contests.available_boosters (string[] in DB).
 * Which ones have been used is tracked in user_booster_activations.
 *
 * Scope controls which player tiles show the booster icon when active:
 *   'captain'       → only the Captain tile
 *   'vice_captain'  → only the Vice-Captain tile
 *   'all'           → every tile in the XI (e.g. "Team Double")
 *
 * Slot controls conflict: two boosters in the same slot cannot both be active.
 */

import { create } from 'zustand';
import { supabase } from '../lib/supabase';
import { CaptaincyRole } from '../types';

// ─── Types ────────────────────────────────────────────────────────────────────

export type BoosterStatus = 'available' | 'active' | 'used';
export type BoosterScope  = 'captain' | 'vice_captain' | 'all';
export type BoosterSlot   = 'captain' | 'vice_captain' | 'squad' | 'transfers';

export interface Booster {
  id:     string;
  icon:   string;
  name:   string;
  desc:   string;
  scope:  BoosterScope;
  slot:   BoosterSlot;
  status: BoosterStatus;
}

// ─── Static metadata (mirrors BOOSTER_META in index.html) ────────────────────

interface BoosterMeta {
  icon:  string;
  name:  string;
  desc:  string;
  scope: BoosterScope;
  slot:  BoosterSlot;
}

const BOOSTER_META: Record<string, BoosterMeta> = {
  triple_captain: {
    icon:  '⚡',
    name:  'Triple Captain',
    desc:  "Your Captain scores 3× their base points for one match. Use once per season.",
    scope: 'captain',
    slot:  'captain',
  },
  dual_captain: {
    icon:  '👥',
    name:  'Dual Captain',
    desc:  "Both Captain and Vice-Captain score 2× their base points for one match. Use once per season.",
    scope: 'vice_captain',
    slot:  'vice_captain',
  },
  team_double: {
    icon:  '🚀',
    name:  'Team Double',
    desc:  "All 11 players score double points this matchweek. Use once per season.",
    scope: 'all',
    slot:  'squad',
  },
  free_hit: {
    icon:  '🔄',
    name:  'Free Hit',
    desc:  "One extra free transfer this matchweek at no points cost. Use once per season.",
    scope: 'all',
    slot:  'transfers',
  },
  wildcard: {
    icon:  '♾️',
    name:  'Wildcard',
    desc:  "Unlimited transfers this matchweek, no points deduction. Use once per season.",
    scope: 'all',
    slot:  'transfers',
  },
  indian_double: {
    icon:  '🇺🇸',
    name:  'US Double',
    desc:  "All US domestic (non-overseas) players in your XI score 2× their base points. Use once per season.",
    scope: 'all',
    slot:  'squad',
  },
  os_double: {
    icon:  '✈️',
    name:  'OS Double',
    desc:  "All overseas players in your XI score 2× their base points. Use once per season.",
    scope: 'all',
    slot:  'squad',
  },
  // Legacy names (kept for backward compat with old DB rows)
  super_cap: {
    icon:  '⚡',
    name:  'Super Captain',
    desc:  "Doubles your Captain's 2× multiplier to 4×. Use once per season.",
    scope: 'captain',
    slot:  'captain',
  },
  super_vc: {
    icon:  '🚀',
    name:  'Super Vice-Captain',
    desc:  "Doubles your Vice-Captain's 1.5× multiplier to 3×. Use once per season.",
    scope: 'vice_captain',
    slot:  'vice_captain',
  },
};

// ─── Tile-boost helper ────────────────────────────────────────────────────────

const TRANSFER_IDS = new Set(['free_hit', 'wildcard']);

export function getActiveTileBoosts(
  captaincy: CaptaincyRole,
  activeBoosters: Booster[],
): Booster[] {
  return activeBoosters.filter(b => {
    if (TRANSFER_IDS.has(b.id)) return false;
    if (b.scope === 'all')                                         return true;
    if (b.scope === 'captain'      && captaincy === 'captain')     return true;
    if (b.scope === 'vice_captain' && captaincy === 'vice_captain') return true;
    return false;
  });
}

// ─── Store ────────────────────────────────────────────────────────────────────

interface BoosterState {
  boosters:        Booster[];
  loading:         boolean;

  /**
   * Load boosters for a squad + match.
   * - Fetches available_boosters from the contest
   * - Marks used ones from user_booster_activations
   * - Marks wildcard/free_hit as 'used' (unavailable) when isFirstMatch is true
   *   (first match of the season or first match of playoffs — transfers already unlimited)
   * - Marks all non-active boosters as 'used' when another is already active for this match
   *   (only one booster can be active at a time)
   */
  loadBoosters:   (contestId: string, squadId: string | null, matchId: string, isFirstMatch?: boolean) => Promise<void>;

  /**
   * Activate a booster in Supabase and update local state.
   * Same-slot rule enforced locally; call lockBooster to persist.
   */
  activateBooster: (squadId: string, matchId: string, boosterId: string) => Promise<void>;

  /**
   * Deactivate the active booster for this match — deletes the DB row and
   * resets local state. Safe to call before match lock.
   */
  deactivateBooster: (squadId: string, matchId: string) => Promise<void>;

  /**
   * Toggle a booster on/off (local state only — call activateBooster to persist).
   */
  toggleBooster:   (id: string) => void;

  /** All currently active boosters */
  activeBoosters:  () => Booster[];
}

export const useBoosterStore = create<BoosterState>((set, get) => ({
  boosters: [],
  loading:  false,

  loadBoosters: async (contestId, squadId, matchId, isFirstMatch = false) => {
    set({ loading: true });
    try {
      // 1. Fetch which boosters this contest offers
      const { data: contestRow, error: contestErr } = await supabase
        .from('contests')
        .select('available_boosters')
        .eq('id', contestId)
        .single();

      if (contestErr) throw contestErr;

      // available_boosters is stored as {boosterId: numberOfUses} object in DB.
      // Also handle legacy string[] format just in case.
      const rawBoosters = contestRow?.available_boosters;
      const availableMap: Record<string, number> = {};
      if (rawBoosters) {
        if (Array.isArray(rawBoosters)) {
          (rawBoosters as string[]).forEach(id => { availableMap[id] = 1; });
        } else if (typeof rawBoosters === 'object') {
          Object.entries(rawBoosters).forEach(([id, uses]) => {
            availableMap[id] = typeof uses === 'number' ? uses : 1;
          });
        }
      }
      const available = Object.keys(availableMap);

      // 2. Fetch activations for this squad (all matches) — only if a squad exists
      let   activeId   = '';            // booster active for THIS specific match
      const usedCounts: Record<string, number> = {};  // uses consumed in OTHER matches

      if (squadId) {
        const { data: activations } = await supabase
          .from('user_booster_activations')
          .select('booster, match_id')
          .eq('squad_id', squadId);

        (activations ?? []).forEach((row: any) => {
          if (row.match_id === matchId) {
            activeId = row.booster;
          } else {
            // Count uses across other matches (to check if all uses are exhausted)
            usedCounts[row.booster] = (usedCounts[row.booster] ?? 0) + 1;
          }
        });
      }
      // If no squad yet, all boosters show as 'available' (no activations possible)

      // Transfer boosters are pointless on the first match of a season or playoffs
      // (transfers are already unlimited on those matches)
      const TRANSFER_BOOSTERS = new Set(['wildcard', 'free_hit']);

      // 3. Build Booster objects
      const boosters: Booster[] = available.map(id => {
        const meta = BOOSTER_META[id] ?? {
          icon: '🎯', name: id, desc: '', scope: 'all' as BoosterScope, slot: 'squad' as BoosterSlot,
        };

        let status: BoosterStatus = 'available';

        const totalUses   = availableMap[id] ?? 1;
        const usedInOther = usedCounts[id]   ?? 0;
        const exhausted   = usedInOther >= totalUses;  // all uses spent in OTHER matches

        if (id === activeId) {
          // Active for this match — always deactivatable regardless of remaining uses
          status = 'active';
        } else if (exhausted) {
          status = 'used';
        } else if (isFirstMatch && TRANSFER_BOOSTERS.has(id)) {
          // Wildcard / Free Hit unavailable on first match of season or playoffs
          status = 'used';
        } else if (activeId) {
          // Another booster is already active for this match — only one allowed at a time
          status = 'used';
        }

        return { id, ...meta, status };
      });

      set({ boosters });
    } catch (err) {
      console.warn('[boosterStore] loadBoosters failed:', err);
    } finally {
      set({ loading: false });
    }
  },

  activateBooster: async (squadId, matchId, boosterId) => {
    // Optimistic local update first
    get().toggleBooster(boosterId);

    try {
      const { error } = await supabase
        .from('user_booster_activations')
        .upsert(
          { squad_id: squadId, match_id: matchId, booster: boosterId },
          { onConflict: 'squad_id,match_id' },
        );
      if (error) {
        // Roll back local toggle on failure
        get().toggleBooster(boosterId);
        throw error;
      }
    } catch (err) {
      console.warn('[boosterStore] activateBooster failed:', err);
      throw err;
    }
  },

  deactivateBooster: async (squadId, matchId) => {
    // Optimistic local update: reset the active booster to 'available' immediately
    set(state => ({
      boosters: state.boosters.map(b =>
        b.status === 'active' ? { ...b, status: 'available' } : b,
      ),
    }));

    try {
      const { error } = await supabase
        .from('user_booster_activations')
        .delete()
        .eq('squad_id', squadId)
        .eq('match_id', matchId);
      if (error) {
        // Roll back on failure — reload from DB to get accurate state
        console.warn('[boosterStore] deactivateBooster failed:', error);
        throw error;
      }
    } catch (err) {
      console.warn('[boosterStore] deactivateBooster failed:', err);
      throw err;
    }
  },

  toggleBooster: (id) => {
    set(state => {
      const target = state.boosters.find(b => b.id === id);
      if (!target || target.status === 'used') return state;

      const becomingActive = target.status !== 'active';
      return {
        boosters: state.boosters.map(b => {
          if (b.id === id) {
            return { ...b, status: becomingActive ? 'active' : 'available' };
          }
          // Only one booster can be active at a time — deactivate any other active booster
          if (becomingActive && b.status === 'active') {
            return { ...b, status: 'available' };
          }
          return b;
        }),
      };
    });
  },

  activeBoosters: () => get().boosters.filter(b => b.status === 'active'),
}));
