// ── VPS Connection Store ──────────────────────────────────────────
// Manages saved VPS server configurations with cloud sync.

import { create } from 'zustand';
import { listVpsConnections, upsertVpsConnection, deleteVpsConnection } from '../lib/db';
import type { VpsConnectionRow } from '../lib/db';

interface VpsState {
  connections: VpsConnectionRow[];
  loaded: boolean;
  loading: boolean;

  /** Load connections from Supabase (called on auth) */
  loadFromCloud: () => Promise<void>;
  /** Add or update a connection */
  save: (conn: VpsConnectionRow) => Promise<void>;
  /** Remove a connection */
  remove: (id: string) => Promise<void>;
}

export const useVpsStore = create<VpsState>()((set, get) => ({
  connections: [],
  loaded: false,
  loading: false,

  loadFromCloud: async () => {
    if (get().loaded || get().loading) return;
    set({ loading: true });
    try {
      const conns = await listVpsConnections();
      set({ connections: conns, loaded: true, loading: false });
    } catch (err) {
      console.warn('[VpsStore] Failed to load connections:', err);
      set({ loading: false });
    }
  },

  save: async (conn: VpsConnectionRow) => {
    await upsertVpsConnection(conn);
    // Refresh from cloud to get the authoritative list
    const updated = await listVpsConnections();
    set({ connections: updated });
  },

  remove: async (id: string) => {
    await deleteVpsConnection(id);
    set({ connections: get().connections.filter((c) => c.id !== id) });
  },
}));
