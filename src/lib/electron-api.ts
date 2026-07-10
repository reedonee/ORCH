// ── Type-safe wrapper around window.electronAPI ────────────────
//
// Replaces @tauri-apps/api/core (invoke) and @tauri-apps/api/event (listen)
// Keeps the same calling convention so existing code needs minimal changes.

/**
 * Augment window.electronAPI with methods exposed by preload.ts.
 * The base type is declared by the electron-vite toolchain in
 * node_modules/electron-vite/dist/electron-vite.d.ts — we only
 * add the ORCH-specific methods here.
 */
declare global {
  interface ElectronAPI {
    invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
    listen: (channel: string, callback: (payload: any) => void) => () => void;
    windowMinimize: () => Promise<void>;
    windowMaximize: () => Promise<void>;
    windowClose: () => Promise<void>;
    getMcpUrl: () => Promise<string | null>;
    // ── Workspace ───────────────────────────────────────────
    selectWorkspaceFolder: () => Promise<string | null>;
    writeWorkspaceFile: (workspacePath: string, data: unknown) => Promise<{ success: boolean; filePath: string }>;
    readWorkspaceFile: (workspacePath: string) => Promise<Record<string, unknown> | null>;
    getRecentWorkspaces: () => Promise<{ path: string; name: string; lastOpened: number }[]>;
    saveRecentWorkspaces: (workspaces: { path: string; name: string; lastOpened: number }[]) => Promise<{ success: boolean }>;
    workspaceExists: (workspacePath: string) => Promise<boolean>;
    // ── File Sync — REMOVED (VPS decommissioned, everything local)
    // fileSyncStart, fileSyncStop, fileSyncGetState, onFileSyncStateChanged
    // were removed when the VPS was taken down.
    // ── Browser ────────────────────────────────────────────
    browserNavigate: (id: string, url: string) => Promise<{ success: boolean }>;
    browserGoBack: (id: string) => Promise<{ success: boolean }>;
    browserGoForward: (id: string) => Promise<{ success: boolean }>;
    browserRefresh: (id: string) => Promise<{ success: boolean }>;
    onBrowserNavigate: (id: string, callback: (url: string) => void) => () => void;
    onBrowserGoBack: (id: string, callback: () => void) => () => void;
    onBrowserGoForward: (id: string, callback: () => void) => () => void;
    onBrowserRefresh: (id: string, callback: () => void) => () => void;
    // ── Music Player ───────────────────────────────────────
    musicResolveUrl: (url: string) => Promise<{ success: boolean; data?: any; error?: string }>;
    musicSearch: (query: string, source?: string) => Promise<{ success: boolean; data?: any[]; error?: string }>;
    musicPlaylist: (url: string) => Promise<{ success: boolean; data?: any; type?: string; error?: string }>;
    musicStreamUrl: (url: string) => Promise<{ success: boolean; data?: { url: string; type: string }; error?: string }>;
    musicScAuthUrl: () => Promise<{ success: boolean; data?: { authUrl: string } }>;
    musicScAuthToken: (code: string) => Promise<{ success: boolean; data?: { token: string }; error?: string }>;
    musicScUser: (token: string) => Promise<{ success: boolean; data?: { id: string; username: string; avatar: string }; error?: string }>;
    // ── Auto-Updater ───────────────────────────────────────
    checkForUpdates: () => Promise<{ success: boolean; updateInfo?: any; error?: string }>;
    triggerUpdate: () => Promise<{ success: boolean; error?: string }>;
    onUpdateStatus: (callback: (payload: { status: string; version: string | null; percent: number }) => void) => () => void;
    // ── OAuth ─────────────────────────────────────────────
    openAuthUrl: (url: string) => Promise<{ success: boolean; error?: string }>;
    onAuthCallback: (callback: (payload: { code: string }) => void) => () => void;
  }
}

const api = window.electronAPI;

export function invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!api) {
    console.warn(`[electron-api] No electronAPI bridge (invoke: ${cmd})`);
    return Promise.reject(new Error('electronAPI not available'));
  }
  return api.invoke(cmd, args) as Promise<T>;
}

