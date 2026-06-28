// ── ORCH Command Palette — Search Index Registry ──────────────────
// Static registry of every executable action in ORCH.
// The CommandPalette component queries this to show results,
// then calls execute() when the user selects an action.
//
// Categories:
//   theme  — switch visual themes instantly
//   node   — create/spawn canvas nodes (agents, panels)
//   action — perform an instant command (toggle panels, focus)
//   data   — query recent data (store.json, terminal history)

import { useThemeStore } from '../stores/useThemeStore';
import type { ThemeName } from '../styles/theme';
import { useAppStore } from '../stores/useAppStore';
import { useWorkspaceStore } from '../stores/useWorkspaceStore';
import type { LayoutMode } from '../stores/useWorkspaceStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { invoke } from './electron-api';
import type { Agent } from '../stores/useAppStore';

// ── Types ──────────────────────────────────────────────────────────

export type ActionCategory = 'theme' | 'node' | 'action' | 'data';
export type ActionExecType = 'instant' | 'staged';

export interface SearchAction {
  id: string;
  title: string;
  description: string;
  category: ActionCategory;
  actionType: ActionExecType;
  /** Optional tags for extra search surface */
  tags?: string[];
  /** Execute the action — called when user selects it */
  execute: () => void;
}

// ── Registry ───────────────────────────────────────────────────────

class SearchRegistry {
  private actions: SearchAction[] = [];
  private initialized = false;

  /** Lazily build the action list so dynamic state (agents, providers) is fresh. */
  private ensure(): SearchAction[] {
    if (this.initialized) return this.actions;

    const actions: SearchAction[] = [];

    // ── Theme actions (instant) ─────────────────────────────────
    actions.push(
      {
        id: 'theme-eden',
        title: 'Theme: Overgrown Transit',
        description: 'Switch to the deep-forest Eden theme',
        category: 'theme',
        actionType: 'instant',
        tags: ['eden', 'green', 'forest', 'amber', 'teal'],
        execute: () => useThemeStore.getState().setTheme('eden' as ThemeName),
      },
      {
        id: 'theme-twilight',
        title: 'Theme: Twilight Horizon',
        description: 'Switch to the sunset-purple Twilight theme',
        category: 'theme',
        actionType: 'instant',
        tags: ['twilight', 'purple', 'sunset', 'orchid'],
        execute: () => useThemeStore.getState().setTheme('twilight' as ThemeName),
      },
      {
        id: 'theme-crimson',
        title: 'Theme: Crimson Age',
        description: 'Switch to the aggressive cybernetic Crimson theme',
        category: 'theme',
        actionType: 'instant',
        tags: ['crimson', 'red', 'dark', 'cyber'],
        execute: () => useThemeStore.getState().setTheme('crimson' as ThemeName),
      },
    );

    // ── Spawn agent actions (staged — fires creation) ───────────
    const providers = useSettingsStore.getState().providers;
    for (const p of providers) {
      if (p.shell) continue; // skip raw shell entries
      actions.push({
        id: `spawn-${p.id}`,
        title: `Spawn: ${p.name}`,
        description: `Create a new ${p.name} agent on the canvas`,
        category: 'node',
        actionType: 'staged',
        tags: [p.id, 'agent', 'spawn', 'create'],
        execute: () => {
          const bridge = (window as any).__orchBridge;
          if (bridge?.createAgent) {
            bridge.createAgent(p.id, null, null).catch(console.error);
          }
        },
      });
    }

    // ── Panel toggle actions (instant) ──────────────────────────
    actions.push(
      {
        id: 'toggle-browser',
        title: 'Toggle Browser Panel',
        description: 'Show or hide the web browser panel',
        category: 'action',
        actionType: 'instant',
        tags: ['browser', 'web', 'toggle', 'panel'],
        execute: () => {
          import('../stores/useBrowserStore').then((mod) => {
            const bs = mod.useBrowserStore.getState();
            bs.visible ? bs.setVisible(false) : bs.openBrowser();
          });
        },
      },
      {
        id: 'toggle-music',
        title: 'Toggle Music Player',
        description: 'Show or hide the music player panel',
        category: 'action',
        actionType: 'instant',
        tags: ['music', 'player', 'toggle', 'panel', 'audio'],
        execute: () => {
          import('../stores/useMusicPlayerStore').then((mod) => {
            mod.useMusicPlayerStore.getState().toggleVisible();
          });
        },
      },
      {
        id: 'toggle-forge',
        title: 'Toggle Forge Panel',
        description: 'Show or hide the forge/agent-deployment panel',
        category: 'action',
        actionType: 'instant',
        tags: ['forge', 'agent', 'deploy', 'toggle', 'panel'],
        execute: () => {
          import('../stores/useForgeStore').then((mod) => {
            mod.useForgeStore.getState().toggleVisible();
          });
        },
      },
      {
        id: 'toggle-feedback',
        title: 'Toggle Issue Tracker',
        description: 'Show or hide the bug reporter / issue tracker panel',
        category: 'action',
        actionType: 'instant',
        tags: ['feedback', 'bug', 'issue', 'tracker', 'report'],
        execute: () => {
          import('../stores/useFeedbackStore').then((mod) => {
            const fb = mod.useFeedbackStore.getState();
            fb.setPanelVisible(!fb.panelVisible);
          });
        },
      },
      {
        id: 'arrange-tidy',
        title: 'Tidy Agents',
        description: 'Auto-arrange all agent cards in a tidy grid',
        category: 'action',
        actionType: 'instant',
        tags: ['arrange', 'tidy', 'layout', 'organize', 'grid'],
        execute: () => useWorkspaceStore.getState().setLayoutMode?.('tidy'),
      },
      {
        id: 'arrange-grid',
        title: 'Arrange as Grid',
        description: 'Arrange all agent cards in a strict grid layout',
        category: 'action',
        actionType: 'instant',
        tags: ['arrange', 'grid', 'layout'],
        execute: () => useWorkspaceStore.getState().setLayoutMode?.('grid'),
      },
      {
        id: 'arrange-stage',
        title: 'Stage View',
        description: 'Arrange agents in a presentation stage layout',
        category: 'action',
        actionType: 'instant',
        tags: ['arrange', 'stage', 'presentation', 'layout'],
        execute: () => useWorkspaceStore.getState().setLayoutMode?.('stage'),
      },
    );

    // ── Focus agent actions (dynamic — built from current agents) ──
    const agents = useAppStore.getState().agents;
    for (const a of agents) {
      actions.push({
        id: `focus-${a.id}`,
        title: `Focus: ${a.name}`,
        description: `Pan canvas to agent ${a.name} (${a.role}, ${a.provider || 'shell'})`,
        category: 'node',
        actionType: 'instant',
        tags: [a.name, a.role, a.provider || '', 'focus', 'agent', 'canvas'],
        execute: () => useAppStore.getState().focusOnAgent(a),
      });
    }

    // ── Data actions (staged — fetch from store.json) ───────────
    actions.push(
      {
        id: 'data-stats',
        title: 'Session Stats',
        description: 'Show terminal count, agent logs, DB size from local store',
        category: 'data',
        actionType: 'staged',
        tags: ['stats', 'session', 'terminal', 'database', 'store'],
        execute: () => {
          invoke('local_db_get_stats').then((stats: any) => {
            console.log('[Palette] Local DB stats:', stats);
            // Surface via a temporary notification-style log
            const lines = [
              `── Local Store Stats ──`,
              `Terminals: ${stats?.totalTerminals ?? '?'} (${stats?.activeTerminals ?? 0} active)`,
              `Agent logs: ${stats?.totalAgentLogs ?? '?'}`,
              `Session events: ${stats?.totalSessionEvents ?? '?'}`,
              `Workspaces: ${stats?.workspaces ?? 0}`,
              `DB size: ${stats?.dbSizeBytes ? `${(stats.dbSizeBytes / 1024).toFixed(1)} KB` : '?'}`,
              `Path: ${stats?.dbPath ?? '?'}`,
            ].join('\n');
            console.log(lines);
          }).catch((err: any) => console.warn('[Palette] Stats unavailable:', err));
        },
      },
      {
        id: 'data-history',
        title: 'Terminal History',
        description: 'List recent terminal sessions from the local database',
        category: 'data',
        actionType: 'staged',
        tags: ['history', 'terminal', 'sessions', 'recent', 'logs'],
        execute: () => {
          import('./electron-api').then(({ invoke }) => {
            invoke('local_db_list_terminal_history', { limit: 10 }).then((entries: any) => {
              const lines = (entries || []).map((e: any, i: number) =>
                `${i + 1}. ${e.name || '?'} (${e.providerId || 'shell'}) — ${e.startedAt?.slice(0, 19) ?? '?'} ${e.endedAt ? '✓' : '…'}`
              ).join('\n');
              console.log(`── Recent Terminals ──\n${lines || '(none)'}`);
            }).catch(() => {});
          });
        },
      },
    );

    this.actions = actions;
    this.initialized = true;
    return this.actions;
  }

