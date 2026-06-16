import { create } from 'zustand';
import { Session, User } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';

interface AuthState {
  session:     Session | null;
  user:        User | null;
  loading:     boolean;
  initialized: boolean;

  // Actions
  signUp:       (email: string, password: string) => Promise<string | null>;
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

  signUp: async (email, password) => {
    set({ loading: true });
    const { error } = await supabase.auth.signUp({ email, password });
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
