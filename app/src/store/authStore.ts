import { create } from 'zustand';
import { Session, User } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';

interface Profile {
  firstName: string | null;
  lastName:  string | null;
  teamName:  string | null;
  displayName: string | null;
}

interface AuthState {
  session:     Session | null;
  user:        User | null;
  profile:     Profile | null;
  loading:     boolean;
  initialized: boolean;

  // Actions
  signUp:       (email: string, password: string, profile: { firstName: string; lastName: string; teamName: string }) => Promise<string | null>;
  signIn:       (email: string, password: string) => Promise<string | null>;
  signOut:      () => Promise<void>;
  setSession:   (session: Session | null) => void;
  setInitialized: () => void;
  fetchProfile: (userId: string) => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  session:     null,
  user:        null,
  profile:     null,
  loading:     false,
  initialized: false,

  setSession: (session) => set({
    session,
    user: session?.user ?? null,
  }),

  // Fetches the profiles row (first_name/last_name/team_name/display_name)
  // for the signed-in user. HomeScreen/TournamentLobbyScreen used to derive
  // the greeting name from user.email.split('@')[0] — the raw auth email
  // prefix (e.g. "abhi0818") — because the mobile app never fetched the
  // actual profile at all, unlike the web client. Call this alongside
  // setSession/setCurrentUser so `profile` is populated app-wide.
  fetchProfile: async (userId) => {
    const { data, error } = await supabase
      .from('profiles')
      .select('first_name, last_name, team_name, display_name')
      .eq('id', userId)
      .maybeSingle();
    if (error || !data) { set({ profile: null }); return; }
    set({
      profile: {
        firstName:   data.first_name ?? null,
        lastName:    data.last_name ?? null,
        teamName:    data.team_name ?? null,
        displayName: data.display_name ?? null,
      },
    });
  },

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
    set({ loading: false, session: null, user: null, profile: null });
  },
}));
