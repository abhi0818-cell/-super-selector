import { create } from 'zustand';
import { Session, User } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';

interface AuthState {
  session:     Session | null;
  user:        User | null;
  loading:     boolean;
  initialized: boolean;

  // Actions
  signUp:       (email: string, password: string, profile: { firstName: string; lastName: string; teamName: string }) => Promise<string | null>;
  signIn:       (email: string, password: string) => Promise<string | null>;
  signOut:      () => Promise<void>;
  setSession:   (session: Session | null) => void;
  setInitialized: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  session:     null,
  user:        null,
  loading:     false,
  initialized: false,

  setSession: (session) => set({
    session,
    user: session?.user ?? null,
  }),

  setInitialized: () => set({ initialized: true }),

  signUp: async (email, password, { firstName, lastName, teamName }) => {
    set({ loading: true });
    const fullName = `${firstName} ${lastName}`.trim();
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName, first_name: firstName, last_name: lastName, team_name: teamName } },
    });
    if (!error && data.user) {
      // Write the profiles row directly — mobile-only users (who may never
      // open the web client) would otherwise never get one, since today
      // it's only upserted from the web client's login flow. Non-blocking:
      // if email confirmation is required there's no active session yet
      // and this will fail RLS — that's fine, the web client's upsert (or
      // a later mobile login) will create the row once they do have one.
      try {
        await supabase.from('profiles').upsert({
          id: data.user.id,
          display_name: fullName,
          email,
          first_name: firstName,
          last_name: lastName,
          team_name: teamName,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'id' });
      } catch (e) {
        console.warn('profile upsert failed', e);
      }
    }
    set({ loading: false });
    if (error) return error.message;
    return null; // null = success
  },

  signIn: async (email, password) => {
    set({ loading: true });
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    set({ loading: false });
    if (error) return error.message;
    return null;
  },

  signOut: async () => {
    set({ loading: true });
    await supabase.auth.signOut();
    set({ loading: false, session: null, user: null });
  },
}));
