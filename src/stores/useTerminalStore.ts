import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { invoke } from '../lib/electron-api';

export interface TerminalSession {
  id: string;
  name: string;
  agentId: string;
  cols: number;
  rows: number;
  status: 'running' | 'paused' | 'closed';
}

interface TerminalState {
  terminals: TerminalSession[];
  activeTerminalId: string | null;
  buffers: Record<string, string[]>;

  createTerminal: (agentId: string, name: string, command?: string, args?: string[], env?: Record<string, string>, kind?: string, providerId?: string, delegationDepth?: number, contextSnapshot?: string) => Promise<string | null>;
  writeToTerminal: (sessionId: string, data: string) => Promise<void>;
  readTerminalBuffer: (sessionId: string) => Promise<string[]>;
  closeTerminal: (sessionId: string) => Promise<void>;
  loadTerminals: () => Promise<void>;
  setActiveTerminal: (id: string | null) => void;
  appendToBuffer: (sessionId: string, data: string) => void;
  clearBuffer: (sessionId: string) => void;
}

export const useTerminalStore = create<TerminalState>()(
  persist(
    (set) => ({
      terminals: [],
      activeTerminalId: null,
      buffers: {},

      createTerminal: async (agentId, name, command?, args?, env?, kind?, providerId?, delegationDepth?, contextSnapshot?) => {
        try {
          // Resolve the workspace here, not at each call site — six
          // different places spawn agents and any one of them forgetting
          // would silently drop the agent into the wrong directory.
          const { useWorkspaceStore } = await import('./useWorkspaceStore');
          const cwd = useWorkspaceStore.getState().currentWorkspacePath;
          // Same reasoning for the approval mode: an agent's own choice,
          // else the Settings default, decided once for every call site.
          const { useApprovalStore } = await import('./useApprovalStore');
          const { useSettingsStore } = await import('./useSettingsStore');
          const approvalMode = useApprovalStore.getState().modes[agentId]
            ?? useSettingsStore.getState().defaultApprovalMode;

          const id = await invoke<string>('create_terminal', {
            agentId, name, cwd, approvalMode,
            command: command || null,
            args: args || null,
            env: env || null,
            kind: kind || null,
            providerId: providerId || null,
            delegationDepth: delegationDepth || 0,
            contextSnapshot: contextSnapshot || null,
          });
          set((state) => ({
            terminals: [
              ...state.terminals,
              { id, name, agentId, cols: 120, rows: 30, status: 'running' },
            ],
            buffers: { ...state.buffers, [id]: [] },
          }));
          return id;
        } catch (err) {
          console.error('Failed to create terminal:', err);
          return null;
        }
      },

      writeToTerminal: async (sessionId, data) => {
        try {
          await invoke('write_terminal', { sessionId, data });
        } catch (err) {
          console.error('Failed to write to terminal:', err);
        }
      },

      readTerminalBuffer: async (sessionId) => {
        try {
          const lines = await invoke<string[]>('read_terminal', { sessionId });
          set((state) => ({
            buffers: { ...state.buffers, [sessionId]: lines },
          }));
          return lines;
        } catch (err) {
          console.error('Failed to read terminal:', err);
          return [];
        }
      },

      closeTerminal: async (sessionId) => {
        try {
          await invoke('close_terminal', { sessionId });
          set((state) => ({
            terminals: state.terminals.filter((t) => t.id !== sessionId),
            activeTerminalId:
              state.activeTerminalId === sessionId
                ? null
                : state.activeTerminalId,
          }));
        } catch (err) {
          console.error('Failed to close terminal:', err);
        }
      },

      loadTerminals: async () => {
        try {
          const sessions = await invoke<TerminalSession[]>('list_terminals');
          set({ terminals: sessions });
        } catch (err) {
          console.error('Failed to load terminals:', err);
        }
      },

      setActiveTerminal: (id) => set({ activeTerminalId: id }),

      appendToBuffer: (sessionId, data) =>
        set((state) => {
          const buf = state.buffers[sessionId] || [];
          const lines = data.split('\n');
          const newBuf = [...buf, ...lines].slice(-1000); // keep last 1000 lines
          return { buffers: { ...state.buffers, [sessionId]: newBuf } };
        }),

      clearBuffer: (sessionId) =>
        set((state) => ({
          buffers: { ...state.buffers, [sessionId]: [] },
        })),
    }),
    {
      name: 'orch-terminal-store',
      partialize: (state) => ({
        terminals: state.terminals,
        activeTerminalId: state.activeTerminalId,
      }),
    }
  )
);
