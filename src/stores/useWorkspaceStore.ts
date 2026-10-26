// ── ORCH Workspace Store ───────────────────────────────────────
// Manages the folder-centric workspace model.
// Each workspace = a user-chosen directory containing .orch-workspace.json

import { create } from 'zustand';
import { invoke } from '../lib/electron-api';
import {
  selectWorkspaceFolder,
  writeWorkspaceFile,
  readWorkspaceFile,
  getRecentWorkspaces,
  saveRecentWorkspaces,
  workspaceExists,
} from '../lib/electron-api';
import { useCanvasStore } from './useCanvasStore';
import { useAppStore } from './useAppStore';
import { useThemeStore } from './useThemeStore';
import { useSettingsStore } from './useSettingsStore';
import { useAuthStore } from './useAuthStore';
import { usePanelRegistry } from './usePanelRegistry';
import { useBrowserStore } from './useBrowserStore';
import { useMusicPlayerStore } from './useMusicPlayerStore';
import { useForgeStore } from './useForgeStore';
import { useFeedbackStore } from './useFeedbackStore';
import { upsertWorkspace, upsertDevicePath } from '../lib/db';
import type { Agent } from './useAppStore';
import type { LayoutPreset } from '../types/panel';
import type {
  WorkspaceMeta,
  WorkspaceFile,
  WorkspaceStyleData,
} from '../types/workspace';
import {
  findSpawnSlot,
  computeSafeRegion,
  frameViewport,
  CHROME,
} from '../lib/layout-engine';
import type { PanelItem, SafeRegion, ChromeInsets } from '../lib/layout-engine';
import {
  runLayout,
  boundingBox,
  isLayoutMode,
  type LayoutNode,
  type LayoutModeName,
  type Region as EngineRegion,
} from '../lib/layout-modes';

// ── Layout Engine Specification ─────────────────────────────────
export const LAYOUT_ENGINE_SPEC = {
  arrangements: {
    tidyPadding: 32,
    gridSnap: 32,
    startX: 80,
    stageWidthRatio: 0.65,
    stageColumnWidth: 280,
    stageGap: 12,
    stageMaxSideRatio: 0.30,
    stageHeightRatio: 0.75,
    secondaryScaleMax: 0.45,
  },
  animation: {
    duration: 450,
    staggerDelay: 60,
    spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
    decelerate: 'cubic-bezier(0.16, 1, 0.3, 1)',
  },
  autoArrangeDebounceMs: 200,
  framer: {
    maxZoom: 1.0,
    minZoom: 0.35,
    padding: 60,
  },
  chrome: {
    topOffset: 56,
  },
  sizing: {
    minAgentWidth: 320,
    minAgentHeight: 200,
    maxAgentWidth: 600,
    maxAgentHeight: 420,
    targetMaxVisibleRows: 3,
  },
  defaultAgentWidth: 520,
  defaultAgentHeight: 360,
} as const;

/** 'tidy' is kept as an alias of 'grid' for workspaces saved by older
 *  builds; everything else maps 1:1 onto the engine's modes. */
export type LayoutMode = LayoutModeName | 'tidy';

export interface ArrangeOptions {
  /** Agent to feature in focus mode. Defaults to the current selection. */
  focusId?: string | null;
  /** Re-frame the viewport to fit the result. Default true. */
  frame?: boolean;
  /** Keep user-pinned panels pinned. Default false (explicit arrange). */
  preserveLocks?: boolean;
}

export interface CanvasWindowSettings {
  allowAgentCanvasControl: boolean;
  tidyOnWindowOpen: boolean;
  tidyOnWindowClose: boolean;
}

// ── In-memory workspace cache ──────────────────────────────────
const workspaceCache = new Map<string, WorkspaceFile>();
const MAX_CACHE = 10;

function cacheSet(path: string, data: WorkspaceFile) {
  if (workspaceCache.size >= MAX_CACHE) {
    let oldest = '';
    let oldestTs = Infinity;
    for (const [p, d] of workspaceCache) {
      if (d.lastOpened < oldestTs) { oldest = p; oldestTs = d.lastOpened; }
    }
    if (oldest) workspaceCache.delete(oldest);
  }
  workspaceCache.set(path, data);
}

function folderNameFromPath(fp: string): string {
  const parts = fp.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || 'Unnamed';
}

/** Build the style data block from current store state */
function captureStyle(): WorkspaceStyleData {
  const { themeName } = useThemeStore.getState();
  const { showGrid, gridSnap } = useSettingsStore.getState();
  return { themeName, showGrid, gridSnap };
}

