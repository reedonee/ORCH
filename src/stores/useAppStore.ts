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

export interface Toast {
  id: string;
  text: string;
  tone: 'info' | 'success' | 'warn' | 'error';
  createdAt: number;
}

/** What an agent reports it is doing, mirrored from the main-process mesh. */
export interface AgentReport {
  agentId: string;
  name: string;
  providerId: string;
  phase: 'idle' | 'working' | 'blocked' | 'done' | 'failed';
  task: string;
  detail?: string;
  progress?: number;
  files: string[];
  tags: string[];
  updatedAt: number;
  startedAt: number;
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
  /** The agent the user chose to coordinate the others (main process
   *  owns it; this mirrors controller_changed). */
  controllerAgentId: string | null;
  /** Which agents currently hold an MCP session with ORCH. */
  mcpConnections: Record<string, { connected: boolean; client?: string }>;

  delegationLinks: DelegationLink[];

  mcpServers: McpServer[];

  // Viewport state for smart agent spawning (read by PillBar)
  viewportPan: { x: number; y: number };
  viewportZoom: number;
  viewportWinSize: { w: number; h: number };

  // Focus target — canvas watches this and pans to it, then nulls it
  focusTarget: { x: number; y: number; zoom: number } | null;

  /** When true every agent card turns around to show its status summary. */
  flipView: boolean;

  /** Live self-reported status per agent, keyed by agentId. */
  agentReports: Record<string, AgentReport>;

  /** Transient messages shown to the user. */
  toasts: Toast[];

  // Programmatic viewport request — the layout engine pushes its computed
  // framing here; the canvas subscribes and applies it (one-shot, then nulls).
  // This is the reverse channel back to the canvas, mirroring focusTarget but
  // for engine-driven framing (auto-arrange, tidy, stage, etc.).
  viewportFrame: { x: number; y: number; zoom: number; seq: number } | null;

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
  /** Make an agent the controller, or clear it with null. */
  setController: (agentId: string | null) => Promise<boolean>;
  setControllerFromMain: (agentId: string | null) => void;
  setMcpConnection: (agentId: string, info: { connected: boolean; client?: string }) => void;
  setSelectedAgent: (id: string | null) => void;
  setViewport: (pan: { x: number; y: number }, zoom: number, winSize: { w: number; h: number }) => void;
  /** Engine-driven framing request (consumed once by the canvas) */
  requestViewportFrame: (pan: { x: number; y: number }, zoom: number) => void;
  clearViewportFrame: () => void;
  focusOnAgent: (agent: { x: number; y: number; width?: number; height?: number; id: string }) => void;
  clearFocusTarget: () => void;

  setFlipView: (v: boolean) => void;
  toggleFlipView: () => void;
  setAgentReport: (report: AgentReport) => void;
  clearAgentReport: (agentId: string) => void;
  pushToast: (t: { text: string; tone?: Toast['tone'] }) => void;
  dismissToast: (id: string) => void;
  /** Files this agent shares with another currently-working agent.
   *  NOTE: returns a fresh array — never call this directly inside a
   *  zustand selector or the new reference will re-render on every store
   *  update. Subscribe to `agentReports` and derive with useMemo. */
  fileConflictsFor: (agentId: string) => string[];
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
  controllerAgentId: null,
  mcpConnections: {},
  delegationLinks: [],
  flipView: false,
  agentReports: {},
  toasts: [],
  mcpServers: [],
  viewportPan: { x: 0, y: 0 },
  viewportZoom: 1,
  viewportWinSize: { w: window.innerWidth, h: window.innerHeight },
  focusTarget: null,
  viewportFrame: null,

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

  setController: async (agentId) => {
    const res = await invoke<{ success: boolean }>('controller_set', { agentId }).catch(() => ({ success: false }));
    if (res.success) set({ controllerAgentId: agentId, coordinatorActive: !!agentId });
    return res.success;
  },

  setControllerFromMain: (agentId) => set({ controllerAgentId: agentId, coordinatorActive: !!agentId }),

  setMcpConnection: (agentId, info) => set((s) => ({
    mcpConnections: { ...s.mcpConnections, [agentId]: info },
  })),

  setSelectedAgent: (id) => set({ selectedAgentId: id }),

  setViewport: (pan, zoom, winSize) => set({ viewportPan: pan, viewportZoom: zoom, viewportWinSize: winSize }),

  // Monotonic seq guarantees the canvas effect fires even when the engine
  // requests the same framing twice in a row (e.g. two consecutive arranges).
  requestViewportFrame: (pan, zoom) =>
    set((state) => ({
      viewportFrame: { x: pan.x, y: pan.y, zoom, seq: (state.viewportFrame?.seq ?? 0) + 1 },
      viewportPan: pan,
      viewportZoom: zoom,
    })),

  clearViewportFrame: () => set({ viewportFrame: null }),

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

  setFlipView: (v) => set({ flipView: v }),
  toggleFlipView: () => set((s) => ({ flipView: !s.flipView })),

  setAgentReport: (report) => set((s) => ({
    agentReports: { ...s.agentReports, [report.agentId]: report },
  })),

  clearAgentReport: (agentId) => set((s) => {
    const { [agentId]: _drop, ...rest } = s.agentReports;
    return { agentReports: rest };
  }),

  pushToast: ({ text, tone = 'info' }) => {
    const toast: Toast = {
      id: `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      text, tone, createdAt: Date.now(),
    };
    set((s) => ({ toasts: [...s.toasts, toast].slice(-5) }));
    // Auto-dismiss. Errors linger longer because they usually need action.
    const ttl = tone === 'error' ? 8000 : 4000;
    setTimeout(() => {
      useAppStore.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== toast.id) }));
    }, ttl);
  },

  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  // Mirrors AgentMesh.fileConflicts() on the renderer side so a card can
  // show its own collisions without a round-trip to the main process.
  fileConflictsFor: (agentId) => {
    const reports = Object.values(get().agentReports);
    const mine = reports.find((r) => r.agentId === agentId);
    if (!mine || mine.phase !== 'working') return [];
    const others = reports.filter((r) => r.agentId !== agentId && r.phase === 'working');
    // Normalise separators so the Windows and POSIX spellings of one path
    // are recognised as the same file.
    const norm = (f: string) => f.split('\\').join('/').toLowerCase();
    const theirs = new Set(others.flatMap((r) => r.files.map(norm)));
    return mine.files.filter((f) => theirs.has(norm(f)));
  },

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
