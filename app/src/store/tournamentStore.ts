/**
 * Tournament Store
 *
 * Loads all is_active tournaments from Supabase and tracks which one the
 * user has chosen to play. The selection is persisted in AsyncStorage so
 * it survives app restarts.
 *
 * Downstream stores (teamStore, contestStore) read selectedTournamentId
 * from here rather than auto-detecting by date.
 */

import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../lib/supabase';

const STORAGE_KEY = 'selectedTournamentId';

export type Tournament = {
  id:         string;
  name:       string;
  format:     string;   // 'T20' | 'ODI' | 'TEST'
  startDate:  string | null;
  endDate:    string | null;
  isActive:   boolean;
};

interface TournamentState {
  tournaments:           Tournament[];
  selectedTournamentId:  string | null;
  loading:               boolean;

  // Load all is_active=true tournaments, restore persisted selection
  loadTournaments:       () => Promise<void>;

  // Explicitly pick a tournament (persists the choice)
  selectTournament:      (id: string) => Promise<void>;

  // Clear selection (returns user to lobby)
  clearSelection:        () => Promise<void>;
}

export const useTournamentStore = create<TournamentState>((set, get) => ({
  tournaments:          [],
  selectedTournamentId: null,
  loading:              false,

  loadTournaments: async () => {
    set({ loading: true });
    try {
      const { data, error } = await supabase
        .from('tournaments')
        .select('id, name, format, start_date, end_date, is_active')
        .eq('is_active', true)
        .order('start_date', { ascending: false });

      if (error) throw error;

      const tournaments: Tournament[] = (data ?? []).map((t: any) => ({
        id:        t.id,
        name:      t.name,
        format:    t.format,
        startDate: t.start_date ?? null,
        endDate:   t.end_date   ?? null,
        isActive:  t.is_active,
      }));

      // Restore persisted selection if it's still valid
      const storedId = await AsyncStorage.getItem(STORAGE_KEY);
      const stillActive = tournaments.find(t => t.id === storedId);
      const selectedTournamentId = stillActive?.id ?? null;

      set({ tournaments, selectedTournamentId });
    } catch (err) {
      console.warn('[tournamentStore] loadTournaments failed:', err);
    } finally {
      set({ loading: false });
    }
  },

  selectTournament: async (id) => {
    set({ selectedTournamentId: id });
    try {
      await AsyncStorage.setItem(STORAGE_KEY, id);
    } catch (err) {
      console.warn('[tournamentStore] failed to persist selection:', err);
    }
  },

  clearSelection: async () => {
    set({ selectedTournamentId: null });
    try {
      await AsyncStorage.removeItem(STORAGE_KEY);
    } catch (err) {
      console.warn('[tournamentStore] failed to clear selection:', err);
    }
  },
}));
