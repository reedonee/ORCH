// ── ORCH Panel Registry Store ────────────────────────────────
// Central registry for every movable, focusable, or spatial surface.
// Provides: registration, z-stack management, drag/resize lifecycle,
// layout motion tokens, and query helpers.
//
// This store is the single source of truth for panel geometry.
// Components read from it; store writes are batched for performance.

import { create } from 'zustand';
import { includes } from '../lib/array-utils';
import { useAppStore } from './useAppStore';
import type {
  PanelNode,
  PanelRegistration,
  LayoutSnapshot,
  LayoutMotion,
  LayoutPhase,
} from '../types/panel';

/** Build a fully resolved PanelNode from a registration payload. */
function resolveRegistration(r: PanelRegistration): PanelNode {
  return {
    id: r.id,
    type: r.type,
    space: r.space,
    x: r.x,
    y: r.y,
    width: r.width,
    height: r.height,
    minWidth: r.minWidth ?? 180,
    minHeight: r.minHeight ?? 120,
    defaultWidth: r.defaultWidth ?? r.width,
    defaultHeight: r.defaultHeight ?? r.height,
    participatesInAutoLayout: r.participatesInAutoLayout ?? false,
    participatesInFraming: r.participatesInFraming ?? false,
    participatesInCollision: r.participatesInCollision ?? false,
    draggable: r.draggable ?? false,
    resizable: r.resizable ?? false,
    focusable: r.focusable ?? false,
    locked: r.locked ?? false,
    baseZIndex: r.baseZIndex ?? 10,
    zIndex: r.baseZIndex ?? 10,
    minimized: r.minimized ?? false,
    opacity: r.opacity ?? 1,
    persistent: r.persistent ?? true,
    agentRef: r.agentRef,
  };
}

/** Generate a unique snapshot id from the label and time. */
function makeSnapshotId(label: string): string {
  const slug = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const stamp = Date.now().toString(36);
  return `${slug || 'snapshot'}-${stamp}`;
}

// ── Public API ───────────────────────────────────────────────

export interface PanelRegistryState {
  /** All registered panels, keyed by id */
  panels: Record<string, PanelNode>;

  /** Front-to-back ordered list of panel IDs (focus order) */
  zStack: string[];

  /** Currently focused panel (most recent click — drives visual priority) */
  activePanelId: string | null;

  /** Panel currently being dragged (mouse is down and moving) */
  dragPanelId: string | null;

  /** Panel currently being resized */
  resizePanelId: string | null;

  /** Layout engine lifecycle phase */
  layoutPhase: LayoutPhase;

  /** Current layout motion tokens — panels read this for CSS transitions */
  layoutMotion: LayoutMotion;

  // ── Registration ──────────────────────────────────────────

  /** Add a panel to the registry. If id exists, updates instead. */
  registerPanel: (reg: PanelRegistration) => void;

  /** Batch-register multiple panels (e.g. hydration from workspace) */
  registerPanels: (regs: PanelRegistration[]) => void;

  /** Remove a panel from the registry */
  unregisterPanel: (id: string) => void;

  /** Update one panel's properties (patches only the provided fields) */
  updatePanel: (id: string, patch: Partial<PanelNode>) => void;

  /** Batch update multiple panels in one state commit */
  batchUpdatePanels: (updates: Array<{ id: string; patch: Partial<PanelNode> }>) => void;

  /** Set layout motion tokens (called by the layout engine) */
  setLayoutMotion: (motion: LayoutMotion) => void;

  /** Set layout phase */
  setLayoutPhase: (phase: LayoutPhase) => void;

  // ── Z-Stack & Focus ───────────────────────────────────────

  /** Focus a panel: set activePanelId and move it to the top of zStack */
  focusPanel: (id: string | null) => void;

  /** Bring a panel to the front without changing active focus */
  bringToFront: (id: string) => void;

  /** Send a panel to the back of its layer */
  sendToBack: (id: string) => void;

  // ── Drag / Resize lifecycle ───────────────────────────────

  /** Begin a drag operation */
  beginDrag: (id: string) => void;
  /** End a drag operation */
  endDrag: () => void;

  /** Begin a resize operation */
  beginResize: (id: string) => void;
  /** End a resize operation */
  endResize: () => void;

  // ── Queries ───────────────────────────────────────────────

  /** Panels whose space='canvas' */
  getCanvasPanels: () => PanelNode[];

  /** Panels whose space='fixed' */
  getFixedPanels: () => PanelNode[];

  /** Panels with participatesInAutoLayout=true */
  getArrangablePanels: () => PanelNode[];

