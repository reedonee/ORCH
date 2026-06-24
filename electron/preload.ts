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

  // ── File Sync ─────────────────────────────────────────────
  fileSyncStart: (workspaceId: string, localPath: string, vpsUrl: string) =>
    ipcRenderer.invoke('filesync_start', { workspaceId, localPath, vpsUrl }),
  fileSyncStop: () => ipcRenderer.invoke('filesync_stop'),
  fileSyncGetState: () => ipcRenderer.invoke('filesync_get_state'),
  onFileSyncStateChanged: (callback: (state: any) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: any) => callback(state);
    ipcRenderer.on('filesync_state_changed', handler);
    return () => ipcRenderer.removeListener('filesync_state_changed', handler);
  },
});