export function listen<T = unknown>(
  channel: string,
  callback: (payload: T) => void,
): Promise<() => void> {
  if (!api) {
    console.warn(`[electron-api] No electronAPI bridge (listen: ${channel})`);
    return Promise.resolve(() => {});
  }
  const unlisten = api.listen(channel, (payload: T) => callback(payload));
  return Promise.resolve(unlisten);
}

export function getMcpUrl(): Promise<string | null> {
  if (!api?.getMcpUrl) return Promise.resolve(null);
  return api.getMcpUrl();
}

export function hibernateAgent(agentId: string): Promise<{ success: boolean; error?: string }> {
  if (!api) return Promise.resolve({ success: false, error: 'no api' });
  return api.invoke('hibernate_agent', { agentId }) as Promise<{ success: boolean; error?: string }>;
}

export function wakeAgent(agentId: string): Promise<{ success: boolean; error?: string }> {
  if (!api) return Promise.resolve({ success: false, error: 'no api' });
  return api.invoke('wake_agent', { agentId }) as Promise<{ success: boolean; error?: string }>;
}

export function getResourceStats(): Promise<{ total: number; active: number; hibernating: number; sessions: any[] }> {
  if (!api) return Promise.resolve({ total: 0, active: 0, hibernating: 0, sessions: [] });
  return api.invoke('get_resource_stats') as Promise<any>;
}

export function setHibernationEnabled(enabled: boolean): Promise<void> {
  if (!api) return Promise.resolve();
  return api.invoke('set_hibernation_enabled', { enabled }) as Promise<void>;
}

// ── Barge-In ──────────────────────────────────────────────────────

export function interruptAgent(agentId: string): Promise<{ success: boolean; agentId: string }> {
  if (!api) return Promise.resolve({ success: false, agentId });
  return api.invoke('interrupt_agent', { agentId }) as Promise<{ success: boolean; agentId: string }>;
}

// ── Voice ────────────────────────────────────────────────────────

export function voiceIsReady(): Promise<boolean> {
  if (!api) return Promise.resolve(false);
  return api.invoke('voice_is_ready') as Promise<boolean>;
}

export function voiceStartListening(): Promise<void> {
  if (!api) return Promise.resolve();
  return api.invoke('voice_start_listening') as Promise<void>;
}

export function voiceSendAudio(data: string): Promise<void> {
  if (!api) return Promise.resolve();
  return api.invoke('voice_send_audio', { data }) as Promise<void>;
}

export function voiceStopListening(): Promise<void> {
  if (!api) return Promise.resolve();
  return api.invoke('voice_stop_listening') as Promise<void>;
}

export function voiceSpeak(id: string, text: string): Promise<void> {
  if (!api) return Promise.resolve();
  return api.invoke('voice_speak', { id, text }) as Promise<void>;
}

export function voiceSpeakAck(id?: string, phrase?: string): Promise<void> {
  if (!api) return Promise.resolve();
  return api.invoke('voice_speak_ack', { id: id || 'ack', phrase: phrase || null }) as Promise<void>;
}

export function voiceInterrupt(): Promise<void> {
  if (!api?.invoke) return Promise.resolve();
  return api.invoke('voice_interrupt') as Promise<void>;
}

export interface VoiceModelStatus {
  serverRunning: boolean;
  models: {
    parakeet: { present: boolean; path: string };
    kokoro: { present: boolean; path: string };
    whisper: { present: boolean; path: string };
  };
}

export function voiceModelStatus(): Promise<VoiceModelStatus> {
  if (!api?.invoke) return Promise.resolve({
    serverRunning: false,
    models: { parakeet: { present: false, path: '' }, kokoro: { present: false, path: '' }, whisper: { present: false, path: '' } },
  });
  return api.invoke('voice_model_status') as Promise<VoiceModelStatus>;
}

// ── Agent Install ──────────────────────────────────────────────────

export function installProvider(providerId: string, command: string, packageName?: string): Promise<{ success: boolean; message: string }> {
  if (!api) return Promise.resolve({ success: false, message: 'no api' });
  return api.invoke('install_provider', { providerId, command, packageName }) as Promise<{ success: boolean; message: string }>;
}

// ── Canvas Assets ─────────────────────────────────────────────────

export function saveCanvasAsset(data: string, ext: string): Promise<{ success: boolean; path: string }> {
  if (!api) return Promise.resolve({ success: false, path: '' });
  return api.invoke('save_canvas_asset', { data, ext }) as Promise<{ success: boolean; path: string }>;
}

