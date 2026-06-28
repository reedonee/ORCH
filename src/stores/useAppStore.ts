import { create } from 'zustand';
import { invoke } from '../lib/electron-api';
import { usePanelRegistry } from './usePanelRegistry';
import { Z_BASE_LAYERS } from '../lib/z-stack-manager';
import { frameViewport } from '../lib/layout-engine';

export interface Agent {
  id: string;
  name: string;
  role: string;
  status: 'idle' | 'active' | 'busy' | 'error' | 'sleeping';
  terminalId?: string;
  mcpServerId?: string;
  provider?: string;
  providerId?: string;
  kind?: 'shell' | 'cli' | 'external';
  launchMode?: 'embedded' | 'external';
  x: number;
  y: number;
  width?: number;
  height?: number;
  color: string;
}

export interface DelegationLink {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  taskId: string;
  title: string;
  status: 'pending' | 'in-progress' | 'completed' | 'failed';
  createdAt: number;
}

export interface McpServer {
  id: string;
  name: string;
  type: 'stdio' | 'sse' | 'websocket';
  enabled: boolean;
  tools: string[];
}

interface AppState {
  agents: Agent[];
  isLoading: boolean;
  coordinatorActive: boolean;
  selectedAgentId: string | null;

  delegationLinks: DelegationLink[];

  mcpServers: McpServer[];

  // Viewport state for smart agent spawning (read by PillBar)
  viewportPan: { x: number; y: number };
  viewportZoom: number;
  viewportWinSize: { w: number; h: number };

  // Focus target — canvas watches this and pans to it, then nulls it
  focusTarget: { x: number; y: number; zoom: number } | null;

  addAgent: (agent: Agent) => Promise<void>;
  removeAgent: (id: string) => Promise<void>;
  updateAgentPosition: (id: string, x: number, y: number) => void;
  updateAgentPositions: (positions: Array<{ id: string; x: number; y: number }>) => void;
  updateAgentTerminalId: (id: string, terminalId: string) => void;
  updateAgentSize: (id: string, width: number, height: number) => void;
  updateAgentStatus: (id: string, status: Agent['status']) => void;
  loadAgents: () => Promise<void>;
  addMcpServer: (server: McpServer) => void;
  removeMcpServer: (id: string) => void;
  setCoordinatorActive: (active: boolean) => void;
  toggleCoordinator: () => Promise<void>;
  setSelectedAgent: (id: string | null) => void;
  setViewport: (pan: { x: number; y: number }, zoom: number, winSize: { w: number; h: number }) => void;
  focusOnAgent: (agent: { x: number; y: number; width?: number; height?: number; id: string }) => void;
  clearFocusTarget: () => void;
  // Delegation links
  addDelegationLink: (link: DelegationLink) => void;
  updateDelegationLink: (id: string, updates: Partial<DelegationLink>) => void;
  removeDelegationLinksForAgent: (agentId: string) => void;

  // ── Workspace persistence helpers ───────────────────────────
  toWorkspaceData: () => {
    agents: Agent[];
    viewportPan: { x: number; y: number };
    viewportZoom: number;
  };
  hydrateFromWorkspace: (data: {
    agents?: Agent[];
    viewportPan?: { x: number; y: number };
    viewportZoom?: number;
  }) => void;
  resetAppState: () => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  agents: [],
  isLoading: false,
  coordinatorActive: false,
  selectedAgentId: null,
  delegationLinks: [],
  mcpServers: [],
  viewportPan: { x: 0, y: 0 },
  viewportZoom: 1,
  viewportWinSize: { w: window.innerWidth, h: window.innerHeight },
  focusTarget: null,

  addAgent: async (agent) => {
    await invoke('register_agent', { agent: {
      id: agent.id,
      name: agent.name,
      role: agent.role,
      status: agent.status,
      terminal_id: agent.terminalId ?? null,
      mcp_server_id: agent.mcpServerId ?? null,
      x: agent.x,
      y: agent.y,
      color: agent.color,
    } });
    set((state) => ({ agents: [...state.agents, agent] }));
    // Register with the panel registry
    usePanelRegistry.getState().registerPanel({
      id: agent.id,
      type: 'agent',
      space: 'canvas',
      x: agent.x,
      y: agent.y,
      width: agent.width ?? 520,
      height: agent.height ?? 360,
      minWidth: 260,
      minHeight: 180,
      defaultWidth: 520,
      defaultHeight: 360,
      participatesInAutoLayout: true,
      participatesInFraming: true,
      participatesInCollision: true,
      draggable: true,
      resizable: true,
      focusable: true,
      baseZIndex: Z_BASE_LAYERS.agentDefault,
      agentRef: agent.id,
    });
  },

  removeAgent: async (id) => {
    try {
      await invoke('remove_agent', { agentId: id });
    } catch (err) {
      console.error('Failed to remove agent:', err);
    }
    set((state) => ({
      agents: state.agents.filter((a) => a.id !== id),
      selectedAgentId: state.selectedAgentId === id ? null : state.selectedAgentId,
    }));
    usePanelRegistry.getState().unregisterPanel(id);
  },

  updateAgentPosition: (id, x, y) => {
    set((state) => ({
      agents: state.agents.map((a) => (a.id === id ? { ...a, x, y } : a)),
    }));
    usePanelRegistry.getState().updatePanel(id, { x, y });
  },