/** Apply a style data block to the current store state */
function applyStyle(style?: WorkspaceStyleData | null) {
  if (!style) return;
  const { themeName, showGrid, gridSnap } = style;
  if (themeName) useThemeStore.getState().setTheme(themeName as any);
  if (showGrid !== undefined) useSettingsStore.getState().setShowGrid(showGrid);
  if (gridSnap !== undefined) useSettingsStore.getState().setGridSnap(gridSnap);
}

// ── Collect panels from the registry (single source of truth) ───
// Reads every visible, auto-layout-participating panel regardless of type.
// New node types just register with participatesInAutoLayout:true and are
// picked up automatically — no per-type hardcoding here.
function collectPanels(): PanelItem[] {
  const registry = usePanelRegistry.getState();
  const browser = useBrowserStore.getState();
  const music = useMusicPlayerStore.getState();
  const forge = useForgeStore.getState();
  const feedback = useFeedbackStore.getState();

  const panels: PanelItem[] = [];
  const registryPanels = registry.panels;
  const keys = Object.keys(registryPanels);

  for (let i = 0; i < keys.length; i++) {
    const p = registryPanels[keys[i]];
    // Skip panels that don't participate in auto-layout
    if (!p.participatesInAutoLayout) continue;
    // Skip minimized panels
    if (p.minimized) continue;

    // Visibility gate per type. Agents are always visible while registered;
    // overlays (browser/music/forge/feedback) gate on their store flag.
    let visible = true;
    if (p.type === 'browser') visible = browser.visible;
    else if (p.type === 'music') visible = music.visible;
    else if (p.type === 'forge') visible = forge.visible;
    else if (p.type === 'feedback') visible = feedback.panelVisible;
    if (!visible) continue;

    // Locked panels are present (as obstacles) but the engine won't move them.
    panels.push({
      id: p.id,
      type: p.type,
      x: p.x,
      y: p.y,
      width: p.width,
      height: p.height,
      locked: p.locked,
    });
  }

  return panels;
}

// ═════════════════════════════════════════════════════════════════
// LIFECYCLE SUBSCRIPTIONS
// ═════════════════════════════════════════════════════════════════

let lifecycleUnsub: (() => void) | null = null;

function subscribeAgentLifecycle() {
  if (lifecycleUnsub) return;

  lifecycleUnsub = useAppStore.subscribe((state, prevState) => {
    const prevCount = prevState.agents.length;
    const currCount = state.agents.length;
    if (currCount === prevCount || currCount === 0) return;

    // ── Always auto-arrange on agent count change ─────────────
    // Spawn or close → smart layout fires so nodes never stack and
    // always maintain 1-grid-gap spacing with adaptive cell sizing.
    const ws = useWorkspaceStore.getState();

    if (ws.layoutMode) {
      queueMicrotask(() => ws.notifyAgentChanged());
      return;
    }

    // For fresh workspace (0→N), arrange immediately (no debounce).
    if (prevCount === 0 && currCount > 0) {
      queueMicrotask(() => ws.autoArrange());
      return;
    }

    // Spawn or close with existing nodes → reflow with debounce.
    if (currCount !== prevCount && currCount > 0) {
      debounceAutoArrange();
      return;
    }

    // All agents removed — no-op.
    if (currCount === 0) return;
  });

  // Viewport resize
  useAppStore.subscribe((state, prevState) => {
    const { w: pw, h: ph } = prevState.viewportWinSize;
    const { w: cw, h: ch } = state.viewportWinSize;
    if (pw === cw && ph === ch) return;
    if (Math.abs(cw - pw) < 50 && Math.abs(ch - ph) < 50) return;
    const ws = useWorkspaceStore.getState();
    if (ws.layoutMode) {
      queueMicrotask(() => ws.notifyAgentChanged());
    } else {
      debounceAutoArrange();
    }
  });

  // Browser/Music visibility. Make room in the layout the user already
  // chose, without moving the camera. This used to force a fresh 'grid'
  // arrange and re-frame — every open of the browser threw away the
  // user's layout mode and shuffled the canvas.
  useBrowserStore.subscribe((state, prevState) => {
    if (state.visible === prevState.visible) return;
    debounceReflowCurrentMode();
  });
  useMusicPlayerStore.subscribe((state, prevState) => {
    if (state.visible === prevState.visible) return;
    debounceReflowCurrentMode();
  });

  // Panel resize — re-arrange ONLY when a movable (non-locked) panel's size
  // changed AND there are other movable panels it could collide with. User-pinned
  // panels (locked=true after a manual resize) are left alone — the engine never
  // fights the user. Fixed panels (browser/music) reflow around a locked obstacle.
  usePanelRegistry.subscribe((state, prevState) => {
    for (const id of Object.keys(state.panels)) {
      const curr = state.panels[id];
      const prev = prevState.panels[id];
      if (!curr || !prev) continue;
      if (curr.width === prev.width && curr.height === prev.height) continue;
      // A user just resized this panel manually → pin it, do NOT auto-arrange
      // it back. Re-arrange the OTHER panels around it (locks preserved).
      if (curr.locked) {
        const movable = usePanelRegistry.getState().getArrangablePanels();
        if (movable.length > 1) debounceReflowAroundLocks();
      } else {
        debounceReflowAroundLocks();
      }
      break;
    }
  });
}