export function onInstallProgress(cb: (data: { providerId: string; phase: string; percent: number; message: string }) => void): () => void {
  if (!api) return () => {};
  return api.listen('install_progress', cb);
}

// ── Workspace API ──────────────────────────────────────────────────

export function selectWorkspaceFolder(): Promise<string | null> {
  if (!api?.selectWorkspaceFolder) return Promise.resolve(null);
  return api.selectWorkspaceFolder() as Promise<string | null>;
}

export function writeWorkspaceFile(workspacePath: string, data: unknown): Promise<{ success: boolean; filePath: string }> {
  if (!api?.writeWorkspaceFile) return Promise.resolve({ success: false, filePath: '' });
  return api.writeWorkspaceFile(workspacePath, data) as Promise<{ success: boolean; filePath: string }>;
}

export function readWorkspaceFile(workspacePath: string): Promise<Record<string, unknown> | null> {
  if (!api?.readWorkspaceFile) return Promise.resolve(null);
  return api.readWorkspaceFile(workspacePath) as Promise<Record<string, unknown> | null>;
}

export function getRecentWorkspaces(): Promise<{ path: string; name: string; lastOpened: number }[]> {
  if (!api?.getRecentWorkspaces) return Promise.resolve([]);
  return api.getRecentWorkspaces() as Promise<{ path: string; name: string; lastOpened: number }[]>;
}

export function saveRecentWorkspaces(workspaces: { path: string; name: string; lastOpened: number }[]): Promise<{ success: boolean }> {
  if (!api?.saveRecentWorkspaces) return Promise.resolve({ success: false });
  return api.saveRecentWorkspaces(workspaces) as Promise<{ success: boolean }>;
}

export function workspaceExists(workspacePath: string): Promise<boolean> {
  if (!api?.workspaceExists) return Promise.resolve(false);
  return api.workspaceExists(workspacePath) as Promise<boolean>;
}

// ── File Sync ──────────────────────────────────────────────────────

export type SyncStatus = 'disconnected' | 'connecting' | 'uploading' | 'syncing' | 'error';

export interface SyncState {
  status: SyncStatus;
  workspaceId: string | null;
  localPath: string | null;
  lastSynced: number | null;
  error: string | null;
  pendingChanges: number;
}

// ── File Sync — REMOVED ─────────────────────────────────────────
// VPS decommissioned. Everything runs locally — no file sync needed.
export function fileSyncStart(_workspaceId: string, _localPath: string): Promise<{ success: boolean }> {
  return Promise.resolve({ success: false });
}

export function fileSyncStop(): Promise<{ success: boolean }> {
  return Promise.resolve({ success: false });
}

export function fileSyncGetState(): SyncState {
  return { status: 'disconnected', workspaceId: null, localPath: null, lastSynced: null, error: null, pendingChanges: 0 };
}

export function onFileSyncStateChanged(_cb: (state: SyncState) => void): () => void {
  return () => {};
}

// ── Browser API ────────────────────────────────────────────────────

export function browserNavigate(id: string, url: string): Promise<{ success: boolean }> {
  if (!api?.browserNavigate) return Promise.resolve({ success: false });
  return api.browserNavigate(id, url);
}

export function browserGoBack(id: string): Promise<{ success: boolean }> {
  if (!api?.browserGoBack) return Promise.resolve({ success: false });
  return api.browserGoBack(id);
}

export function browserGoForward(id: string): Promise<{ success: boolean }> {
  if (!api?.browserGoForward) return Promise.resolve({ success: false });
  return api.browserGoForward(id);
}

export function browserRefresh(id: string): Promise<{ success: boolean }> {
  if (!api?.browserRefresh) return Promise.resolve({ success: false });
  return api.browserRefresh(id);
}

export function onBrowserNavigate(id: string, cb: (url: string) => void): () => void {
  if (!api?.onBrowserNavigate) return () => {};
  return api.onBrowserNavigate(id, cb);
}

export function onBrowserGoBack(id: string, cb: () => void): () => void {
  if (!api?.onBrowserGoBack) return () => {};
  return api.onBrowserGoBack(id, cb);
}