  updateAgentPositions: (positions) => {
    set((state) => {
      const byId = positions.reduce<Record<string, { x: number; y: number }>>((acc, position) => {
        acc[position.id] = { x: position.x, y: position.y };
        return acc;
      }, {});
      return {
        agents: state.agents.map((agent) => {
          const next = byId[agent.id];
          return next ? { ...agent, x: next.x, y: next.y } : agent;
        }),
      };
    });
    // Sync to registry
    const registry = usePanelRegistry.getState();
    for (let i = 0; i < positions.length; i++) {
      registry.updatePanel(positions[i].id, { x: positions[i].x, y: positions[i].y });
    }
  },

  updateAgentTerminalId: (id, terminalId) =>
    set((state) => ({
      agents: state.agents.map((a) => (a.id === id ? { ...a, terminalId } : a)),
    })),

  updateAgentSize: (id, width, height) => {
    set((state) => ({
      agents: state.agents.map((a) => (a.id === id ? { ...a, width, height } : a)),
    }));
    usePanelRegistry.getState().updatePanel(id, { width, height });
  },

  updateAgentStatus: (id, status) =>
    set((state) => ({
      agents: state.agents.map((a) => (a.id === id ? { ...a, status } : a)),
    })),

  loadAgents: async () => {
    set({ isLoading: true });
    try {
      const agents = await invoke<Agent[]>('list_agents');
      set({ agents });
    } catch (err) {
      console.error('Failed to load agents:', err);
    } finally {
      set({ isLoading: false });
    }
  },

  addMcpServer: (server) =>
    set((state) => ({ mcpServers: [...state.mcpServers, server] })),

  removeMcpServer: (id) =>
    set((state) => ({
      mcpServers: state.mcpServers.filter((s) => s.id !== id),
    })),

  setCoordinatorActive: (active) => set({ coordinatorActive: active }),

  toggleCoordinator: async () => {
    const { coordinatorActive } = get();
    try {
      if (coordinatorActive) {
        await invoke('coordinator_stop');
        set({ coordinatorActive: false });
      } else {
        await invoke('coordinator_start');
        set({ coordinatorActive: true });
      }
    } catch (err) {
      console.error('Coordinator toggle failed:', err);
    }
  },

  setSelectedAgent: (id) => set({ selectedAgentId: id }),

  setViewport: (pan, zoom, winSize) => set({ viewportPan: pan, viewportZoom: zoom, viewportWinSize: winSize }),

  focusOnAgent: (agent) => {
    const { viewportWinSize } = get();
    const cw = agent.width || 520;
    const ch = agent.height || 360;
    // Frame the single agent through the engine's zoom-correct framer so the
    // focus respects the [0.35, 1.0] guardrails instead of a hardcoded zoom:1.
    const { pan, zoom } = frameViewport(
      { minX: agent.x, minY: agent.y, maxX: agent.x + cw, maxY: agent.y + ch },
      viewportWinSize.w,
      viewportWinSize.h,
    );
    set({ focusTarget: { x: pan.x, y: pan.y, zoom }, selectedAgentId: agent.id });
  },

  clearFocusTarget: () => set({ focusTarget: null }),

  // ── Delegation links ─────────────────────────────────────────
  addDelegationLink: (link) =>
    set((state) => ({
      delegationLinks: [...state.delegationLinks, link],
    })),

  updateDelegationLink: (id, updates) =>
    set((state) => ({
      delegationLinks: state.delegationLinks.map((l) =>
        l.id === id ? { ...l, ...updates } : l
      ),
    })),

  removeDelegationLinksForAgent: (agentId) =>
    set((state) => ({
      delegationLinks: state.delegationLinks.filter(
        (l) => l.fromAgentId !== agentId && l.toAgentId !== agentId
      ),
    })),

  // ── Workspace persistence ─────────────────────────────────
  toWorkspaceData: () => {
    const s = get();
    return {
      agents: s.agents,
      viewportPan: s.viewportPan,
      viewportZoom: s.viewportZoom,
    };
  },

  hydrateFromWorkspace: (data) => {
    set({
      agents: data.agents ?? [],
      viewportPan: data.viewportPan ?? { x: 0, y: 0 },
      viewportZoom: data.viewportZoom ?? 1,
      selectedAgentId: null,
      delegationLinks: [],
    });
    // Re-register all agents with the panel registry
    const registry = usePanelRegistry.getState();
    const agents = data.agents ?? [];
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      registry.registerPanel({
        id: a.id,
        type: 'agent',
        space: 'canvas',
        x: a.x,
        y: a.y,
        width: a.width ?? 520,
        height: a.height ?? 360,
        minWidth: 260,
        minHeight: 180,
        defaultWidth: 520,
        defaultHeight: 360,
        participatesInAutoLayout: true,
        participatesInFraming: true,
        participatesInCollision: true,
        draggable: true,
        resizable: true,
        focusable: true,
        baseZIndex: Z_BASE_LAYERS.agentDefault,
        agentRef: a.id,
      });
    }
  },

  resetAppState: () => {
    // Unregister all agent panels from registry before clearing
    const currentAgents = get().agents;
    for (let i = 0; i < currentAgents.length; i++) {
      usePanelRegistry.getState().unregisterPanel(currentAgents[i].id);
    }
    set({
      agents: [],
      selectedAgentId: null,
      delegationLinks: [],
      isLoading: false,
    });
  },
}));
