// ── ORCH Bridge ─────────────────────────────────────────────────
// Exposes canvas/agent operations to the MCP server via
// window.__orchBridge, which main.ts calls through executeJavaScript.
// This runs in the renderer process so it has direct zustand access.

import { useAppStore } from '../stores/useAppStore';
import { useCanvasStore } from '../stores/useCanvasStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { useProviderStore } from '../stores/useProviderStore';
import { useTerminalStore } from '../stores/useTerminalStore';
import { useWorkspaceStore } from '../stores/useWorkspaceStore';
import { pickAgentName } from './agent-names';
import { LAYOUT_ENGINE_SPEC } from '../stores/useWorkspaceStore';

const AGENT_COLORS = ['#F4A261', '#4EA8DE', '#6BBF8A', '#E76F51', '#B48BC9', '#F4C97A', '#7BC9C9', '#EAF4F4'];
const AGENT_ROLES = ['Developer', 'Terminal', 'File System', 'Debugger', 'Compiler', 'Network', 'Database', 'Observer'];

export interface BridgeAPI {
  getCanvasState: () => any;
  getCanvasElements: () => any;
  getAgent: (id: string) => any;
  moveAgent: (id: string, x: number, y: number) => void;
  createAgent: (providerId: string, name: string | null, contextSnapshot?: string | null) => Promise<any>;
  removeAgent: (id: string) => Promise<void>;
}

export function createBridge(): BridgeAPI {
  return {
    getCanvasState: () => {
      const { agents, selectedAgentId, coordinatorActive } = useAppStore.getState();
      const themeStore = useSettingsStore.getState();
      return {
        agents: agents.map((a) => ({
          id: a.id,
          name: a.name,
          role: a.role,
          status: a.status,
          provider: a.provider,
          x: a.x,
          y: a.y,
          width: a.width,
          height: a.height,
          color: a.color,
          terminalId: a.terminalId,
        })),
        selectedAgentId,
        coordinatorActive,
        providers: themeStore.providers.map((p) => ({ id: p.id, name: p.name })),
      };
    },

    getCanvasElements: () => {
      return useCanvasStore.getState().elements;
    },

    getAgent: (id: string) => {
      const { agents } = useAppStore.getState();
      const agent = agents.find((a) => a.id === id);
      if (!agent) return null;
      return {
        id: agent.id,
        name: agent.name,
        role: agent.role,
        status: agent.status,
        provider: agent.provider,
        x: agent.x,
        y: agent.y,
        width: agent.width,
        height: agent.height,
        color: agent.color,
        terminalId: agent.terminalId,
      };
    },

    moveAgent: (id: string, x: number, y: number) => {
      useAppStore.getState().updateAgentPosition(id, x, y);
    },

    createAgent: async (providerId: string, name: string | null, contextSnapshot?: string | null) => {
      const store = useAppStore.getState();
      const settingsStore = useSettingsStore.getState();
      const terminalStore = useTerminalStore.getState();

      const provider = settingsStore.providers.find((p) => p.id === providerId);
      if (!provider) return { error: `Provider '${providerId}' not found` };

      const color = AGENT_COLORS[Math.floor(Math.random() * AGENT_COLORS.length)];
      const role = AGENT_ROLES[Math.floor(Math.random() * AGENT_ROLES.length)];
      const agents = store.agents;
      const agentName = name || `${pickAgentName(agents.map(a => a.name))} - ${provider.name}`;

      const env: Record<string, string> = {};
      if (provider.envKey) {
        const key = settingsStore.getApiKey(provider.envKey);
        if (key) {
          const varName = provider.envKey === 'anthropic' ? 'ANTHROPIC_API_KEY'
            : provider.envKey === 'openai' ? 'OPENAI_API_KEY'
            : provider.envKey === 'google' ? 'GOOGLE_API_KEY'
            : `${provider.envKey.toUpperCase()}_API_KEY`;
          env[varName] = key;
        }
      }

      const launchMode = provider.launchMode ?? 'embedded';
      const kind = provider.shell === false ? 'cli' : 'shell';
      let termId: string | null = null;

      // Parse context snapshot if provided
      let parsedContext: { delegationDepth?: number } = {};
      if (contextSnapshot) {
        try { parsedContext = JSON.parse(contextSnapshot); } catch { /* ignore */ }
      }

      const agentId = crypto.randomUUID();

      if (launchMode === 'embedded') {
        // Always spawn locally — VPS has been decommissioned
        termId = await terminalStore.createTerminal(
          agentName,
          `${agentName} Terminal`,
          provider.command,
          provider.args,
          Object.keys(env).length > 0 ? env : undefined,
          kind,
          providerId,
          parsedContext.delegationDepth || 0,
          contextSnapshot || undefined,
        );
      }

      // Spawn at the layout engine's computed position
      const pos = useWorkspaceStore.getState().spawnPosition();
      const newAgent = {
        id: agentId,
        name: agentName,
        role,
        status: 'idle' as const,
        terminalId: termId || undefined,
        provider: providerId,
        x: pos.x,
        y: pos.y,
        color,
      };

      await store.addAgent(newAgent);
      return newAgent;
    },

    removeAgent: async (id: string) => {
      await useAppStore.getState().removeAgent(id);
    },
  };
}

