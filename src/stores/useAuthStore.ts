// ── Auth Store ─────────────────────────────────────────────────────
// Manages Supabase authentication state: user session, login/logout,
// and signup. Integrates with the workspace sync flow.

import { create } from 'zustand';
import { supabase, isSupabaseConfigured } from '../lib/supabase';
import { getUserPreferences, listProviderConfigs } from '../lib/db';
import type { User, Session } from '@supabase/supabase-js';

export type AuthStatus = 'unconfigured' | 'loading' | 'authenticated' | 'unauthenticated' | 'error';

interface AuthState {
  status: AuthStatus;
  user: User | null;
  session: Session | null;
  error: string | null;

  /** Initialise — check for existing session on boot */
  initialize: () => Promise<void>;
  /** Login with email + password */
  login: (email: string, password: string) => Promise<{ success: boolean; error?: string }>;
  /** Sign up with email + password */
  signUp: (email: string, password: string) => Promise<{ success: boolean; error?: string }>;
  /** Logout */
  logout: () => Promise<void>;
  /** Clear error */
  clearError: () => void;
}

export const useAuthStore = create<AuthState>()((set) => ({
  status: isSupabaseConfigured() ? 'loading' : 'unconfigured',
  user: null,
  session: null,
  error: null,

  initialize: async () => {
    if (!supabase) {
      set({ status: 'unconfigured' });
      return;
    }
    try {
      set({ status: 'loading' });
      const { data: { session }, error } = await supabase.auth.getSession();
      if (error) throw error;
      set({
        status: session ? 'authenticated' : 'unauthenticated',
        session,
        user: session?.user ?? null,
      });
    } catch (err: any) {
      set({ status: 'error', error: err.message });
    }
  },

  login: async (email: string, password: string) => {
    if (!supabase) return { success: false, error: 'Supabase not configured' };
    try {
      set({ status: 'loading', error: null });
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      set({
        status: 'authenticated',
        session: data.session,
        user: data.user,
      });
      // Load cloud data in background
      syncCloudData().catch(() => {});
      return { success: true };
    } catch (err: any) {
      set({ status: 'unauthenticated', error: err.message });
      return { success: false, error: err.message };
    }
  },

  signUp: async (email: string, password: string) => {
    if (!supabase) return { success: false, error: 'Supabase not configured' };
    try {
      set({ status: 'loading', error: null });
      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) throw error;
      // Session is null until email is confirmed (if confirmations enabled)
      if (data.session) {
        set({
          status: 'authenticated',
          session: data.session,
          user: data.user,
        });
      } else {
        set({ status: 'unauthenticated', error: 'Check your email for the confirmation link.' });
      }
      return { success: true };
    } catch (err: any) {
      set({ status: 'unauthenticated', error: err.message });
      return { success: false, error: err.message };
    }
  },

  logout: async () => {
    if (!supabase) return;
    try {
      await supabase.auth.signOut();
      set({ status: 'unauthenticated', user: null, session: null, error: null });
    } catch (err: any) {
      set({ error: err.message });
    }
  },

  clearError: () => set({ error: null }),
}));

// ── Background sync helper (called after login / session restore) ──
async function syncCloudData(): Promise<void> {
  try {
    const [prefs] = await Promise.allSettled([
      getUserPreferences(),
      listProviderConfigs(),
    ]);
    if (prefs.status === 'fulfilled' && prefs.value) {
      const { useSettingsStore } = await import('./useSettingsStore');
      const s = useSettingsStore.getState();
      if (prefs.value.show_grid !== undefined) s.setShowGrid?.(prefs.value.show_grid);
      if (prefs.value.grid_snap !== undefined) s.setGridSnap?.(prefs.value.grid_snap);
      if (prefs.value.terminal_font_size) s.setTerminalFontSize?.(prefs.value.terminal_font_size);
      if (prefs.value.default_provider) s.setDefaultProvider?.(prefs.value.default_provider);
      if (prefs.value.cloud_agents !== undefined) s.setCloudAgents?.(prefs.value.cloud_agents);
    }
    // Load VPS connections in background
    const { useVpsStore } = await import('./useVpsStore');
    useVpsStore.getState().loadFromCloud();
  } catch (err) {
    console.warn('[Cloud] Failed to sync preferences:', err);
  }
}
