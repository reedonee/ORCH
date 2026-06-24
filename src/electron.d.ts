// Type declarations for the preload script's contextBridge API
interface ElectronAPI {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  listen: (channel: string, callback: (payload: any) => void) => () => void;
  windowMinimize: () => Promise<void>;
  windowMaximize: () => Promise<void>;
  windowClose: () => Promise<void>;
}

interface Window {
  electronAPI?: ElectronAPI;
}
