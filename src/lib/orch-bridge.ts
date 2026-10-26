// ── ORCH Bridge ─────────────────────────────────────────────────
// Exposes canvas/agent operations to the MCP server via
// window.__orchBridge, which main.ts calls through executeJavaScript.
// This runs in the renderer process so it has direct zustand access.

import { useAppStore } from '../stores/useAppStore';
import { useCanvasStore } from '../stores/useCanvasStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { useProviderStore } from '../stores/useProviderStore';
import { useTerminalStore } from '../stores/useTerminalStore';
import { useWorkspaceStore, type LayoutMode } from '../stores/useWorkspaceStore';
import { pickAgentName } from './agent-names';
import type { ThemeName } from '../styles/theme';

const AGENT_COLORS = ['#F4A261', '#4EA8DE', '#6BBF8A', '#E76F51', '#B48BC9', '#F4C97A', '#7BC9C9', '#EAF4F4'];
const AGENT_ROLES = ['Developer', 'Terminal', 'File System', 'Debugger', 'Compiler', 'Network', 'Database', 'Observer'];

export interface CanvasFileRequest {
  agentId: string;
  path: string;
  /** orch-asset:// URL when the main process cached a renderable copy. */
  assetUrl: string | null;
  kind: 'image' | 'video' | 'audio' | 'text' | 'pdf' | 'file';
  ext: string;
  sizeBytes: number;
  title: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

/** Every bridge method returns plain JSON — it is serialised across the
 *  executeJavaScript boundary. `unknown` rather than `any` so callers must
 *  narrow instead of silently inheriting an unchecked type. */
export type BridgeResult = Record<string, unknown> | unknown[] | null;

export interface BridgeAPI {
  getCanvasState: () => BridgeResult;
  getCanvasElements: () => BridgeResult;
  getAgent: (id: string) => BridgeResult;
  moveAgent: (id: string, x: number, y: number) => void;
  createAgent: (providerId: string, name: string | null, contextSnapshot?: string | null) => Promise<BridgeResult>;
  removeAgent: (id: string) => Promise<void>;
  arrange: (mode: string) => BridgeResult;
  addFile: (opts: CanvasFileRequest) => BridgeResult;
  addNote: (opts: { agentId: string; text: string; x?: number; y?: number }) => BridgeResult;
  appAction: (action: string, params: Record<string, unknown>) => Promise<BridgeResult>;
  /** Single named-argument dispatch entry point. The main process reaches
   *  the renderer through executeJavaScript, which can only pass a string —
   *  routing every call through one dispatcher keeps that boundary small
   *  and lets main send a JSON object instead of splicing positional args
   *  into source text. */
  call: (method: string, args?: Record<string, unknown>) => Promise<BridgeResult>;
}

export function createBridge(): BridgeAPI {
  const api: BridgeAPI = {
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
          agentId,
          agentName,
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

    arrange: (mode: string) => {
      const ws = useWorkspaceStore.getState();
      ws.setLayoutMode(mode as any);
      return { ok: true, mode };
    },


    addFile: (opts: CanvasFileRequest) => {
      const canvas = useCanvasStore.getState();
      const ws = useWorkspaceStore.getState();

      // Size the node to suit the medium. A 4K wallpaper at native size
      // would swamp the canvas; a text file needs room to be readable.
      const defaults: Record<string, { w: number; h: number }> = {
        image: { w: 480, h: 300 },
        video: { w: 560, h: 315 },
        audio: { w: 380, h: 120 },
        text:  { w: 420, h: 320 },
        pdf:   { w: 420, h: 540 },
        file:  { w: 300, h: 140 },
      };
      const size = defaults[opts.kind] ?? defaults.file;
      const width = opts.width ?? size.w;
      const height = opts.height ?? size.h;

      // Place it where the user is looking unless told otherwise.
      const pos = (opts.x !== undefined && opts.y !== undefined)
        ? { x: opts.x, y: opts.y }
        : ws.spawnPosition();

      const id = `file_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      canvas.addElement({
        id,
        type: 'image',
        // Renderable media uses the cached asset URL; everything else
        // falls back to showing the path as a file card.
        src: opts.assetUrl ?? undefined,
        alt: opts.title,
        text: opts.title,
        x: pos.x,
        y: pos.y,
        width,
        height,
        strokeColor: 'transparent',
        strokeWidth: 0,
        // Paint order is an ordinal, not a timestamp. Date.now() here put
        // every agent-created node ~1.8e12 above the rest, so they always
        // outranked user content and sendToBack had to go absurdly
        // negative to get beneath them.
        zIndex: canvas.nextZIndex(),
        createdAt: Date.now(),
        fileMeta: {
          path: opts.path,
          kind: opts.kind,
          ext: opts.ext,
          sizeBytes: opts.sizeBytes,
          producedBy: opts.agentId,
        },
      } as any);

      return { ok: true, id, x: pos.x, y: pos.y, width, height, kind: opts.kind };
    },

    addNote: (opts: { agentId: string; text: string; x?: number; y?: number }) => {
      const canvas = useCanvasStore.getState();
      const ws = useWorkspaceStore.getState();
      const pos = (opts.x !== undefined && opts.y !== undefined)
        ? { x: opts.x, y: opts.y }
        : ws.spawnPosition();
      const id = `note_${Date.now().toString(36)}`;
      canvas.addElement({
        id,
        type: 'text',
        text: opts.text,
        x: pos.x,
        y: pos.y,
        width: 320,
        height: 160,
        fontSize: 14,
        strokeColor: 'var(--text)',
        strokeWidth: 0,
        // Paint order is an ordinal, not a timestamp. Date.now() here put
        // every agent-created node ~1.8e12 above the rest, so they always
        // outranked user content and sendToBack had to go absurdly
        // negative to get beneath them.
        zIndex: canvas.nextZIndex(),
        createdAt: Date.now(),
      } as any);
      return { ok: true, id };
    },

    appAction: async (action: string, params: Record<string, unknown> = {}) => {
      // One switch, so list_app_actions and reality cannot diverge.
      switch (action) {
        case 'open_browser': {
          const b = await import('../stores/useBrowserStore');
          b.useBrowserStore.getState().setVisible(true);
          if (params.url) b.useBrowserStore.getState().openBrowser(String(params.url));
          return { ok: true };
        }
        case 'close_browser': {
          const b = await import('../stores/useBrowserStore');
          b.useBrowserStore.getState().setVisible(false);
          return { ok: true };
        }
        case 'play_music': {
          const m = await import('../stores/useMusicPlayerStore');
          const store = m.useMusicPlayerStore.getState();
          store.setVisible?.(true);
          if (params.url) store.playUrl(String(params.url));
          return { ok: true, note: params.query && !params.url
            ? 'Search is not exposed programmatically; pass a url instead.' : undefined };
        }
        case 'pause_music': {
          const m = await import('../stores/useMusicPlayerStore');
          m.useMusicPlayerStore.getState().pause();
          return { ok: true };
        }
        case 'next_track': {
          const m = await import('../stores/useMusicPlayerStore');
          m.useMusicPlayerStore.getState().next();
          return { ok: true };
        }
        case 'prev_track': {
          const m = await import('../stores/useMusicPlayerStore');
          m.useMusicPlayerStore.getState().prev();
          return { ok: true };
        }
        case 'select_agent': {
          const store = useAppStore.getState();
          const q = String(params.agentId ?? params.name ?? '');
          const match = store.agents.find((a) => a.id === q)
            ?? store.agents.find((a) => a.name.split(' - ')[0].toLowerCase() === q.toLowerCase());
          if (!match) return { error: `No agent matches "${q}"` };
          store.setSelectedAgent(match.id);
          store.focusOnAgent(match);
          return { ok: true, agentId: match.id, name: match.name };
        }
        case 'arrange': {
          useWorkspaceStore.getState().arrange(String(params.mode ?? 'grid') as LayoutMode);
          return { ok: true };
        }
        case 'set_theme': {
          const t = await import('../stores/useThemeStore');
          const { themes } = await import('../styles/theme');
          const name = String(params.theme ?? '');
          // Validate against the real theme registry rather than casting:
          // an unknown name would otherwise silently no-op inside setTheme
          // and the agent would believe it succeeded.
          if (!(name in themes)) {
            return { error: `Unknown theme "${name}". Available: ${Object.keys(themes).join(', ')}` };
          }
          t.useThemeStore.getState().setTheme(name as ThemeName);
          return { ok: true, theme: name };
        }
        case 'toggle_flip_view': {
          const store = useAppStore.getState();
          const next = params.on === undefined ? !store.flipView : Boolean(params.on);
          store.setFlipView(next);
          return { ok: true, flipView: next };
        }
        case 'save_workspace': {
          await useWorkspaceStore.getState().saveWorkspace();
          return { ok: true };
        }
        case 'notify': {
          useAppStore.getState().pushToast({
            text: String(params.message ?? ''),
            tone: (params.tone as 'info' | 'success' | 'warn' | 'error') ?? 'info',
          });
          return { ok: true };
        }
        default:
          return { error: `Unknown action "${action}". Call list_app_actions to see what exists.` };
      }
    },

    call: async () => ({ error: 'replaced below' }),
  };

  // Dispatcher — declared after `api` so it can close over the concrete
  // methods. Unknown methods return an error object rather than throwing,
  // so a bad MCP call surfaces as a tool error instead of a renderer crash.
  api.call = async (method: string, args: Record<string, unknown> = {}) => {
    try {
      switch (method) {
        case 'getCanvasState':    return api.getCanvasState();
        case 'getCanvasElements': return api.getCanvasElements();
        case 'getAgent':          return api.getAgent(String(args.id));
        case 'moveAgent':         return api.moveAgent(String(args.id), Number(args.x), Number(args.y)) ?? { ok: true };
        case 'createAgent':       return await api.createAgent(String(args.providerId), (args.name as string) ?? null, (args.contextSnapshot as string) ?? null);
        case 'removeAgent':       return await api.removeAgent(String(args.id)) ?? { ok: true };
        case 'arrange':           return api.arrange(String(args.mode));
        case 'addFile':           return api.addFile(args as unknown as CanvasFileRequest);
        case 'addNote':           return api.addNote(args as unknown as { agentId: string; text: string; x?: number; y?: number });
        case 'appAction':         return await api.appAction(String(args.action), (args.params as Record<string, unknown>) ?? {});
        default:                  return { error: `Unknown bridge method: ${method}` };
      }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };

  return api;
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

    // ── Agent mesh → canvas ──
    // Self-reported status from agent_set_status. This is what the flip
    // view renders and what drives file-conflict warnings.
    listen('agent-status-report', (report: any) => {
      if (!report?.agentId) return;
      useAppStore.getState().setAgentReport({
        agentId: report.agentId,
        name: report.name,
        providerId: report.providerId,
        phase: report.phase,
        task: report.task ?? '',
        detail: report.detail,
        progress: report.progress,
        files: report.files ?? [],
        tags: report.tags ?? [],
        updatedAt: report.updatedAt ?? Date.now(),
        startedAt: report.startedAt ?? Date.now(),
      });
    });

    // Agent-to-agent messages also surface to the user, so a handoff
    // isn't something you only discover by reading a terminal.
    listen('agent-message', (msg: any) => {
      if (!msg?.subject) return;
      const to = msg.toName ? ` → ${msg.toName.split(' - ')[0]}` : ' → all';
      useAppStore.getState().pushToast({
        text: `${msg.fromName?.split(' - ')[0] ?? 'Agent'}${to}: ${msg.subject}`,
        tone: msg.kind === 'handoff' ? 'warn' : 'info',
      });
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
