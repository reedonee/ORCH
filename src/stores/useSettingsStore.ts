import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Settings, ApiKey, McpConfig, AgentProvider } from '../types/settings';
import { DEFAULT_SETTINGS, BUILTIN_PROVIDERS } from '../types/settings';
import { useAuthStore } from './useAuthStore';
import { saveUserPreferences, upsertProviderConfig, upsertMcpServer } from '../lib/db';

export type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'ready';

function mergeProviders(custom: AgentProvider[]): AgentProvider[] {
  return [...BUILTIN_PROVIDERS, ...custom];
}

interface SettingsState extends Settings {
  setApiKey: (provider: string, key: string, endpoint?: string) => void;
  removeApiKey: (provider: string) => void;
  getApiKey: (provider: string) => string | undefined;
  addMcpServer: (server: McpConfig) => void;
  removeMcpServer: (id: string) => void;
  toggleMcpServer: (id: string) => void;
  setDefaultProvider: (id: string) => void;
  addCustomProvider: (provider: AgentProvider) => void;
  removeCustomProvider: (id: string) => void;
  setTerminalFontSize: (size: number) => void;
  setHibernationEnabled: (on: boolean) => void;
  setCloudAgents: (on: boolean) => void;
  setGridSnap: (on: boolean) => void;
  setShowGrid: (on: boolean) => void;
  setAudioInputDevice: (deviceId: string) => void;
  setGroqApiKey: (key: string) => void;
  setGroqOnSTTFailure: (on: boolean) => void;
  setInstantStart: (on: boolean) => void;
  setShortcut: (actionId: string, combo: string) => void;
  setPttKey: (combo: string) => void;
  getGroqApiKey: () => string;
  setAdmin: (on: boolean) => void;
  // ── Update management ────────────────────────────────────
  updateStatus: UpdateStatus;
  downloadPercent: number;
  availableVersion: string;
  triggerSystemUpdate: () => Promise<void>;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      ...DEFAULT_SETTINGS,
      defaultProvider: 'cmd',
      providers: mergeProviders([]),
      // ── Update management (transient, not persisted) ──────
      updateStatus: 'idle',
      downloadPercent: 0,
      availableVersion: '',
      triggerSystemUpdate: async () => {
        const { onUpdateStatus, checkForUpdates, triggerUpdate } = await import('../lib/electron-api');
        // Wire live status listener
        const unsub = onUpdateStatus((payload) => {
          set({
            updateStatus: payload.status as UpdateStatus,
            downloadPercent: payload.percent,
            availableVersion: payload.version || '',
          });
        });
        // Fire a check first
        const check = await checkForUpdates();
        if (check.success && check.updateInfo) {
          set({ updateStatus: 'available', availableVersion: check.updateInfo.version || '' });
          // Download immediately
          await triggerUpdate();
        } else {
          set({ updateStatus: 'idle' });
        }
        unsub();
      },
      setApiKey: (provider, key, endpoint) =>
        set((state) => {
          const existing = state.apiKeys.findIndex((k) => k.provider === provider);
          const entry: ApiKey = { provider, key, endpoint };
          const apiKeys = existing >= 0 ? state.apiKeys.map((k, i) => (i === existing ? entry : k)) : [...state.apiKeys, entry];
          return { apiKeys };
        }),
      removeApiKey: (provider) => set((state) => ({ apiKeys: state.apiKeys.filter((k) => k.provider !== provider) })),
      getApiKey: (provider) => get().apiKeys.find((k) => k.provider === provider)?.key,
      addMcpServer: (server) => set((state) => ({ mcpServers: [...state.mcpServers, server] })),
      removeMcpServer: (id) => set((state) => ({ mcpServers: state.mcpServers.filter((s) => s.id !== id) })),
      toggleMcpServer: (id) => set((state) => ({ mcpServers: state.mcpServers.map((s) => s.id === id ? { ...s, enabled: !s.enabled } : s) })),
      setDefaultProvider: (id) => set({ defaultProvider: id }),
      addCustomProvider: (provider) =>
        set((state) => {
          const customProviders = [...state.customProviders, provider];
          return { customProviders, providers: mergeProviders(customProviders) };
        }),
      removeCustomProvider: (id) =>
        set((state) => {
          const customProviders = state.customProviders.filter((p) => p.id !== id);
          return { customProviders, providers: mergeProviders(customProviders) };
        }),
      setTerminalFontSize: (size) => set({ terminalFontSize: size }),
      setHibernationEnabled: (on) => set({ hibernationEnabled: on }),
      setCloudAgents: (on) => set({ cloudAgents: on }),
      setGridSnap: (on) => set({ gridSnap: on }),
      setShowGrid: (on) => set({ showGrid: on }),
      setAudioInputDevice: (deviceId) => set({ audioInputDeviceId: deviceId }),
      setGroqApiKey: (key) => set({ groqApiKey: key }),
      setGroqOnSTTFailure: (on) => set({ enableGroqOnSTTFailure: on }),
      setInstantStart: (on) => set({ instantStart: on }),
      setShortcut: (actionId, combo) =>
        set((state) => ({ shortcuts: { ...state.shortcuts, [actionId]: combo } })),
      setPttKey: (combo) => set({ pttKey: combo }),
      setAdmin: (on) => set({ isAdmin: on }),
      getGroqApiKey: () => get().groqApiKey,
    }),
    {
      name: 'orch-settings',
      version: 11, // v11: removed providerModes (VPS decommissioned)
      migrate: (persisted: any, version: number) => {
        // Carry over custom providers from previous version if any
        const oldCustom = version < 7 ? [] : (persisted.customProviders || []);
        // v11: strip stale providerModes key from localStorage
        const clean = { ...persisted };
        delete clean.providerModes;
        return { ...DEFAULT_SETTINGS, ...clean, providers: mergeProviders(oldCustom), customProviders: oldCustom };
      },
      partialize: (state) => ({
        apiKeys: state.apiKeys,
        mcpServers: state.mcpServers,
        defaultProvider: state.defaultProvider,
        customProviders: state.customProviders,
        terminalFontSize: state.terminalFontSize,
        hibernationEnabled: state.hibernationEnabled,
        cloudAgents: state.cloudAgents,
        gridSnap: state.gridSnap,
        showGrid: state.showGrid,
        audioInputDeviceId: state.audioInputDeviceId,
        groqApiKey: state.groqApiKey,
        enableGroqOnSTTFailure: state.enableGroqOnSTTFailure,
        instantStart: state.instantStart,
        shortcuts: state.shortcuts,
        pttKey: state.pttKey,
      }),
    }
  )
);