/** Adapt the panel registry to the layout engine's node shape. */
function collectLayoutNodes(): LayoutNode[] {
  return collectPanels().map((p) => ({
    id: p.id,
    type: p.type,
    x: p.x,
    y: p.y,
    width: p.width,
    height: p.height,
    locked: p.locked,
  }));
}

/** SafeRegion and the engine's Region are structurally identical today,
 *  but they are owned by different modules — convert explicitly so a
 *  future change to either one is a compile error, not a silent bug. */
function toEngineRegion(r: SafeRegion): EngineRegion {
  return {
    left: r.left,
    top: r.top,
    right: r.right,
    bottom: r.bottom,
    width: r.width,
    height: r.height,
  };
}

// ── Debounce timers ────────────────────────────────────────────
// Two distinct debounce paths:
//   debounceAutoArrange()         — fires autoArrange() which CLEARS locks
//                                   (used by explicit arrange actions + lifecycle).
//   debounceReflowAroundLocks()   — fires autoArrangeRespectingLocks() which
//                                   preserves user-pinned panels (used by the
//                                   manual-resize subscription so the just-resized
//                                   panel isn't snapped back to the cell size).
let autoArrangeTimer: ReturnType<typeof setTimeout> | null = null;
let reflowTimer: ReturnType<typeof setTimeout> | null = null;

// ── Layout generation counter ─────────────────────────────────
// Prevents stale commits when multiple lifecycle triggers race.
// Each arrange call captures its generation before resolveLayout;
// if another arrange incremented the counter before it commits,
// the stale result is discarded.
let layoutGeneration = 0;

function withGeneration(fn: () => void) {
  const gen = ++layoutGeneration;
  return () => {
    if (gen !== layoutGeneration) return; // stale — discard
    fn();
  };
}

/** Measure actual chrome positions from the DOM. Returns ChromeInsets
 *  with the real bottom-edge of the pill bar and top-edge of the chat bar,
 *  or sensible defaults when the elements aren't found (e.g. pre-mount).
 *  Padding reduced to 8px for tighter safe region fitting. */
function measureChromeInsets(): ChromeInsets | undefined {
  if (typeof document === 'undefined') return undefined;
  const pillBar = document.querySelector('[data-chrome="pill-bar"]');
  const chatBar = document.querySelector('[data-chrome="chat-bar"]');
  const vh = window.innerHeight;
  const pillBottom = pillBar
    ? pillBar.getBoundingClientRect().bottom
    : 62; // fallback: 26 + 36
  const chatTop = chatBar
    ? chatBar.getBoundingClientRect().top
    : vh - 72; // fallback: vh - 28 - 44
  if (!pillBar && !chatBar) return undefined;
  return {
    topBarBottom:  pillBottom + 8,
    bottomBarTop:  chatTop - 8,
    leftReserved:  56,
    rightReserved: 8,
  };
}

function debounceAutoArrange() {
  if (autoArrangeTimer) clearTimeout(autoArrangeTimer);
  autoArrangeTimer = setTimeout(() => {
    autoArrangeTimer = null;
    useWorkspaceStore.getState().autoArrange();
  }, LAYOUT_ENGINE_SPEC.autoArrangeDebounceMs);
}

let reflowModeTimer: ReturnType<typeof setTimeout> | null = null;
/** Re-run the active layout mode (grid if none) in place: same mode, no
 *  camera move. For panels appearing/disappearing, not for "arrange". */
function debounceReflowCurrentMode() {
  if (reflowModeTimer) clearTimeout(reflowModeTimer);
  reflowModeTimer = setTimeout(() => {
    reflowModeTimer = null;
    const ws = useWorkspaceStore.getState();
    ws.arrange(ws.layoutMode ?? 'grid', { frame: false });
  }, LAYOUT_ENGINE_SPEC.autoArrangeDebounceMs);
}

function debounceReflowAroundLocks() {
  if (reflowTimer) clearTimeout(reflowTimer);
  reflowTimer = setTimeout(() => {
    reflowTimer = null;
    autoArrangeRespectingLocks();
  }, LAYOUT_ENGINE_SPEC.autoArrangeDebounceMs);
}

/** Arrange WITHOUT clearing locks — keeps user-resized panels in place and
 *  reflows the others around them. Used only by the resize subscription. */