  /** Refresh dynamic actions (agent list, providers) and return all. */
  refresh(): SearchAction[] {
    this.initialized = false;
    return this.ensure();
  }

  /** Search actions by query — matches title, description, tags. */
  search(query: string): SearchAction[] {
    if (!query.trim()) return this.ensure();

    const lower = query.toLowerCase().trim();
    const terms = lower.split(/\s+/).filter(Boolean);

    return this.ensure()
      .map((action) => {
        const haystack = [
          action.title.toLowerCase(),
          action.description.toLowerCase(),
          action.id.toLowerCase(),
          action.category,
          ...(action.tags ?? []).map((t) => t.toLowerCase()),
        ].join(' ');

        let score = 0;
        for (const term of terms) {
          if (haystack.includes(term)) {
            score += 1;
            // Boost: exact title prefix match
            if (action.title.toLowerCase().startsWith(term)) score += 2;
            // Boost: category match
            if (action.category === term) score += 2;
          }
        }

        return { action, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12)
      .map((entry) => entry.action);
  }

  /** Execute an action by id. */
  execute(id: string): boolean {
    const action = this.ensure().find((a) => a.id === id);
    if (!action) return false;
    try {
      action.execute();
      return true;
    } catch (err) {
      console.error(`[Palette] Execute failed for "${id}":`, err);
      return false;
    }
  }

  /** Get a single action by id (for keyboard preview). */
  get(id: string): SearchAction | undefined {
    return this.ensure().find((a) => a.id === id);
  }
}

// Singleton
export const searchRegistry = new SearchRegistry();