// ── Debounced cloud sync (1500ms) ─────────────────────────────────
// Whenever settings change via the UI, sync to Supabase after a quiet
// period. Non-blocking — never throws or blocks the UI.
let syncTimer: ReturnType<typeof setTimeout> | null = null;

useSettingsStore.subscribe((state) => {
  const authStatus = useAuthStore.getState().status;
  if (authStatus !== 'authenticated') return;

  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;

    // Sync user preferences
    saveUserPreferences({
      show_grid: state.showGrid,
      grid_snap: state.gridSnap,
      terminal_font_size: state.terminalFontSize,
      default_provider: state.defaultProvider,
      cloud_agents: state.cloudAgents,
      audio_input_device: state.audioInputDeviceId,
    }).catch((err) => console.warn('[Cloud] Failed to sync settings:', err));

    // Sync API keys → provider_configs
    for (const ak of state.apiKeys) {
      upsertProviderConfig({
        provider_id: ak.provider,
        name: ak.provider,
        provider_type: 'custom',
        env_key: ak.provider,
        api_key: ak.key,
        api_endpoint: ak.endpoint,
        launch_mode: 'embedded',
        sort_order: 0,
      }).catch(() => {});
    }

    // Sync MCP servers
    for (const mcp of state.mcpServers) {
      upsertMcpServer({
        name: mcp.name,
        server_type: mcp.type,
        command: mcp.command,
        args: mcp.args,
        url: mcp.url,
        enabled: mcp.enabled,
      }).catch(() => {});
    }
  }, 1500);
});