/** Reflow around user-pinned panels without re-framing the camera.
 *  Used by the resize subscription so a manual resize isn't undone and
 *  the viewport doesn't jump while the user is dragging a corner. */
function autoArrangeRespectingLocks() {
  const ws = useWorkspaceStore.getState();
  ws.arrange(ws.layoutMode ?? 'grid', { preserveLocks: true, frame: false });
}

// ── Viewport Frame Commit ──────────────────────────────────────
// The engine's computed framing must reach the canvas. The canvas only owns
// pan/zoom locally and pushes to the store (canvas → store), so writing the
// store silently does nothing. Route the engine's result through the
// reverse channel (requestViewportFrame) which the canvas subscribes to.
function commitViewportFrame(pan: { x: number; y: number }, zoom: number, w: number, h: number) {
  useAppStore.getState().requestViewportFrame(pan, zoom);
}

/** Clear the user-pinned (locked) flag on every panel. Called by explicit
 *  arrange actions (Ctrl+L, tidy/grid/stage, voice arrange) so the engine is
 *  free to reposition everything. Implicit resize-triggered arranges leave
 *  locks intact so a manual resize isn't immediately undone. */
function clearAllLocks() {
  const registry = usePanelRegistry.getState();
  const keys = Object.keys(registry.panels);
  const updates: Array<{ id: string; patch: Partial<import('../types/panel').PanelNode> }> = [];
  for (let i = 0; i < keys.length; i++) {
    const p = registry.panels[keys[i]];
    if (p.locked || p.wasManuallyMoved) updates.push({ id: p.id, patch: { locked: false, wasManuallyMoved: false } });
  }
  if (updates.length > 0) registry.batchUpdatePanels(updates);
}

// ── Store ─────────────────────────────────────────────────────

interface WorkspaceState {
  currentWorkspacePath: string | null;
  currentWorkspaceName: string | null;
  recentWorkspaces: WorkspaceMeta[];
  isDirty: boolean;
  isBusy: boolean;
  error: string | null;
  autoOpenAttempted: boolean;
  cloudWorkspaceId: string | null;
  cloudRowVersion: number | null;

  // ── Layout Engine State ──────────────────────────────────────
  layoutMode: LayoutMode | null;
  layoutPhase: 'idle' | 'arranging' | 'settled';
  layoutTransition: string;
  layoutPresets: LayoutPreset[];
  activeLayoutPresetId: string | null;
  settings: CanvasWindowSettings;

  // ── Actions ───────────────────────────────────────────────
  loadRecentWorkspaces: () => Promise<void>;
  autoOpenLastWorkspace: () => Promise<void>;
  preloadCache: () => Promise<void>;
  createWorkspace: () => Promise<void>;
  openWorkspace: (path?: string) => Promise<void>;
  saveWorkspace: () => Promise<void>;
  switchWorkspace: (path: string) => Promise<void>;
  closeWorkspace: () => Promise<void>;
  markDirty: () => void;
  markClean: () => void;
  clearError: () => void;

  /** Primary entry point — every mode goes through here. */
  arrange: (mode?: LayoutMode, options?: ArrangeOptions) => void;
  autoArrange: () => void;
  arrangeTidy: () => void;
  arrangeGrid: () => void;
  arrangeStage: () => void;
  arrangeFocus: (focusId?: string) => void;
  setLayoutMode: (mode: LayoutMode | null) => void;
  notifyAgentChanged: () => void;
  toggleSetting: (key: keyof CanvasWindowSettings) => void;

  /** Single entry point for all spawn paths — calls findSpawnSlot */
  spawnPosition: (agentId?: string) => { x: number; y: number };

  /** Commit layout result in one batch */
  commitLayout: (
    positions: Array<{ id: string; x: number; y: number }>,
    sizes: Array<{ id: string; width: number; height: number }>,
    pan: { x: number; y: number },
    zoom: number,
    transitionStr: string,
    layoutMode: LayoutMode | null,
  ) => void;

  saveLayoutPreset: (label: string) => void;
  restoreLayoutPreset: (id: string) => void;
  deleteLayoutPreset: (id: string) => void;
}

