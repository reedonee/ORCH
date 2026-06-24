import { create } from 'zustand';
import { invoke } from '../lib/electron-api';
import type { ProviderStatus, ResolvedCommand } from '../types/provider';

interface ProviderState {
  statuses: Record<string, ProviderStatus>;
  isProbing: boolean;
  lastProbedAt: number | null;

  probeAll: (specs: { id: string; name: string; command: string; args?: string[] }[]) => Promise<void>;
  probeOne: (id: string, name: string, command: string, args?: string[]) => Promise<ProviderStatus>;
  resolve: (id: string, command: string, args?: string[]) => Promise<ResolvedCommand>;
  getStatus: (id: string) => ProviderStatus | undefined;
}

export const useProviderStore = create<ProviderState>((set, get) => ({
  statuses: {},
  isProbing: false,
  lastProbedAt: null,

  probeAll: async (specs) => {
    set({ isProbing: true });
    try {
      const results = await invoke<ProviderStatus[]>('list_provider_statuses', { providers: specs });
      const map: Record<string, ProviderStatus> = {};
      for (const s of results) map[s.provider] = s;
      set({ statuses: map, lastProbedAt: Date.now() });
    } catch (err) {
      console.error('probeAll failed:', err);
    } finally {
      set({ isProbing: false });
    }
  },

  probeOne: async (id, name, command, args) => {
    try {
      const status = await invoke<ProviderStatus>('probe_provider', {
        providerId: id,
        displayName: name,
        command,
        args: args || null,
      });
      set((s) => ({ statuses: { ...s.statuses, [id]: status } }));
      return status;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const status: ProviderStatus = {
        provider: id,
        display_name: name,
        available: false,
        source: 'system-fallback',
        version: null,
        path: null,
        error,
      };
      set((s) => ({ statuses: { ...s.statuses, [id]: status } }));
      return status;
    }
  },

  resolve: async (id, command, args) => {
    return await invoke<ResolvedCommand>('resolve_provider', {
      providerId: id,
      command,
      args: args || null,
    });
  },

  getStatus: (id) => get().statuses[id],
}));