  /** Panels with participatesInFraming=true */
  getFramablePanels: () => PanelNode[];

  /** Panels with participatesInCollision=true */
  getCollidablePanels: () => PanelNode[];

  /** Panels that are currently visible and not minimized */
  getVisiblePanels: () => PanelNode[];

  // ── Layout Snapshots ─────────────────────────────────────

  /**
   * Capture the current spatial composition as a LayoutSnapshot.
   * Includes every registered panel's geometry, the z-stack order,
   * and the current viewport transform.
   */
  captureSnapshot: (label: string, id?: string) => LayoutSnapshot;

  /**
   * Restore a previously captured snapshot.
   * Applies panel geometries and viewport in a single batch with
   * layoutMotion='spring' so the transition animates.
   */
  restoreSnapshot: (snapshot: LayoutSnapshot) => void;
}

export const usePanelRegistry = create<PanelRegistryState>()(
  (set, get) => ({
    panels: {},
    zStack: [],
    activePanelId: null,
    dragPanelId: null,
    resizePanelId: null,
    layoutPhase: 'idle',
    layoutMotion: { mode: 'none', transition: '' },

    // ── Registration ──────────────────────────────────────────

    registerPanel: (reg) => {
      const node = resolveRegistration(reg);
      set((state) => ({
        panels: { ...state.panels, [reg.id]: node },
        zStack: includes(state.zStack, reg.id)
          ? state.zStack
          : state.zStack.concat([reg.id]),
      }));
    },

    registerPanels: (regs) => {
      const entries: Record<string, PanelNode> = {};
      const newIds: string[] = [];
      for (let i = 0; i < regs.length; i++) {
        const reg = regs[i];
        entries[reg.id] = resolveRegistration(reg);
        newIds.push(reg.id);
      }
      set((state) => {
        let zStack = state.zStack;
        for (let i = 0; i < newIds.length; i++) {
          if (!includes(zStack, newIds[i])) {
            zStack = zStack.concat([newIds[i]]);
          }
        }
        return {
          panels: { ...state.panels, ...entries },
          zStack,
        };
      });
    },

    unregisterPanel: (id) => {
      set((state) => {
        const panels: Record<string, PanelNode> = {};
        const pKeys = Object.keys(state.panels);
        for (let i = 0; i < pKeys.length; i++) {
          if (pKeys[i] !== id) {
            panels[pKeys[i]] = state.panels[pKeys[i]];
          }
        }
        return {
          panels,
          zStack: state.zStack.filter((pid) => pid !== id),
          activePanelId: state.activePanelId === id ? null : state.activePanelId,
          dragPanelId: state.dragPanelId === id ? null : state.dragPanelId,
          resizePanelId: state.resizePanelId === id ? null : state.resizePanelId,
        };
      });
    },

    updatePanel: (id, patch) => {
      set((state) => {
        const existing = state.panels[id];
        if (!existing) return state;
        return {
          panels: {
            ...state.panels,
            [id]: { ...existing, ...patch },
          },
        };
      });
    },

    batchUpdatePanels: (updates) => {
      set((state) => {
        const panels = { ...state.panels };
        for (let i = 0; i < updates.length; i++) {
          const { id, patch } = updates[i];
          const existing = panels[id];
          if (existing) panels[id] = { ...existing, ...patch };
        }
        return { panels };
      });
    },

    setLayoutMotion: (motion) => set({ layoutMotion: motion }),
    setLayoutPhase: (phase) => set({ layoutPhase: phase }),

    // ── Z-Stack & Focus ───────────────────────────────────────

    focusPanel: (id) => {
      if (!id) {
        set({ activePanelId: null });
        return;
      }
      set((state) => {
        if (!state.panels[id]) return state;
        // Move to front in zStack
        const zStack = state.zStack.filter((pid) => pid !== id);
        zStack.push(id);
        return {
          activePanelId: id,
          zStack,
        };
      });
    },

    bringToFront: (id) => {
      set((state) => {
        if (!state.panels[id]) return state;
        const zStack = state.zStack.filter((pid) => pid !== id);
        zStack.push(id);
        return { zStack };
      });
    },

    sendToBack: (id) => {
      set((state) => {
        if (!state.panels[id]) return state;
        const zStack = state.zStack.filter((pid) => pid !== id);
        zStack.unshift(id);
        return { zStack };
      });
    },

    // ── Drag / Resize lifecycle ───────────────────────────────

    beginDrag: (id) => {
      set((state) => {
        const zStack = state.zStack.filter((pid) => pid !== id);
        zStack.push(id);
        return { dragPanelId: id, zStack };
      });
    },

    endDrag: () => {
      const id = get().dragPanelId;
      set({ dragPanelId: null });
      // Mark manually moved so smart reflow can distinguish user placement
      if (id) get().updatePanel(id, { locked: true, wasManuallyMoved: true });
    },

    beginResize: (id) => set({ resizePanelId: id }),
    endResize: () => set({ resizePanelId: null }),

    // ── Queries ───────────────────────────────────────────────

    getCanvasPanels: () => {
      const panels = get().panels;
      const keys = Object.keys(panels);
      const result: PanelNode[] = [];
      for (let i = 0; i < keys.length; i++) {
        if (panels[keys[i]].space === 'canvas') result.push(panels[keys[i]]);
      }
      return result;
    },

    getFixedPanels: () => {
      const panels = get().panels;
      const keys = Object.keys(panels);
      const result: PanelNode[] = [];
      for (let i = 0; i < keys.length; i++) {
        if (panels[keys[i]].space === 'fixed') result.push(panels[keys[i]]);
      }
      return result;
    },

    getArrangablePanels: () => {
      const panels = get().panels;
      const keys = Object.keys(panels);
      const result: PanelNode[] = [];
      for (let i = 0; i < keys.length; i++) {
        if (panels[keys[i]].participatesInAutoLayout) result.push(panels[keys[i]]);
      }
      return result;
    },

    getFramablePanels: () => {
      const panels = get().panels;
      const keys = Object.keys(panels);
      const result: PanelNode[] = [];
      for (let i = 0; i < keys.length; i++) {
        if (panels[keys[i]].participatesInFraming) result.push(panels[keys[i]]);
      }
      return result;
    },

    getCollidablePanels: () => {
      const panels = get().panels;
      const keys = Object.keys(panels);
      const result: PanelNode[] = [];
      for (let i = 0; i < keys.length; i++) {
        if (panels[keys[i]].participatesInCollision) result.push(panels[keys[i]]);
      }
      return result;
    },

    getVisiblePanels: () => {
      const panels = get().panels;
      const keys = Object.keys(panels);
      const result: PanelNode[] = [];
      for (let i = 0; i < keys.length; i++) {
        const p = panels[keys[i]];
        if (!p.minimized && p.opacity > 0) result.push(p);
      }
      return result;
    },

    // ── Layout Snapshots ─────────────────────────────────────

    captureSnapshot: (label, id) => {
      const app = useAppStore.getState();
      const panels = get().getVisiblePanels();
      const snapshotId = id || makeSnapshotId(label);
      return {
        id: snapshotId,
        label,
        createdAt: new Date().toISOString(),
        viewportPan: { ...app.viewportPan },
        viewportZoom: app.viewportZoom,
        zStack: get().zStack.slice(),
        panels: panels.map((panel) => ({
          id: panel.id,
          type: panel.type,
          space: panel.space,
          x: panel.x,
          y: panel.y,
          width: panel.width,
          height: panel.height,
          minimized: panel.minimized,
        })),
      };
    },

    restoreSnapshot: (snapshot) => {
      const panels = get().panels;
      const updates: Array<{ id: string; patch: Partial<PanelNode> }> = [];
      for (let i = 0; i < snapshot.panels.length; i++) {
        const entry = snapshot.panels[i];
        if (panels[entry.id]) {
          updates.push({
            id: entry.id,
            patch: {
              x: entry.x,
              y: entry.y,
              width: entry.width,
              height: entry.height,
              minimized: entry.minimized,
              space: entry.space,
            },
          });
        }
      }
      if (updates.length > 0) {
        set((state) => {
          const nextPanels = { ...state.panels };
          for (let i = 0; i < updates.length; i++) {
            const { id, patch } = updates[i];
            const existing = nextPanels[id];
            if (existing) nextPanels[id] = { ...existing, ...patch };
          }
          return {
            panels: nextPanels,
            zStack: snapshot.zStack.slice(),
            layoutMotion: {
              mode: 'spring',
              transition:
                'left 450ms cubic-bezier(0.34, 1.56, 0.64, 1), top 450ms cubic-bezier(0.34, 1.56, 0.64, 1), width 450ms cubic-bezier(0.34, 1.56, 0.64, 1), height 450ms cubic-bezier(0.34, 1.56, 0.64, 1)',
            },
          };
        });
      }

      useAppStore.getState().requestViewportFrame(snapshot.viewportPan, snapshot.viewportZoom);
    },
  }),
);