export function onBrowserGoForward(id: string, cb: () => void): () => void {
  if (!api?.onBrowserGoForward) return () => {};
  return api.onBrowserGoForward(id, cb);
}

export function onBrowserRefresh(id: string, cb: () => void): () => void {
  if (!api?.onBrowserRefresh) return () => {};
  return api.onBrowserRefresh(id, cb);
}

// ── Music Player API ───────────────────────────────────────────────

export function musicResolveUrl(url: string): Promise<{ success: boolean; data?: any; error?: string }> {
  if (!api?.musicResolveUrl) return Promise.resolve({ success: false, error: 'no api' });
  return api.musicResolveUrl(url);
}

export function musicSearch(query: string, source?: string): Promise<{ success: boolean; data?: any[]; error?: string }> {
  if (!api?.musicSearch) return Promise.resolve({ success: false, error: 'no api' });
  return api.musicSearch(query, source);
}

export function musicPlaylist(url: string): Promise<{ success: boolean; data?: any; type?: string; error?: string }> {
  if (!api?.musicPlaylist) return Promise.resolve({ success: false, error: 'no api' });
  return api.musicPlaylist(url);
}

export function musicStreamUrl(url: string): Promise<{ success: boolean; data?: { url: string; type: string }; error?: string }> {
  if (!api?.musicStreamUrl) return Promise.resolve({ success: false, error: 'no api' });
  return api.musicStreamUrl(url);
}

export function musicScAuthUrl(): Promise<{ success: boolean; data?: { authUrl: string } }> {
  if (!api?.musicScAuthUrl) return Promise.resolve({ success: false });
  return api.musicScAuthUrl();
}

export function musicScAuthToken(code: string): Promise<{ success: boolean; data?: { token: string }; error?: string }> {
  if (!api?.musicScAuthToken) return Promise.resolve({ success: false, error: 'no api' });
  return api.musicScAuthToken(code);
}

export function musicScUser(token: string): Promise<{ success: boolean; data?: { id: string; username: string; avatar: string }; error?: string }> {
  if (!api?.musicScUser) return Promise.resolve({ success: false, error: 'no api' });
  return api.musicScUser(token);
}

export function onVoicePartial(cb: (text: string) => void): () => void {
  if (!api) return () => {};
  return api.listen('voice_partial', cb);
}

export function onVoiceFinal(cb: (text: string) => void): () => void {
  if (!api) return () => {};
  return api.listen('voice_final', cb);
}

export function onVoiceAudio(cb: (data: { id: string; data: string }) => void): () => void {
  if (!api) return () => {};
  return api.listen('voice_audio', cb);
}

export function onVoiceState(cb: (state: string) => void): () => void {
  if (!api) return () => {};
  return api.listen('voice_state', cb);
}

export function onVoiceError(cb: (msg: string) => void): () => void {
  if (!api) return () => {};
  return api.listen('voice_error', cb);
}

export function onVoiceStatus(cb: (msg: string) => void): () => void {
  if (!api) return () => {};
  return api.listen('voice_status', cb);
}

// ── Auto-Updater wrappers ─────────────────────────────────────────

export function checkForUpdates(): Promise<{ success: boolean; updateInfo?: any; error?: string }> {
  if (!api?.checkForUpdates) return Promise.resolve({ success: false, error: 'no bridge' });
  return api.checkForUpdates();
}

export function triggerUpdate(): Promise<{ success: boolean; error?: string }> {
  if (!api?.triggerUpdate) return Promise.resolve({ success: false, error: 'no bridge' });
  return api.triggerUpdate();
}

export function onUpdateStatus(
  cb: (payload: { status: string; version: string | null; percent: number }) => void,
): () => void {
  if (!api?.onUpdateStatus) return () => {};
  return api.onUpdateStatus(cb);
}

// ── OAuth wrappers ────────────────────────────────────────────────

export function openAuthUrl(url: string): Promise<{ success: boolean; error?: string }> {
  if (!api?.openAuthUrl) return Promise.resolve({ success: false, error: 'no bridge' });
  return api.openAuthUrl(url);
}

export function onAuthCallback(cb: (payload: { code: string }) => void): () => void {
  if (!api?.onAuthCallback) return () => {};
  return api.onAuthCallback(cb);
}
