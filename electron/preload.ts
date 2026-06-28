import { contextBridge, ipcRenderer } from 'electron';

// Expose a safe API to the renderer process via window.electronAPI
contextBridge.exposeInMainWorld('electronAPI', {
  // ── Invoke (replaces @tauri-apps/api/core invoke) ────────
  invoke: (cmd: string, args?: Record<string, unknown>) =>
    ipcRenderer.invoke(cmd, args),

  // ── Listen (replaces @tauri-apps/api/event listen) ──────
  listen: (channel: string, callback: (payload: any) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },

  // ── Window controls ──────────────────────────────────────
  windowMinimize: () => ipcRenderer.invoke('window_minimize'),
  windowMaximize: () => ipcRenderer.invoke('window_maximize'),
  windowClose: () => ipcRenderer.invoke('window_close'),

  // ── MCP server URL (for debugging / agent config) ────────
  getMcpUrl: () => ipcRenderer.invoke('get-mcp-url'),

  // ── Workspace (Folder-Centric) ───────────────────────────
  selectWorkspaceFolder: () => ipcRenderer.invoke('workspace_select_folder'),
  writeWorkspaceFile: (workspacePath: string, data: unknown) =>
    ipcRenderer.invoke('workspace_write_file', { workspacePath, data }),
  readWorkspaceFile: (workspacePath: string) =>
    ipcRenderer.invoke('workspace_read_file', { workspacePath }),
  getRecentWorkspaces: () => ipcRenderer.invoke('workspace_get_recent'),
  saveRecentWorkspaces: (workspaces: unknown[]) =>
    ipcRenderer.invoke('workspace_save_recent', { workspaces }),
  workspaceExists: (workspacePath: string) =>
    ipcRenderer.invoke('workspace_exists', { workspacePath }),

  // ── Browser ────────────────────────────────────────────────
  browserNavigate: (id: string, url: string) =>
    ipcRenderer.invoke('browser_navigate', { id, url }),
  browserGoBack: (id: string) => ipcRenderer.invoke('browser_go_back', { id }),
  browserGoForward: (id: string) => ipcRenderer.invoke('browser_go_forward', { id }),
  browserRefresh: (id: string) => ipcRenderer.invoke('browser_refresh', { id }),
  onBrowserNavigate: (id: string, callback: (url: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, url: string) => callback(url);
    ipcRenderer.on(`browser_nav_${id}`, handler);
    return () => ipcRenderer.removeListener(`browser_nav_${id}`, handler);
  },
  onBrowserGoBack: (id: string, callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on(`browser_back_${id}`, handler);
    return () => ipcRenderer.removeListener(`browser_back_${id}`, handler);
  },
  onBrowserGoForward: (id: string, callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on(`browser_fwd_${id}`, handler);
    return () => ipcRenderer.removeListener(`browser_fwd_${id}`, handler);
  },
  onBrowserRefresh: (id: string, callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on(`browser_refresh_${id}`, handler);
    return () => ipcRenderer.removeListener(`browser_refresh_${id}`, handler);
  },

  // ── Music Player ───────────────────────────────────────────
  musicResolveUrl: (url: string) => ipcRenderer.invoke('music_resolve_url', { url }),
  musicSearch: (query: string, source?: string) => ipcRenderer.invoke('music_search', { query, source }),
  musicPlaylist: (url: string) => ipcRenderer.invoke('music_playlist', { url }),
  musicStreamUrl: (url: string) => ipcRenderer.invoke('music_stream_url', { url }),
  musicScAuthUrl: () => ipcRenderer.invoke('music_sc_auth_url'),
  musicScAuthToken: (code: string) => ipcRenderer.invoke('music_sc_auth_token', { code }),
  musicScUser: (token: string) => ipcRenderer.invoke('music_sc_user', { token }),

  // ── Auto-Updater ──────────────────────────────────────────
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  triggerUpdate: () => ipcRenderer.invoke('trigger-update'),
  onUpdateStatus: (callback: (payload: { status: string; version: string | null; percent: number }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data);
    ipcRenderer.on('update-status', handler);
    return () => ipcRenderer.removeListener('update-status', handler);
  },

  // ── OAuth (Custom Protocol) ────────────────────────────
  openAuthUrl: (url: string) => ipcRenderer.invoke('open-auth-url', { url }),
  onAuthCallback: (callback: (payload: { code: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data);
    ipcRenderer.on('orch-auth-callback', handler);
    return () => ipcRenderer.removeListener('orch-auth-callback', handler);
  },
});