export const useWorkspaceStore = create<WorkspaceState>()((set, get) => {
  subscribeAgentLifecycle();

  return {
  currentWorkspacePath: null,
  currentWorkspaceName: null,
  recentWorkspaces: [],
  isDirty: false,
  isBusy: false,
  error: null,
  autoOpenAttempted: false,
  cloudWorkspaceId: null,
  cloudRowVersion: null,

  layoutMode: null,
  layoutPhase: 'idle',
  layoutTransition: '',
  layoutPresets: [],
  activeLayoutPresetId: null,

  settings: {
    allowAgentCanvasControl: false,
    tidyOnWindowOpen: false,
    tidyOnWindowClose: false,
  },

  loadRecentWorkspaces: async () => {
    try {
      const list = await getRecentWorkspaces();
      set({ recentWorkspaces: list });
    } catch { /* non-critical */ }
  },

  autoOpenLastWorkspace: async () => {
    const { autoOpenAttempted, recentWorkspaces } = get();
    if (autoOpenAttempted) return;
    set({ autoOpenAttempted: true });
    let list = recentWorkspaces;
    if (list.length === 0) {
      try { list = await getRecentWorkspaces(); } catch { return; }
      if (list.length === 0) return;
      set({ recentWorkspaces: list });
    }
    const last = list.reduce((a, b) => (a.lastOpened > b.lastOpened ? a : b));
    if (!last?.path) return;
    try { await get().openWorkspace(last.path); } catch { /* non-fatal */ }
  },

  preloadCache: async () => {
    const { recentWorkspaces } = get();
    await Promise.allSettled(
      recentWorkspaces.map(async (ws) => {
        if (workspaceCache.has(ws.path)) return;
        const raw = await readWorkspaceFile(ws.path);
        if (raw) cacheSet(ws.path, raw as unknown as WorkspaceFile);
      }),
    );
  },

  createWorkspace: async () => {
    set({ isBusy: true, error: null });
    const { currentWorkspacePath: current } = get();
    if (current) {
      await get().saveWorkspace();
      useCanvasStore.getState().resetCanvas();
      useAppStore.getState().resetAppState();
    }
    const folderPath = await selectWorkspaceFolder();
    if (!folderPath) { set({ isBusy: false }); return; }
    try {
      const name = folderNameFromPath(folderPath);
      const style = captureStyle();
      const data: WorkspaceFile = {
        version: 1, name, lastOpened: Date.now(),
        canvas: { elements: [], strokeColor: '#ff781f', strokeWidth: 2, fillEnabled: false, fillOpacity: 20, fontSize: 14 },
        agents: { agents: [], viewportPan: { x: 0, y: 0 }, viewportZoom: 1 },
        style, layout: { presets: [], activePresetId: null },
      };
      await writeWorkspaceFile(folderPath, data);
      cacheSet(folderPath, data);
      useCanvasStore.getState().hydrateFromWorkspace({});
      useAppStore.getState().hydrateFromWorkspace({});
      const now = Date.now();
      const updated = updateRecentList(get().recentWorkspaces, folderPath, name, now);
      await saveRecentWorkspaces(updated);
      set({ currentWorkspacePath: folderPath, currentWorkspaceName: name, recentWorkspaces: updated, isDirty: false, isBusy: false });
      // Mirror to the main process so agents spawned before the renderer
      // has restored a workspace still land somewhere sensible.
      invoke('local_db_save_settings', {
        settings: { preferences: { lastWorkspacePath: folderPath } },
      }).catch(() => {});
      const authStatus = useAuthStore.getState().status;
      if (authStatus === 'authenticated') {
        upsertWorkspace({ name, canvas_data: data, style: style as any })
          .then((result) => {
            set({ cloudWorkspaceId: result.id, cloudRowVersion: result.version });
            upsertDevicePath(result.id, folderPath).catch(() => {});
          }).catch((err) => console.warn('[Cloud] Create sync failed:', err));
      }
    } catch (err: any) {
      set({ isBusy: false, error: err?.message || 'Failed to create workspace' });
    }
  },

  openWorkspace: async (path?: string) => {
    set({ isBusy: true, error: null });
    const { currentWorkspacePath: current } = get();
    if (current) {
      await get().saveWorkspace();
      useCanvasStore.getState().resetCanvas();
      useAppStore.getState().resetAppState();
    }
    let folderPath = path;
    if (!folderPath) {
      const selected = await selectWorkspaceFolder();
      if (!selected) { set({ isBusy: false }); return; }
      folderPath = selected;
    }
    try {
      let file: WorkspaceFile | null = workspaceCache.get(folderPath) || null;
      if (!file) {
        const exists = await workspaceExists(folderPath);
        if (!exists) {
          const name = folderNameFromPath(folderPath);
          const style = captureStyle();
          file = { version: 1, name, lastOpened: Date.now(), canvas: { elements: [], strokeColor: '#ff781f', strokeWidth: 2, fillEnabled: false, fillOpacity: 20, fontSize: 14 }, agents: { agents: [], viewportPan: { x: 0, y: 0 }, viewportZoom: 1 }, style, layout: { presets: [], activePresetId: null } };
          await writeWorkspaceFile(folderPath, file);
        } else {
          const raw = await readWorkspaceFile(folderPath);
          file = raw ? (raw as unknown as WorkspaceFile) : null;
          if (!file) {
            file = { version: 1, name: folderNameFromPath(folderPath), lastOpened: Date.now(), canvas: { elements: [], strokeColor: '#ff781f', strokeWidth: 2, fillEnabled: false, fillOpacity: 20, fontSize: 14 }, agents: { agents: [], viewportPan: { x: 0, y: 0 }, viewportZoom: 1 }, style: captureStyle(), layout: { presets: [], activePresetId: null } };
          }
        }
        cacheSet(folderPath, file);
      }
      useCanvasStore.getState().hydrateFromWorkspace(file.canvas || {});
      useAppStore.getState().hydrateFromWorkspace(file.agents || {});
      const spring = LAYOUT_ENGINE_SPEC.animation.spring;
      const dur = LAYOUT_ENGINE_SPEC.animation.duration;
      usePanelRegistry.getState().setLayoutMotion({
        mode: 'spring',
        transition: `left ${dur}ms ${spring}, top ${dur}ms ${spring}, width ${dur}ms ${spring}, height ${dur}ms ${spring}`,
      });
      queueMicrotask(() => {
        const agents = useAppStore.getState().agents;
        if (agents.length > 0) useWorkspaceStore.getState().autoArrange();
        setTimeout(() => usePanelRegistry.getState().setLayoutMotion({ mode: 'none', transition: '' }), dur + 100);
      });
      set({ layoutPresets: file.layout?.presets || [], activeLayoutPresetId: file.layout?.activePresetId || null });
      applyStyle(file.style);
      const name = file?.name || folderNameFromPath(folderPath);
      const now = Date.now();
      file.lastOpened = now;
      cacheSet(folderPath, file);
      const updated = updateRecentList(get().recentWorkspaces, folderPath, name, now);
      await saveRecentWorkspaces(updated);
      set({ recentWorkspaces: updated, currentWorkspacePath: folderPath, currentWorkspaceName: name, isDirty: false, isBusy: false });
    } catch (err: any) {
      set({ isBusy: false, error: err?.message || 'Failed to open workspace' });
    }
  },

  saveWorkspace: async () => {
    const { currentWorkspacePath } = get();
    if (!currentWorkspacePath) return;
    try {
      const canvasData = useCanvasStore.getState().toWorkspaceData();
      const appData = useAppStore.getState().toWorkspaceData();
      const style = captureStyle();
      const { layoutPresets, activeLayoutPresetId } = get();
      const name = folderNameFromPath(currentWorkspacePath);
      const data: WorkspaceFile = {
        version: 1, name, lastOpened: Date.now(),
        canvas: canvasData, agents: appData, style,
        layout: { presets: layoutPresets, activePresetId: activeLayoutPresetId },
      };
      await writeWorkspaceFile(currentWorkspacePath, data);
      cacheSet(currentWorkspacePath, data);
      set({ isDirty: false });
      const authStatus = useAuthStore.getState().status;
      if (authStatus === 'authenticated') {
        const { cloudWorkspaceId, cloudRowVersion } = get();
        upsertWorkspace({
          id: cloudWorkspaceId || undefined, name,
          canvas_data: data, style: style as any,
          last_opened: new Date().toISOString(),
        })
          .then((result) => {
            const patch: Record<string, any> = { cloudRowVersion: result.version };
            if (!get().cloudWorkspaceId) patch.cloudWorkspaceId = result.id;
            set(patch as any);
            upsertDevicePath(result.id, currentWorkspacePath).catch(() => {});
          }).catch((err) => console.warn('[Cloud] Sync failed:', err));
      }
    } catch (err: any) {
      console.error('[Workspace] Save failed:', err);
      set({ error: err?.message || 'Failed to save workspace' });
    }
  },

  switchWorkspace: async (path: string) => {
    if (get().currentWorkspacePath === path) return;
    await get().closeWorkspace();
    await get().openWorkspace(path);
  },

  closeWorkspace: async () => {
    const { currentWorkspacePath } = get();
    if (!currentWorkspacePath) return;
    if (get().isDirty) await get().saveWorkspace();
    useCanvasStore.getState().resetCanvas();
    useAppStore.getState().resetAppState();
    set({ currentWorkspacePath: null, currentWorkspaceName: null, isDirty: false, layoutPresets: [], activeLayoutPresetId: null });
  },

  markDirty: () => { if (get().currentWorkspacePath) set({ isDirty: true }); },
  markClean: () => set({ isDirty: false }),
  clearError: () => set({ error: null }),

  // ── Layout Engine Actions ───────────────────────────────────

  // ── Arrange ────────────────────────────────────────────────
  // One implementation for every mode. Previously autoArrange /
  // arrangeTidy / arrangeGrid / arrangeStage were four near-identical
  // copies that differed only in the label they committed — and
  // arrangeGrid simply called arrangeTidy, so "tidy" and "grid" were
  // literally the same layout.
  arrange: (mode: LayoutMode = 'grid', options: ArrangeOptions = {}) => {
    if (!options.preserveLocks) clearAllLocks();

    const nodes = collectLayoutNodes();
    if (nodes.length === 0) return;

    const app = useAppStore.getState();
    const { viewportWinSize } = app;
    const browser = useBrowserStore.getState();

    // The browser panel dominates the canvas when open, so stage mode is
    // the right default whenever it is visible and the caller didn't ask
    // for something specific.
    const effective: LayoutModeName =
      mode === 'stage' && !browser.visible ? 'grid'
      : isLayoutMode(mode) ? mode
      : 'grid';

    const region = toEngineRegion(
      computeSafeRegion(
        viewportWinSize.w,
        viewportWinSize.h,
        LAYOUT_ENGINE_SPEC.arrangements.gridSnap,
        measureChromeInsets(),
      ),
    );

    const gen = ++layoutGeneration;

    const placements = runLayout(nodes, region, effective, {
      gap: LAYOUT_ENGINE_SPEC.arrangements.tidyPadding,
      grid: 8,
      focusId: options.focusId ?? app.selectedAgentId,
      links: app.delegationLinks
        .filter((l) => l.fromAgentId && l.toAgentId)
        .map((l) => ({ from: l.fromAgentId, to: l.toAgentId })),
    });

    if (layoutGeneration !== gen) return; // stale — a newer arrange won

    const positions = placements.map((p) => ({ id: p.id, x: p.x, y: p.y }));
    const sizes = placements.map((p) => ({ id: p.id, width: p.width, height: p.height }));

    // Framing is opt-out: an arrange triggered by a resize or a spawn
    // shouldn't yank the camera out from under the user.
    let pan = app.viewportPan;
    let zoom = app.viewportZoom;
    if (options.frame !== false) {
      const framed = frameViewport(
        boundingBox(placements),
        viewportWinSize.w,
        viewportWinSize.h,
        LAYOUT_ENGINE_SPEC.framer,
      );
      pan = framed.pan;
      zoom = framed.zoom;
    }

    commitLayoutResult(positions, sizes, pan, zoom, effective);
  },

  // ── Compatibility wrappers ─────────────────────────────────
  autoArrange:  () => { useWorkspaceStore.getState().arrange('grid'); },
  arrangeTidy:  () => { useWorkspaceStore.getState().arrange('grid'); },
  arrangeGrid:  () => { useWorkspaceStore.getState().arrange('grid'); },
  arrangeStage: () => { useWorkspaceStore.getState().arrange('stage'); },
  arrangeFocus: (focusId?: string) => { useWorkspaceStore.getState().arrange('focus', { focusId }); },

  setLayoutMode: (mode) => {
    if (!mode) {
      set({ layoutMode: null, layoutPhase: 'idle', layoutTransition: '' });
      return;
    }
    get().arrange(mode);
  },

  notifyAgentChanged: () => {
    // An agent appeared or disappeared. Re-run the active mode, but leave
    // the camera alone: re-framing on every spawn made the whole canvas
    // lurch each time an agent started.
    const { layoutMode } = get();
    if (!layoutMode) return;
    get().arrange(layoutMode, { frame: false });
  },

  toggleSetting: (key) => {
    set((state) => ({ settings: { ...state.settings, [key]: !state.settings[key] } }));
  },

  spawnPosition: (agentId?: string) => {
    const store = useAppStore.getState();
    const registry = usePanelRegistry.getState();

    const grid = LAYOUT_ENGINE_SPEC.arrangements.gridSnap;
    const pad = LAYOUT_ENGINE_SPEC.arrangements.tidyPadding;
    const defW = LAYOUT_ENGINE_SPEC.defaultAgentWidth;
    const defH = LAYOUT_ENGINE_SPEC.defaultAgentHeight;
    const cellW = defW + pad;
    const cellH = defH + pad;

    // Collect obstacles from ALL visible panels (including mid-drag, locked, etc.)
    const regPanels = registry.panels;
    const existing: Array<{ x: number; y: number; w: number; h: number }> = [];
    for (const id of Object.keys(regPanels)) {
      if (id === agentId) continue;
      const p = regPanels[id];
      if (p.minimized) continue;
      existing.push({ x: p.x, y: p.y, w: p.width, h: p.height });
    }

    const { viewportPan, viewportZoom, viewportWinSize } = store;

    // Compute viewport center in canvas-space (accounts for pan + zoom)
    const vpLeft = -viewportPan.x / viewportZoom;
    const vpTop = -viewportPan.y / viewportZoom;
    const cx = vpLeft + (viewportWinSize.w / viewportZoom) / 2;
    const cy = vpTop + (viewportWinSize.h / viewportZoom) / 2;

    // Delegate to the engine's single source of truth
    const region = computeSafeRegion(viewportWinSize.w, viewportWinSize.h, grid);
    const result = findSpawnSlot(existing, region, grid, { w: cellW, h: cellH }, { x: cx, y: cy });
    return { x: result.x, y: result.y };
  },

  commitLayout: (positions, sizes, pan, zoom, transitionStr, layoutMode) => {
    const { w, h } = useAppStore.getState().viewportWinSize;

    set({ layoutMode, layoutPhase: 'arranging', layoutTransition: transitionStr });
    usePanelRegistry.getState().setLayoutMotion({ mode: 'spring', transition: transitionStr });

    // ── Registry is the canonical geometry source of truth ─────
    // Write every position + size back to the registry in ONE batch.
    // Each component already syncs registry → its own store (browser/music/
    // forge/feedback) via its own effect; agents are synced below. This makes
    // the commit path type-agnostic — new node types need no special handling.
    const sizeById = new Map(sizes.map((s) => [s.id, s]));
    const registry = usePanelRegistry.getState();
    const updates: Array<{ id: string; patch: Partial<import('../types/panel').PanelNode> }> = [];
    for (const pos of positions) {
      const size = sizeById.get(pos.id);
      updates.push({
        id: pos.id,
        patch: {
          x: pos.x,
          y: pos.y,
          ...(size ? { width: size.width, height: size.height } : {}),
        },
      });
    }
    if (updates.length > 0) registry.batchUpdatePanels(updates);

    // ── Sync agent results back into useAppStore ───────────────
    // (agents read their own geometry from appStore for persistence/IPC).
    const registryPanels = usePanelRegistry.getState().panels;
    const agentPositions: Array<{ id: string; x: number; y: number }> = [];
    const agentSizes: Array<{ id: string; width: number; height: number }> = [];
    for (const pos of positions) {
      const node = registryPanels[pos.id];
      if (!node || node.type !== 'agent') continue;
      agentPositions.push({ id: pos.id, x: pos.x, y: pos.y });
      const size = sizeById.get(pos.id);
      if (size) agentSizes.push(size);
    }
    const appStore = useAppStore.getState();
    if (agentPositions.length > 0) appStore.updateAgentPositions(agentPositions);
    for (const s of agentSizes) appStore.updateAgentSize(s.id, s.width, s.height);

    commitViewportFrame(pan, zoom, w, h);

    requestAnimationFrame(() => {
      setTimeout(() => {
        set({ layoutPhase: 'settled' });
        usePanelRegistry.getState().setLayoutMotion({ mode: 'none', transition: '' });
      }, LAYOUT_ENGINE_SPEC.animation.duration + 50);
    });
  },

  saveLayoutPreset: (label) => {
    const trimmed = label.trim();
    if (!trimmed) return;
    const snapshot = usePanelRegistry.getState().captureSnapshot(trimmed);
    const preset: LayoutPreset = { ...snapshot, kind: 'manual' };
    set((state) => ({ layoutPresets: [...state.layoutPresets, preset], activeLayoutPresetId: preset.id, isDirty: true }));
  },

  restoreLayoutPreset: (id) => {
    const preset = get().layoutPresets.find((p) => p.id === id);
    if (!preset) return;
    usePanelRegistry.getState().restoreSnapshot(preset);
    set({ activeLayoutPresetId: id });
  },

  deleteLayoutPreset: (id) => {
    set((state) => ({
      layoutPresets: state.layoutPresets.filter((p) => p.id !== id),
      activeLayoutPresetId: state.activeLayoutPresetId === id ? null : state.activeLayoutPresetId,
      isDirty: true,
    }));
  },
  };
});

// ── Helpers ──────────────────────────────────────────────────

function commitLayoutResult(
  positions: Array<{ id: string; x: number; y: number }>,
  sizes: Array<{ id: string; width: number; height: number }>,
  pan: { x: number; y: number },
  zoom: number,
  layoutMode: LayoutMode | null,
) {
  const spring = LAYOUT_ENGINE_SPEC.animation.spring;
  const dur = LAYOUT_ENGINE_SPEC.animation.duration;
  const transitionStr = `left ${dur}ms ${spring}, top ${dur}ms ${spring}, width ${dur}ms ${spring}, height ${dur}ms ${spring}`;
  useWorkspaceStore.getState().commitLayout(positions, sizes, pan, zoom, transitionStr, layoutMode);
}

function updateRecentList(
  list: WorkspaceMeta[], path: string, name: string, lastOpened: number,
): WorkspaceMeta[] {
  const filtered = list.filter((w) => w.path !== path);
  return [{ path, name, lastOpened }, ...filtered].slice(0, 20);
}