// Setup — call this once from main.tsx
export function setupBridge() {
  (window as any).__orchBridge = createBridge();

  // Listen for hibernation/wake status changes from main process
  import('../lib/electron-api').then(({ listen }) => {
    listen('agent-status-changed', (payload: any) => {
      const { agentId, status } = payload;
      const store = useAppStore.getState();
      const agent = store.agents.find((a) => a.id === agentId);
      if (agent) {
        store.updateAgentStatus(agentId, status);
        console.log(`[Bridge] Agent ${agentId} status → ${status}`);
      }
    });

    // Listen for delegation events from the MCP/EventBus — wire to store
    listen('delegation_created', (payload: any) => {
      const { taskId, title, delegationDepth, parentTaskId } = payload;
      const store = useAppStore.getState();

      // For top-level delegations (no parent), create a link with unknown source
      if (!parentTaskId) {
        store.addDelegationLink({
          id: `deleg_${taskId}`,
          fromAgentId: '',
          toAgentId: '',
          taskId,
          title: title || 'Delegated task',
          status: 'pending',
          createdAt: Date.now(),
        });
        console.log(`[Bridge] Delegation created: ${title} (task=${taskId})`);
        return;
      }

      // Sub-delegation: find parent link and chain from its target
      const parentLink = store.delegationLinks.find(l => l.taskId === parentTaskId);
      if (parentLink) {
        store.addDelegationLink({
          id: `deleg_${taskId}`,
          fromAgentId: parentLink.toAgentId,
          toAgentId: '',
          taskId,
          title: title || 'Sub-delegation',
          status: 'pending',
          createdAt: Date.now(),
        });
      }
      console.log(`[Bridge] Delegation: ${title} (depth=${delegationDepth})`);
    });

    listen('task_claimed', (payload: any) => {
      const { taskId, claimantAgentId } = payload;
      const store = useAppStore.getState();
      const link = store.delegationLinks.find(l => l.taskId === taskId);
      if (link) {
        store.updateDelegationLink(link.id, {
          toAgentId: claimantAgentId,
          status: 'in-progress',
        });
      }
    });

    listen('task_completed', (payload: any) => {
      const { taskId } = payload;
      const store = useAppStore.getState();
      const link = store.delegationLinks.find(l => l.taskId === taskId);
      if (link) {
        store.updateDelegationLink(link.id, { status: 'completed' });
      }
    });

    listen('task_failed', (payload: any) => {
      const { taskId } = payload;
      const store = useAppStore.getState();
      const link = store.delegationLinks.find(l => l.taskId === taskId);
      if (link) {
        store.updateDelegationLink(link.id, { status: 'failed' });
      }
    });
  });

  console.log('[Bridge] ORCH bridge ready for MCP');

  // ── Probe provider availability at startup ──────────────
  setTimeout(() => {
    const settings = useSettingsStore.getState();
    const specs = settings.providers
      .filter((p) => !p.shell)
      .map((p) => ({ id: p.id, name: p.name, command: p.command, args: p.args }));
    if (specs.length) {
      useProviderStore.getState().probeAll(specs);
    }
  }, 1000);
}
