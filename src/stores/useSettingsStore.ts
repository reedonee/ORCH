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

  // ── Appearance ─────────────────────────────────────────────
  /** Agent card translucency, 0.35 (very glassy) → 1 (solid). */
  cardOpacity: number;
  setCardOpacity: (v: number) => void;
  /** Backdrop blur behind translucent surfaces, in px. */
  cardBlur: number;
  setCardBlur: (v: number) => void;
  /** Optional darkening behind terminal text, 0 (none, the default) → 1.
   *  Off by default so card transparency and blur reach the whole card. */
  terminalScrim: number;
  setTerminalScrim: (v: number) => void;
  /** 'full' = DOM renderer: see-through, keeps every TUI colour.
   *  'gpu'  = WebGL renderer; faster, but may draw a TUI's dark panels
   *           as solid blocks. */
  terminalTransparency: 'full' | 'gpu';
  setTerminalTransparency: (v: 'full' | 'gpu') => void;
  /** Respect the OS "reduce motion" preference and damp animations. */
  reduceMotion: boolean;
  setReduceMotion: (v: boolean) => void;

  // ── Voice ──────────────────────────────────────────────────
  /** Kokoro voice id. */
  voiceId: string;
  setVoiceId: (v: string) => void;
  /** Speech rate, 0.5 → 2.0. */
  voiceSpeed: number;
  setVoiceSpeed: (v: number) => void;
  /** Speak agent lifecycle events aloud. */
  speakLifecycle: boolean;
  setSpeakLifecycle: (v: boolean) => void;
  /** Approval mode for agents that have not been given their own. */
  defaultApprovalMode: 'auto' | 'manual';
  setDefaultApprovalMode: (v: 'auto' | 'manual') => void;
  /** TTS playback volume, 0 (mute) → 1. */
  voiceVolume: number;
  setVoiceVolume: (v: number) => void;
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

      cardOpacity: 0.72,
      setCardOpacity: (v) => set({ cardOpacity: Math.max(0.35, Math.min(1, v)) }),
      // Off by default: any backdrop blur draws the card as its own
      // transparent layer, where Windows cannot use ClearType, so card text
      // is visibly softer. Opacity alone still reads as glass.
      cardBlur: 0,
      setCardBlur: (v) => set({ cardBlur: Math.max(0, Math.min(40, v)) }),
      terminalScrim: 0,
      setTerminalScrim: (v) => set({ terminalScrim: Math.max(0, Math.min(1, v)) }),
      terminalTransparency: 'full',
      setTerminalTransparency: (v) => set({ terminalTransparency: v }),
      reduceMotion: false,
      setReduceMotion: (v) => set({ reduceMotion: v }),

      voiceId: 'af_bella',
      setVoiceId: (v) => set({ voiceId: v }),
      voiceSpeed: 1.0,
      setVoiceSpeed: (v) => set({ voiceSpeed: Math.max(0.5, Math.min(2, v)) }),
      speakLifecycle: true,
      setSpeakLifecycle: (v) => set({ speakLifecycle: v }),
      defaultApprovalMode: 'manual',
      setDefaultApprovalMode: (v) => set({ defaultApprovalMode: v }),
      voiceVolume: 0.85,
      setVoiceVolume: (v) => set({ voiceVolume: Math.max(0, Math.min(1, v)) }),
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
      version: 13, // v13: backdrop blur off by default
      migrate: (persisted: any, version: number) => {
        // Carry over custom providers from previous version if any
        const oldCustom = version < 7 ? [] : (persisted.customProviders || []);
        // v11: strip stale providerModes key from localStorage
        const clean = { ...persisted };
        delete clean.providerModes;
        // v12: the old 0.72 default scrim covered the whole terminal, which
        // tinted it and hid card transparency/blur. Reset only the untouched
        // default; a value the user chose is kept.
        if (version < 12 && clean.terminalScrim === 0.72) clean.terminalScrim = 0;
        // v13: blur softens card text (no ClearType in a blurred layer), so
        // it starts off once for everyone; re-enabling it in Settings sticks.
        if (version < 13) clean.cardBlur = 0;
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
        cardOpacity: state.cardOpacity,
        cardBlur: state.cardBlur,
        terminalScrim: state.terminalScrim,
        terminalTransparency: state.terminalTransparency,
        reduceMotion: state.reduceMotion,
        voiceId: state.voiceId,
        voiceSpeed: state.voiceSpeed,
        speakLifecycle: state.speakLifecycle,
        defaultApprovalMode: state.defaultApprovalMode,
        voiceVolume: state.voiceVolume,
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
