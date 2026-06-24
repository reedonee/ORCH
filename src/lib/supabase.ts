// ── Supabase Client ────────────────────────────────────────────────
// Initialised from VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.
// Falls back to placeholder values when not configured so the app
// doesn't crash without Supabase — it just shows "not configured".

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

export const supabase = SUPABASE_URL && SUPABASE_ANON_KEY
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false, // we handle PKCE ourselves
        flowType: 'pkce',
      },
    })
  : null;

export function isSupabaseConfigured(): boolean {
  return supabase !== null;
}
