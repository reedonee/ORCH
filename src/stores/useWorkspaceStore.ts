// ── ORCH Workspace Store ───────────────────────────────────────
// Manages the folder-centric workspace model.
// Each workspace = a user-chosen directory containing .orch-workspace.json
// This store orchestrates: folder selection → file I/O → hydrate other stores
//
// Features:
//   • In-memory LRU cache for instant workspace switching
//   • Per-workspace canvas style persistence (theme, grid, snap)
//   • Auto-opens last-used workspace on app boot
//   • Intelligent layout engine — tidy, grid, cinematic stage, and
//     smart auto-flow with viewport framing + debounced recalculation

import { create } from 'zustand';
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
import { upsertWorkspace, upsertDevicePath } from '../lib/db';
import type { Agent } from './useAppStore';
import type { WorkspaceMeta, WorkspaceFile, WorkspaceStyleData } from '../types/workspace';

// ── Layout Engine Specification ─────────────────────────────────
// All magic numbers and tuning knobs in one place. Tweak here,
// watch the whole canvas respond.
export const LAYOUT_ENGINE_SPEC = {
  arrangements: {
    /** Minimum gap (px) between panels after collision separation — matches 1 gridSnap unit */
    tidyPadding: 32,
    /** Base snap unit (px) – every position aligns to this grid */
    gridSnap: 32,
    /** Left margin for chat box / left panel (px) */
    startX: 80,
    /** Fraction of viewport width the primary stage panel occupies */
    stageWidthRatio: 0.65,
    /** Width (px) of the compact secondary column in stage mode */
    stageColumnWidth: 280,
    /** Vertical gap (px) between stacked secondary panels */
    stageGap: 12,
    /** Maximum side-column width as fraction of viewport */
    stageMaxSideRatio: 0.30,
    /** Fraction of viewport height the stage panel should fill */
    stageHeightRatio: 0.75,
    /** Scale cap for secondary panels in stage mode */
    secondaryScaleMax: 0.45,
  },
  animation: {
    /** Master layout transition duration (ms) */
    duration: 450,
    /** Staggered cascade delay (ms) between each panel */
    staggerDelay: 60,
    /** Premium spring for organic layout slides */
    spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
    /** Deceleration curve for settling after collision separation */
    decelerate: 'cubic-bezier(0.16, 1, 0.3, 1)',
  },
  /** Debounce window (ms) for agent lifecycle auto-arrange */
  autoArrangeDebounceMs: 200,
  /** Framer viewport guardrails */
  framer: {
    /** Maximum zoom (never zoom in past 1:1) */
    maxZoom: 1.0,
    /** Minimum zoom (never shrink agents into unreadability) */
    minZoom: 0.35,
    /** Padding (px) around the content bounding box when framing */
    padding: 60,
  },
  /** Chrome (UI overlays) that reduce the visible canvas area */
  chrome: {
    /** Height of the fixed pillbar overlay at the top of the window (px) */
    topOffset: 56,
  },
  /** Adaptive card sizing when agents overflow the viewport */
  sizing: {
    /** Smallest agent width we'll shrink to (px) */
    minAgentWidth: 320,
    /** Smallest agent height we'll shrink to (px) */
    minAgentHeight: 200,
    /** Largest agent width we'll expand to (px) */
    maxAgentWidth: 600,
    /** Largest agent height we'll expand to (px) */
    maxAgentHeight: 420,
    /** Maximum rows of agents we aim to fit without scrolling */
    targetMaxVisibleRows: 3,
  },
  /** Fallback panel dimensions when agent has no explicit width/height */
  defaultAgentWidth: 520,
  defaultAgentHeight: 360,
} as const;

export type LayoutMode = 'tidy' | 'grid' | 'stage';

/** Canvas window management settings for auto-tidy behaviour */
export interface CanvasWindowSettings {
  /** Allow agents to control/manipulate the canvas (future) */
  allowAgentCanvasControl: boolean;
  /** Auto-run tidy layout when a new terminal window opens */
  tidyOnWindowOpen: boolean;
  /** Auto-run tidy layout when a terminal window closes */
  tidyOnWindowClose: boolean;
}

// ── Internal rect type for collision math ────────────────────────
interface PanelRect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

// ── In-memory workspace cache (up to 10 entries) ───────────────
const workspaceCache = new Map<string, WorkspaceFile>();
const MAX_CACHE = 10;

function cacheSet(path: string, data: WorkspaceFile) {
  if (workspaceCache.size >= MAX_CACHE) {
    // Evict oldest (by lastOpened)
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
  // Only apply grid settings if they exist in the style block
  if (showGrid !== undefined) useSettingsStore.getState().setShowGrid(showGrid);
  if (gridSnap !== undefined) useSettingsStore.getState().setGridSnap(gridSnap);
}

// ═════════════════════════════════════════════════════════════════
// LAYOUT MATH HELPERS
// ═════════════════════════════════════════════════════════════════

/** Extract a PanelRect from an agent, falling back to default sizes */
function getPanelRect(agent: Agent): PanelRect {
  return {
    id: agent.id,
    x: agent.x,
    y: agent.y,
    w: agent.width ?? LAYOUT_ENGINE_SPEC.defaultAgentWidth,
    h: agent.height ?? LAYOUT_ENGINE_SPEC.defaultAgentHeight,
  };
}

/** AABB overlap test with padding */
function rectsOverlap(a: PanelRect, b: PanelRect, padding: number): boolean {
  return !(
    a.x + a.w + padding <= b.x ||
    b.x + b.w + padding <= a.x ||
    a.y + a.h + padding <= b.y ||
    b.y + b.h + padding <= a.y
  );
}

/**
 * Compute the minimal separation vector to push two overlapping rects apart.
 * Returns `null` if no overlap exists.
 * Pushes along the axis with the least overlap for a natural separation feel.
 */
function separationVector(
  a: PanelRect,
  b: PanelRect,
  padding: number,
): { dx: number; dy: number } | null {
  if (!rectsOverlap(a, b, padding)) return null;

  // Overlap on each axis (including padding)
  const overlapX = Math.min(
    a.x + a.w + padding - b.x,
    b.x + b.w + padding - a.x,
  );
  const overlapY = Math.min(
    a.y + a.h + padding - b.y,
    b.y + b.h + padding - a.y,
  );

  // Resolve along the axis with the least geometric overlap
  if (overlapX < overlapY) {
    const sign = a.x < b.x ? 1 : -1;
    return { dx: (overlapX / 2) * sign, dy: 0 };
  }
  const sign = a.y < b.y ? 1 : -1;
  return { dx: 0, dy: (overlapY / 2) * sign };
}

/** Snap a value to the nearest grid increment */
function snapToGrid(val: number, grid: number): number {
  return Math.round(val / grid) * grid;
}

/** Read the current viewport center in canvas coordinates (at zoom=1) */
function getViewportCenter(): { cx: number; cy: number; vw: number; vh: number } {
  const { viewportPan, viewportWinSize } = useAppStore.getState();
  return {
    cx: -viewportPan.x + viewportWinSize.w / 2,
    cy: -viewportPan.y + viewportWinSize.h / 2,
    vw: viewportWinSize.w,
    vh: viewportWinSize.h,
  };
}

/** Derive the theme-aware CSS transition string for agent panels */
function resolveLayoutTransition(): string {
  const { animation } = useThemeStore.getState().theme;
  const easing = animation.spring ?? LAYOUT_ENGINE_SPEC.animation.spring;
  const dur = LAYOUT_ENGINE_SPEC.animation.duration;
  return `left ${dur}ms ${easing}, top ${dur}ms ${easing}, width ${dur}ms ${easing}, height ${dur}ms ${easing}`;
}

/**
 * Derive the CSS transition string for the canvas container (pan/zoom).
 * Uses the same theme easing as panel transitions for a cohesive feel.
 */
function resolveCanvasTransition(): string {
  const { animation } = useThemeStore.getState().theme;
  const easing = animation.spring ?? LAYOUT_ENGINE_SPEC.animation.spring;
  const dur = LAYOUT_ENGINE_SPEC.animation.duration;
  return `transform ${dur}ms ${easing}`;
}

// ═════════════════════════════════════════════════════════════════
// ADAPTIVE CELL SIZING
// ═════════════════════════════════════════════════════════════════

/**
 * Compute the optimal agent card size based on agent count and viewport.
 *
 * Column count follows explicit rules per agent count:
 *   1 agent  → 1 column, centered, fills available space up to caps
 *   2 agents → 1 column, stacked vertically, same width
 *   3 agents → 2 columns (2×2 grid, 1 empty cell)
 *   4 agents → 2 columns (2×2 grid)
 *   5+ agents → 3 columns
 *
 * Every agent count flows through the same growth path (no special exceptions)
 * so sizing is always proportional to the viewport and never cramped.
 */
interface CellSize {
  cellW: number;
  cellH: number;
  agentW: number;
  agentH: number;
  /** Optimal column count for a square-ish layout */
  cols: number;
}

function computeAdaptiveCellSize(
  count: number,
  viewportW: number,
  viewportH: number,
  chromeTop: number = 0,
): CellSize {
  const pad = LAYOUT_ENGINE_SPEC.arrangements.tidyPadding;
  const defW = LAYOUT_ENGINE_SPEC.defaultAgentWidth;
  const defH = LAYOUT_ENGINE_SPEC.defaultAgentHeight;
  const { minAgentWidth, minAgentHeight, maxAgentWidth, maxAgentHeight, targetMaxVisibleRows } = LAYOUT_ENGINE_SPEC.sizing;
  const grid = LAYOUT_ENGINE_SPEC.arrangements.gridSnap;

  // Effective viewport height — subtract chrome overlay (pillbar) so cells
  // are sized for the actual visible area, not the full window.
  const effectiveH = viewportH - chromeTop;

  // Ideal cell at default size
  const idealCellW = defW + pad;
  const idealCellH = defH + pad;

  // Maximum columns that fit at ideal size
  const maxCols = Math.max(1, Math.floor((viewportW - pad) / idealCellW));

  // Target max rows — uses effective viewport height
  const maxRows = Math.max(1, Math.min(targetMaxVisibleRows, Math.floor((effectiveH - pad) / idealCellH)));

  // Determine column count based on agent count
  let optimalCols: number;
  if (count <= 2) {
    optimalCols = 1;          // 1 agent: centered; 2 agents: stacked vertically
  } else if (count <= 4) {
    optimalCols = 2;          // 3-4 agents: 2 columns (2×2 grid)
  } else {
    optimalCols = 3;          // 5+ agents: 3 columns
  }
  const idealRows = Math.ceil(count / optimalCols);

  if (idealRows <= maxRows && count >= 1) {
    // We fit within the target rows with room to spare — grow agents
    // to fill the available space up to the configured maximum.
    // For single agents, use the same growth path so it centers and
    // fills nicely instead of staying at the small default size.
    const colsUsed = Math.min(optimalCols, count);
    const availableW = viewportW - pad;
    const availableH = effectiveH - pad;

    // How wide/tall each agent could be if it claimed all free space
    const growW = (availableW / colsUsed) - pad;
    const growH = (availableH / idealRows) - pad;

    // Clamp to [max of default, max configured]
    const agentW = Math.round(Math.min(maxAgentWidth, Math.max(defW, growW)));
    const agentH = Math.round(Math.min(maxAgentHeight, Math.max(defH, growH)));

    // Preserve aspect ratio (520:360 ≈ 1.44:1) — whichever dimension
    // is more constrained determines the final pair.
    const aspect = defW / defH;
    let finalW = agentW;
    let finalH = Math.round(agentW / aspect);
    if (finalH > agentH) {
      finalH = agentH;
      finalW = Math.round(agentH * aspect);
    }

    return {
      cellW: finalW + pad,
      cellH: finalH + pad,
      agentW: snapToGrid(finalW, grid),
      agentH: snapToGrid(finalH, grid),
      cols: optimalCols,
    };
  }

  // Fallback (overflow or edge cases) — shrink to fit using default proportions
  if (count <= 1) {
    return { cellW: idealCellW, cellH: idealCellH, agentW: defW, agentH: defH, cols: 1 };
  }

  // Agents overflow the target rows — shrink proportionally
  const neededCols = Math.ceil(count / maxRows);
  const availableW = viewportW - pad;
  const cellW = Math.max(minAgentWidth + pad, availableW / neededCols);
  const scale = (cellW - pad) / defW;
  const cellH = Math.max(minAgentHeight + pad, (defH + pad) * scale);

  return {
    cellW,
    cellH,
    agentW: snapToGrid(Math.round(cellW - pad), grid),
    agentH: snapToGrid(Math.round(cellH - pad), grid),
    cols: neededCols,
  };
}

// ═════════════════════════════════════════════════════════════════
// LAYER 1 — SMART SPAWN SLOT
// ═════════════════════════════════════════════════════════════════

/**
 * Find the nearest empty grid slot radiating outward from the current
 * viewport center. Used when auto-arrange is disabled and a new agent
 * needs a sensible home.
 *
 * Scans in expanding squares (perimeter of each radius around the
 * base cell under the viewport center). Falls back to center if
 * every cell within 20 rings is occupied.
 */
function findSpawnSlot(
  agents: Agent[],
  viewCenter: { cx: number; cy: number },
): { x: number; y: number } {
  const grid = LAYOUT_ENGINE_SPEC.arrangements.gridSnap;
  const pad = LAYOUT_ENGINE_SPEC.arrangements.tidyPadding;
  const defW = LAYOUT_ENGINE_SPEC.defaultAgentWidth;
  const defH = LAYOUT_ENGINE_SPEC.defaultAgentHeight;
  const cellW = defW + pad;
  const cellH = defH + pad;

  // Build existing rects for overlap checking
  const existing = agents.map((a) => ({
    x: a.x, y: a.y,
    w: a.width ?? defW, h: a.height ?? defH,
  }));

  const overlapsAny = (cx: number, cy: number): boolean =>
    existing.some(
      (e) =>
        cx < e.x + e.w + pad &&
        cx + cellW + pad > e.x &&
        cy < e.y + e.h + pad &&
        cy + cellH + pad > e.y,
    );

  // Base cell the viewport center falls into
  const baseCol = Math.floor(viewCenter.cx / cellW);
  const baseRow = Math.floor(viewCenter.cy / cellH);

  // Scan outward in expanding square perimeters
  for (let radius = 0; radius <= 20; radius++) {
    for (let row = baseRow - radius; row <= baseRow + radius; row++) {
      for (let col = baseCol - radius; col <= baseCol + radius; col++) {
        // Skip interior cells — only check the perimeter of this radius
        if (
          radius > 0 &&
          Math.abs(col - baseCol) < radius &&
          Math.abs(row - baseRow) < radius
        ) continue;

        const cx = col * cellW;
        const cy = row * cellH;
        if (!overlapsAny(cx, cy)) {
          return { x: snapToGrid(cx, grid), y: snapToGrid(cy, grid) };
        }
      }
    }
  }

  // Fallback — dead centre
  return {
    x: snapToGrid(viewCenter.cx - defW / 2, grid),
    y: snapToGrid(viewCenter.cy - defH / 2, grid),
  };
}

// ═════════════════════════════════════════════════════════════════
// LAYER 4a — FLOW LAYOUT  (deterministic left-to-right wrap)
// ═════════════════════════════════════════════════════════════════

/**
 * Arranges all agents into a clean left-to-right, top-to-bottom flow
 * matching the 32px snap grid. Column count adapts to viewport width.
 * If every agent is still at the origin (never manually moved), sorts
 * by stable id to prevent jitter on rapid additions.
 */
function computeFlowLayout(
  agents: Agent[],
  viewportW: number,
  viewportH: number,
): Array<{ id: string; x: number; y: number; width: number; height: number }> {
  if (agents.length === 0) return [];

  const grid = LAYOUT_ENGINE_SPEC.arrangements.gridSnap;
  const pad = LAYOUT_ENGINE_SPEC.arrangements.tidyPadding;

  // Adaptive cell sizing based on agent count and viewport
  const chromeTop = LAYOUT_ENGINE_SPEC.chrome.topOffset;
  const { cellW, cellH, agentW, agentH, cols: optimalCols } = computeAdaptiveCellSize(agents.length, viewportW, viewportH, chromeTop);

  // Use the optimal column count from adaptive sizing; clamp to what physically fits
  const cols = Math.min(optimalCols, Math.max(1, Math.floor((viewportW - pad) / cellW)));

  // Preserve current spatial ordering for stability
  const sorted = [...agents].sort((a, b) => {
    const aRow = Math.floor(
      (a.y + (a.height ?? LAYOUT_ENGINE_SPEC.defaultAgentHeight) / 2) / cellH,
    );
    const bRow = Math.floor(
      (b.y + (b.height ?? LAYOUT_ENGINE_SPEC.defaultAgentHeight) / 2) / cellH,
    );
    if (aRow !== bRow) return aRow - bRow;
    return a.x - b.x;
  });

  // If everyone is at origin (fresh spawn), use stable id sort
  const allAtOrigin = sorted.every(
    (a) => Math.abs(a.x) < grid && Math.abs(a.y) < grid,
  );
  const ordered = allAtOrigin
    ? [...agents].sort((a, b) => a.id.localeCompare(b.id))
    : sorted;

  // Starting position with margins for left panel (80px) and top bar (chromeTop)
  const startX = LAYOUT_ENGINE_SPEC.arrangements.startX;
  const startY = chromeTop + pad;

  // Calculate total grid width for centering when cols < available
  const totalGridW = cols * cellW - pad;
  const availableW = viewportW - startX;
  const gridOffsetX = totalGridW < availableW
    ? startX + Math.round((availableW - totalGridW) / 2)
    : startX;

  const result: Array<{ id: string; x: number; y: number; width: number; height: number }> = [];
  for (let i = 0; i < ordered.length; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    result.push({
      id: ordered[i].id,
      x: snapToGrid(gridOffsetX + col * cellW, grid),
      y: snapToGrid(startY + row * cellH, grid),
      width: agentW,
      height: agentH,
    });
  }
  return result;
}

// ═════════════════════════════════════════════════════════════════
// LAYER 4b — MICRO-TIDY  (single-pass damped collision polish)
// ═════════════════════════════════════════════════════════════════

/**
 * A single damped pass of collision separation to polish a flow or
 * grid layout. Uses 0.5 damping to prevent oscillation — each pair
 * only moves halfway to resolution per pass. Agents starting at the
 * same origin from flow layout will have zero overlap so this pass
 * is purely cosmetic for most cases.
 */
function computeMicroTidy(
  positions: Array<{ id: string; x: number; y: number }>,
  agents: Agent[],
): Array<{ id: string; x: number; y: number }> {
  if (positions.length < 2) return positions;

  const pad = LAYOUT_ENGINE_SPEC.arrangements.tidyPadding;
  const grid = LAYOUT_ENGINE_SPEC.arrangements.gridSnap;
  const damp = 0.5;
  const agentMap = new Map(agents.map((a) => [a.id, a]));

  const panels = positions.map((p) => {
    const agent = agentMap.get(p.id);
    return {
      id: p.id,
      x: p.x,
      y: p.y,
      w: agent?.width ?? LAYOUT_ENGINE_SPEC.defaultAgentWidth,
      h: agent?.height ?? LAYOUT_ENGINE_SPEC.defaultAgentHeight,
    };
  });

  for (let i = 0; i < panels.length; i++) {
    for (let j = i + 1; j < panels.length; j++) {
      const vec = separationVector(panels[i], panels[j], pad);
      if (!vec) continue;
      panels[i].x += vec.dx * damp;
      panels[i].y += vec.dy * damp;
      panels[j].x -= vec.dx * damp;
      panels[j].y -= vec.dy * damp;
    }
  }

  return panels.map((p) => ({
    id: p.id,
    x: snapToGrid(p.x, grid),
    y: snapToGrid(p.y, grid),
  }));
}

// ═════════════════════════════════════════════════════════════════
// LAYER 2 — VIEWPORT FRAMER
// ═════════════════════════════════════════════════════════════════

/**
 * Compute the optimal pan + zoom to frame all agents within the
 * viewport. Clamped to [0.35, 1.0] — never zoom in past 1:1 and
 * never zoom out so far that agents become unreadable micro-dots.
 */
function computeFrameViewport(
  agents: Agent[],
  viewportW: number,
  viewportH: number,
  chromeTop: number = 0,
): { pan: { x: number; y: number }; zoom: number } {
  if (agents.length === 0) {
    return { pan: { x: 0, y: 0 }, zoom: 1 };
  }

  const defW = LAYOUT_ENGINE_SPEC.defaultAgentWidth;
  const defH = LAYOUT_ENGINE_SPEC.defaultAgentHeight;
  const { padding, minZoom, maxZoom } = LAYOUT_ENGINE_SPEC.framer;

  // ── Bounding box of all agents ─────────────────────────────
  let minX = Infinity, minY = Infinity;
  let maxX = -Infinity, maxY = -Infinity;

  for (const a of agents) {
    const aw = a.width ?? defW;
    const ah = a.height ?? defH;
    if (a.x < minX) minX = a.x;
    if (a.y < minY) minY = a.y;
    if (a.x + aw > maxX) maxX = a.x + aw;
    if (a.y + ah > maxY) maxY = a.y + ah;
  }

  const contentW = maxX - minX + padding * 2;
  const contentH = maxY - minY + padding * 2;

  // ── Zoom to fit with guardrails ────────────────────────────
  let zoom = Math.min(viewportW / contentW, viewportH / contentH);
  zoom = Math.max(minZoom, Math.min(maxZoom, zoom));

  // ── Center bounding box in the visible area of the viewport ────
  // The visible area starts below the chrome overlay, so we shift
  // the framing center down by chromeTop/2.
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const visibleCenterY = (viewportH + chromeTop) / 2;

  return {
    pan: {
      x: viewportW / 2 - centerX * zoom,
      y: visibleCenterY - centerY * zoom,
    },
    zoom,
  };
}

// ═════════════════════════════════════════════════════════════════
// LAYER 4c — FULL AUTO-ARRANGE PIPELINE  (all-in-memory)
// ═════════════════════════════════════════════════════════════════

/**
 * The complete automatic arrangement pipeline:
 *   1. Flow layout → deterministic grid positions
 *   2. Micro-tidy  → damped collision polish
 *   3. Frame       → optimal zoom + pan to fit everything
 *
 * Every calculation happens in-memory before any state is committed.
 * The consumer commits positions + viewport in one go, letting CSS
 * transitions slide all cards to their final spots synchronously.
 */
function computeAutoArrange(
  agents: Agent[],
  viewportW: number,
  viewportH: number,
): {
  positions: Array<{ id: string; x: number; y: number }>;
  sizes: Array<{ id: string; width: number; height: number }>;
  pan: { x: number; y: number };
  zoom: number;
} {
  if (agents.length === 0) {
    return { positions: [], sizes: [], pan: { x: 0, y: 0 }, zoom: 1 };
  }

  // Step 1 — Flow layout with adaptive sizing (in-memory, no side-effects)
  const flowResult = computeFlowLayout(agents, viewportW, viewportH);

  // Build agent snapshots with the new sizes so micro-tidy and framing use them
  const sizeMap = new Map(flowResult.map((r) => [r.id, { width: r.width, height: r.height }]));
  const sizedAgents = agents.map((a) => {
    const s = sizeMap.get(a.id);
    return s ? { ...a, width: s.width, height: s.height } : a;
  });

  // Step 2 — Micro-tidy polish using the new sizes (in-memory)
  const positions = computeMicroTidy(
    flowResult.map((r) => ({ id: r.id, x: r.x, y: r.y })),
    sizedAgents,
  );

  // Step 3 — Build framed agents for bounding box calc
  const posMap = new Map(positions.map((p) => [p.id, p]));
  const framedAgents = sizedAgents.map((a) => {
    const pos = posMap.get(a.id);
    return pos ? { ...a, x: pos.x, y: pos.y } : a;
  });

  const { pan, zoom } = computeFrameViewport(framedAgents, viewportW, viewportH);

  return {
    positions,
    sizes: flowResult.map((r) => ({ id: r.id, width: r.width, height: r.height })),
    pan,
    zoom,
  };
}

// ═════════════════════════════════════════════════════════════════
// GRID LAYOUT  (user-commanded matrix)
// ═════════════════════════════════════════════════════════════════

/**
 * User-commanded matrix grid. Preserved for explicit setLayoutMode('grid').
 * Uses the same column-count logic as the auto flow.
 */
function computeGridLayout(
  agents: Agent[],
  viewportW: number,
  viewportH: number,
): Array<{ id: string; x: number; y: number; width: number; height: number }> {
  if (agents.length === 0) return [];

  const grid = LAYOUT_ENGINE_SPEC.arrangements.gridSnap;
  const pad = LAYOUT_ENGINE_SPEC.arrangements.tidyPadding;

  // Adaptive cell sizing
  const chromeTop = LAYOUT_ENGINE_SPEC.chrome.topOffset;
  const { cellW, cellH, agentW, agentH, cols: optimalCols } = computeAdaptiveCellSize(agents.length, viewportW, viewportH, chromeTop);

  const cols = Math.min(optimalCols, Math.max(2, Math.floor((viewportW - pad) / cellW)));

  const sorted = [...agents].sort((a, b) => {
    const aCenterY = a.y + (a.height ?? LAYOUT_ENGINE_SPEC.defaultAgentHeight) / 2;
    const bCenterY = b.y + (b.height ?? LAYOUT_ENGINE_SPEC.defaultAgentHeight) / 2;
    const aRow = Math.floor(aCenterY / cellH);
    const bRow = Math.floor(bCenterY / cellH);
    if (aRow !== bRow) return aRow - bRow;
    return a.x - b.x;
  });

  const result: Array<{ id: string; x: number; y: number; width: number; height: number }> = [];
  for (let i = 0; i < sorted.length; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    result.push({
      id: sorted[i].id,
      x: snapToGrid(pad + col * cellW, grid),
      y: snapToGrid(pad + row * cellH, grid),
      width: agentW,
      height: agentH,
    });
  }
  return result;
}

// ═════════════════════════════════════════════════════════════════
// STAGE LAYOUT  (user-commanded cinematic theater)
// ═════════════════════════════════════════════════════════════════

/**
 * User-commanded cinematic theater layout. Identifies the primary
 * agent (focused / active / first) and scales it to 65 % viewport
 * width, centering it on screen. Secondaries stack on the right.
 */
function computeStageLayout(
  agents: Agent[],
  selectedAgentId: string | null,
  viewportW: number,
  viewportH: number,
): Array<{ id: string; x: number; y: number; width: number; height: number }> {
  if (agents.length === 0) return [];

  const {
    stageWidthRatio,
    stageHeightRatio,
    stageColumnWidth,
    stageGap,
    stageMaxSideRatio,
    tidyPadding: pad,
    gridSnap: grid,
    secondaryScaleMax,
  } = LAYOUT_ENGINE_SPEC.arrangements;

  // ── Identify the primary agent ─────────────────────────────
  const primaryId =
    (selectedAgentId && agents.some((a) => a.id === selectedAgentId))
      ? selectedAgentId
      : agents.find((a) => a.status === 'active' || a.status === 'busy')?.id ?? agents[0].id;

  const primary = agents.find((a) => a.id === primaryId)!;
  const defW = primary.width ?? LAYOUT_ENGINE_SPEC.defaultAgentWidth;
  const defH = primary.height ?? LAYOUT_ENGINE_SPEC.defaultAgentHeight;

  // ── Stage dimensions ───────────────────────────────────────
  const stageW = Math.round(viewportW * stageWidthRatio);
  const stageH = Math.round(viewportH * stageHeightRatio);

  // Scale primary to fit the stage while preserving its aspect ratio
  const scale = Math.min(stageW / defW, stageH / defH, 1.0);
  const pw = snapToGrid(Math.max(Math.round(defW * scale), grid), grid);
  const ph = snapToGrid(Math.max(Math.round(defH * scale), grid), grid);

  // Center the stage panel in the stage area
  const px = snapToGrid(Math.round((viewportW * stageWidthRatio - pw) / 2), grid);
  const py = snapToGrid(Math.round((viewportH - ph) / 2), grid);

  const result: Array<{ id: string; x: number; y: number; width: number; height: number }> = [
    { id: primaryId, x: px, y: py, width: pw, height: ph },
  ];

  // ── Secondary agents: compact column on the right ──────────
  const secondaries = agents.filter((a) => a.id !== primaryId);
  if (secondaries.length === 0) return result;

  const colX = snapToGrid(
    Math.round(viewportW * stageWidthRatio + pad * 2),
    grid,
  );
  const colW = Math.min(
    stageColumnWidth,
    Math.round(viewportW * stageMaxSideRatio),
  );
  const availableH = viewportH - (secondaries.length + 1) * stageGap;
  const secondaryH = snapToGrid(
    Math.max(
      Math.round(
        Math.min(availableH / secondaries.length, defH * secondaryScaleMax),
      ),
      grid,
    ),
    grid,
  );

  secondaries.forEach((agent, i) => {
    result.push({
      id: agent.id,
      x: colX,
      y: snapToGrid(pad + i * (secondaryH + stageGap), grid),
      width: colW,
      height: secondaryH,
    });
  });

  return result;
}

// ═════════════════════════════════════════════════════════════════
// LAYER 3 — DEBOUNCED AUTO-LIFECYCLE SUBSCRIPTION
// ═════════════════════════════════════════════════════════════════
//
// Rapid agent add/remove events within <autoArrangeDebounceMs> are
// coalesced into a single layout pass. This prevents the oscillation
// and jitter caused by running a full arrange on every single change.
//
// Decision tree:
//   Agent count changes (and count > 0)
//     ├─ layoutMode is set  →  immediate notifyAgentChanged()
//     └─ layoutMode is null →  check canvas window settings
//         ├─ should tidy    →  debounce → autoArrange (flow→tidy→frame)
//         └─ should NOT     →  use smart spawn slot (future)

let lifecycleUnsub: (() => void) | null = null;

function subscribeAgentLifecycle() {
  if (lifecycleUnsub) return;

  lifecycleUnsub = useAppStore.subscribe((state, prevState) => {
    const prevCount = prevState.agents.length;
    const currCount = state.agents.length;
    if (currCount === prevCount || currCount === 0) return;

    const wasOpen = currCount > prevCount;
    const ws = useWorkspaceStore.getState();

    // If a specific layout mode is active, re-run it immediately
    if (ws.layoutMode) {
      queueMicrotask(() => ws.notifyAgentChanged());
      return;
    }

    // Manual mode — check canvas window settings
    const shouldTidy = wasOpen
      ? ws.settings.tidyOnWindowOpen
      : ws.settings.tidyOnWindowClose;

    if (shouldTidy) {
      // First agent (0 → 1): arrange immediately, no debounce
      if (prevCount === 0) {
        queueMicrotask(() => ws.autoArrange());
      } else {
        debounceAutoArrange();
      }
    }
    // NOTE: When shouldTidy is false, the agent spawns at (0,0) by
    // default. In a future pass we'll route this through findSpawnSlot
    // so new agents land near the viewport center without moving
    // existing panels.
  });

  // ── Viewport resize subscription ────────────────────────────
  // When the user resizes the ORCH window, auto-recalculate the layout
  // so cards re-flow and re-frame to the new viewport dimensions.
  // Ignore sub-50px changes to avoid jitter during window snapping.
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
}

// ── Debounce timer ──────────────────────────────────────────────
let autoArrangeTimer: ReturnType<typeof setTimeout> | null = null;

function debounceAutoArrange() {
  if (autoArrangeTimer) clearTimeout(autoArrangeTimer);
  autoArrangeTimer = setTimeout(() => {
    autoArrangeTimer = null;
    useWorkspaceStore.getState().autoArrange();
  }, LAYOUT_ENGINE_SPEC.autoArrangeDebounceMs);
}

// ═════════════════════════════════════════════════════════════════
// VIEWPORT FRAME COMMIT  (shared helper for all layout actions)
// ═════════════════════════════════════════════════════════════════

/**
 * Apply the framer's computed pan+zoom to the app store and mark the
 * layout phase as settled after the animation duration.
 */
function commitViewportFrame(
  pan: { x: number; y: number },
  zoom: number,
  vw: number,
  vh: number,
) {
  // The canvas container reads layoutTransition for its transform
  // animation. We set it before the viewport mutation.
  const appStore = useAppStore.getState();
  appStore.setViewport(pan, zoom, { w: vw, h: vh });
}

// ── Store ─────────────────────────────────────────────────────

interface WorkspaceState {
  /** Absolute path to the currently open workspace folder */
  currentWorkspacePath: string | null;
  /** Display name (last segment of the folder path) */
  currentWorkspaceName: string | null;
  /** List of recently opened workspaces */
  recentWorkspaces: WorkspaceMeta[];
  /** Whether there are unsaved changes */
  isDirty: boolean;
  /** Whether we're in the middle of an I/O operation */
  isBusy: boolean;
  /** Error message if last operation failed */
  error: string | null;
  /** Whether auto-open has been attempted this session */
  autoOpenAttempted: boolean;
  /** Supabase workspace UUID (for cloud sync) */
  cloudWorkspaceId: string | null;
  /** Last known Supabase row version (optimistic concurrency guard) */
  cloudRowVersion: number | null;

  // ── Layout Engine State ──────────────────────────────────────
  /** Currently active arrangement mode (null = auto-flow) */
  layoutMode: LayoutMode | null;
  /** Engine lifecycle phase — components use this to gate transitions */
  layoutPhase: 'idle' | 'arranging' | 'settled';
  /** CSS transition string applied to agent panel wrappers during animations */
  layoutTransition: string;

  // ── Canvas Window Settings ─────────────────────────────────────
  settings: CanvasWindowSettings;

  // ── Actions ───────────────────────────────────────────────

  /** Load recent workspaces from electron userData on boot */
  loadRecentWorkspaces: () => Promise<void>;

  /** Try to open the most recently used workspace (called once on boot) */
  autoOpenLastWorkspace: () => Promise<void>;

  /** Pre-fetch all recent workspaces into the in-memory cache */
  preloadCache: () => Promise<void>;

  /** Open the OS folder picker, then create+open a new workspace */
  createWorkspace: () => Promise<void>;

  /** Pick a folder → read its .orch-workspace.json → hydrate stores */
  openWorkspace: (path?: string) => Promise<void>;

  /** Save current state to the current workspace file */
  saveWorkspace: () => Promise<void>;

  /** Switch to a different workspace (save current first if dirty) */
  switchWorkspace: (path: string) => Promise<void>;

  /** Close the current workspace (save first) */
  closeWorkspace: () => Promise<void>;

  /** Mark workspace as having unsaved changes */
  markDirty: () => void;
  /** Mark workspace as saved */
  markClean: () => void;

  /** Dismiss error */
  clearError: () => void;

  // ── Layout Engine Actions ────────────────────────────────────

  /** Run the full auto-arrange pipeline: flow → micro-tidy → frame */
  autoArrange: () => void;

  /**
   * Tidy — damped single-pass collision separation.
   * For explicit use via setLayoutMode('tidy'). Also used inside
   * auto-arrange as the micro-tidy polish step.
   */
  arrangeTidy: () => void;

  /** Arrange all agents into a matrix grid aligned to the snap grid */
  arrangeGrid: () => void;

  /** Arrange agents into cinematic theater layout */
  arrangeStage: () => void;

  /**
   * Set the active layout mode and immediately execute it.
   * Pass `null` to return to auto-flow mode.
   */
  setLayoutMode: (mode: LayoutMode | null) => void;

  /**
   * Re-run the current layout mode. Called by the lifecycle
   * subscription when layoutMode is active and agents change.
   */
  notifyAgentChanged: () => void;

  /** Toggle a canvas window setting by key */
  toggleSetting: (key: keyof CanvasWindowSettings) => void;
}

export const useWorkspaceStore = create<WorkspaceState>()((set, get) => {
  // Initialise the agent lifecycle subscription once
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

  // ── Layout initial state ─────────────────────────────────────
  layoutMode: null,
  layoutPhase: 'idle',
  layoutTransition: '',

  // ── Canvas window settings ────────────────────────────────────
  settings: {
    allowAgentCanvasControl: false,
    tidyOnWindowOpen: true,
    tidyOnWindowClose: true,
  },

  loadRecentWorkspaces: async () => {
    try {
      const list = await getRecentWorkspaces();
      set({ recentWorkspaces: list });
    } catch {
      // Non-critical
    }
  },

  autoOpenLastWorkspace: async () => {
    const { autoOpenAttempted, recentWorkspaces } = get();
    if (autoOpenAttempted) return;
    set({ autoOpenAttempted: true });

    // Load recent workspaces if not already loaded
    let list = recentWorkspaces;
    if (list.length === 0) {
      try { list = await getRecentWorkspaces(); } catch { return; }
      if (list.length === 0) return;
      set({ recentWorkspaces: list });
    }

    // Find most recently used workspace
    const last = list.reduce((a, b) => (a.lastOpened > b.lastOpened ? a : b));
    if (!last || !last.path) return;

    try {
      await get().openWorkspace(last.path);
    } catch (err) {
      console.warn('[Workspace] Auto-open failed:', err);
      // Non-fatal — user can open manually
    }
  },

  preloadCache: async () => {
    const { recentWorkspaces } = get();
    const results = await Promise.allSettled(
      recentWorkspaces.map(async (ws) => {
        if (workspaceCache.has(ws.path)) return;
        const raw = await readWorkspaceFile(ws.path);
        if (raw) {
          cacheSet(ws.path, raw as unknown as WorkspaceFile);
        }
      }),
    );
    const loaded = results.filter((r) => r.status === 'fulfilled').length;
    console.log(`[Workspace] Preloaded ${loaded}/${recentWorkspaces.length} workspaces into cache`);
  },

  createWorkspace: async () => {
    set({ isBusy: true, error: null });

    // 1. Close current workspace (auto-save)
    const { currentWorkspacePath: current } = get();
    if (current) {
      await get().saveWorkspace();
      useCanvasStore.getState().resetCanvas();
      useAppStore.getState().resetAppState();
    }

    // 2. Open folder picker
    const folderPath = await selectWorkspaceFolder();
    if (!folderPath) {
      set({ isBusy: false });
      return; // user cancelled
    }

    try {
      const name = folderNameFromPath(folderPath);
      const style = captureStyle();

      // 3. Write initial empty workspace file
      const data: WorkspaceFile = {
        version: 1,
        name,
        lastOpened: Date.now(),
        canvas: {
          elements: [],
          strokeColor: '#ff781f',
          strokeWidth: 2,
          fillEnabled: false,
          fillOpacity: 20,
          fontSize: 14,
        },
        agents: {
          agents: [],
          viewportPan: { x: 0, y: 0 },
          viewportZoom: 1,
        },
        style,
      };

      await writeWorkspaceFile(folderPath, data);
      cacheSet(folderPath, data);

      // 4. Hydrate stores with empty state
      useCanvasStore.getState().hydrateFromWorkspace({});
      useAppStore.getState().hydrateFromWorkspace({});

      // 5. Update recent workspaces
      const now = Date.now();
      const updated = updateRecentList(get().recentWorkspaces, folderPath, name, now);
      await saveRecentWorkspaces(updated);

      set({
        currentWorkspacePath: folderPath,
        currentWorkspaceName: name,
        recentWorkspaces: updated,
        isDirty: false,
        isBusy: false,
      });

      // ── Cloud sync for new workspace ────────────────────
      const authStatus = useAuthStore.getState().status;
      if (authStatus === 'authenticated') {
        upsertWorkspace({
          name,
          canvas_data: { ...data, _version: 0 },
          style: style as any,
        }).then((result) => {
          set({ cloudWorkspaceId: result.id, cloudRowVersion: result.version });
          upsertDevicePath(result.id, folderPath).catch(() => {});
        }).catch((err) => {
          console.warn('[Cloud] Create workspace sync failed:', err);
        });
      }
    } catch (err: any) {
      set({ isBusy: false, error: err?.message || 'Failed to create workspace' });
    }
  },

  openWorkspace: async (path?: string) => {
    set({ isBusy: true, error: null });

    // Close current
    const { currentWorkspacePath: current } = get();
    if (current) {
      await get().saveWorkspace();
      useCanvasStore.getState().resetCanvas();
      useAppStore.getState().resetAppState();
    }

    // Pick folder if no path given
    let folderPath = path;
    if (!folderPath) {
      const selected = await selectWorkspaceFolder();
      if (!selected) {
        set({ isBusy: false });
        return;
      }
      folderPath = selected;
    }

    try {
      // Check cache first for instant open
      let file: WorkspaceFile | null = workspaceCache.get(folderPath) || null;

      if (!file) {
        // Check if workspace file exists on disk
        const exists = await workspaceExists(folderPath);
        if (!exists) {
          // No .orch-workspace.json — treat as new workspace (auto-create)
          const name = folderNameFromPath(folderPath);
          const style = captureStyle();
          file = {
            version: 1,
            name,
            lastOpened: Date.now(),
            canvas: {
              elements: [],
              strokeColor: '#ff781f',
              strokeWidth: 2,
              fillEnabled: false,
              fillOpacity: 20,
              fontSize: 14,
            },
            agents: {
              agents: [],
              viewportPan: { x: 0, y: 0 },
              viewportZoom: 1,
            },
            style,
          };
          await writeWorkspaceFile(folderPath, file);
        } else {
          // Read from disk
          const raw = await readWorkspaceFile(folderPath);
          file = raw ? (raw as unknown as WorkspaceFile) : null;

          if (!file) {
            // Corrupt file — start fresh
            const name = folderNameFromPath(folderPath);
            file = {
              version: 1,
              name,
              lastOpened: Date.now(),
              canvas: { elements: [], strokeColor: '#ff781f', strokeWidth: 2, fillEnabled: false, fillOpacity: 20, fontSize: 14 },
              agents: { agents: [], viewportPan: { x: 0, y: 0 }, viewportZoom: 1 },
              style: captureStyle(),
            };
          }
        }
        // Populate cache
        cacheSet(folderPath, file);
      }

      // Hydrate stores from file data
      useCanvasStore.getState().hydrateFromWorkspace(file.canvas || {});
      useAppStore.getState().hydrateFromWorkspace(file.agents || {});

      // Apply per-workspace style (theme, grid, snap)
      applyStyle(file.style);

      const name = file?.name || folderNameFromPath(folderPath);

      // Update lastOpened in the cache + file
      const now = Date.now();
      file.lastOpened = now;
      cacheSet(folderPath, file);

      // Debounced disk write will handle the update

      // Update recent list
      const updated = updateRecentList(get().recentWorkspaces, folderPath, name, now);
      await saveRecentWorkspaces(updated);
      set({ recentWorkspaces: updated });

      set({
        currentWorkspacePath: folderPath,
        currentWorkspaceName: name,
        isDirty: false,
        isBusy: false,
      });
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
      const name = folderNameFromPath(currentWorkspacePath);

      const data: WorkspaceFile = {
        version: 1,
        name,
        lastOpened: Date.now(),
        canvas: canvasData,
        agents: appData,
        style,
      };

      // ── Local save (always, source of truth) ─────────────
      await writeWorkspaceFile(currentWorkspacePath, data);
      cacheSet(currentWorkspacePath, data);
      set({ isDirty: false });

      // ── Cloud sync (fire-and-forget, never blocks) ───────
      const authStatus = useAuthStore.getState().status;
      if (authStatus === 'authenticated') {
        const { cloudWorkspaceId, cloudRowVersion } = get();
        upsertWorkspace({
          id: cloudWorkspaceId || undefined,
          name,
          canvas_data: { ...data, _version: cloudRowVersion ?? 0 },
          style: style as any,
          last_opened: new Date().toISOString(),
        }).then((result) => {
          // Store the cloud ID and version on each successful sync
          const patch: Record<string, any> = { cloudRowVersion: result.version };
          if (!get().cloudWorkspaceId) {
            patch.cloudWorkspaceId = result.id;
          }
          set(patch as any);
          // Record device path mapping
          upsertDevicePath(result.id, currentWorkspacePath).catch(() => {});
        }).catch((err) => {
          console.warn('[Cloud] Workspace sync failed:', err);
        });
      }
    } catch (err: any) {
      console.error('[Workspace] Save failed:', err);
      set({ error: err?.message || 'Failed to save workspace' });
    }
  },

  switchWorkspace: async (path: string) => {
    const { currentWorkspacePath } = get();
    if (currentWorkspacePath === path) return; // already on this workspace
    await get().closeWorkspace();
    await get().openWorkspace(path);
  },

  closeWorkspace: async () => {
    const { currentWorkspacePath } = get();
    if (!currentWorkspacePath) return;

    // Auto-save before closing
    if (get().isDirty) {
      await get().saveWorkspace();
    }

    // Reset stores
    useCanvasStore.getState().resetCanvas();
    useAppStore.getState().resetAppState();

    set({
      currentWorkspacePath: null,
      currentWorkspaceName: null,
      isDirty: false,
    });
  },

  markDirty: () => {
    if (get().currentWorkspacePath) {
      set({ isDirty: true });
    }
  },

  markClean: () => set({ isDirty: false }),

  clearError: () => set({ error: null }),

  // ── Layout Engine Action Implementations ─────────────────────

  autoArrange: () => {
    const agents = useAppStore.getState().agents.filter(
      (a) => a.status !== 'deleted',
    );
    if (agents.length === 0) return;

    const { vw, vh } = getViewportCenter();

    // Compute everything in-memory before committing
    const { positions, sizes, pan, zoom } = computeAutoArrange(agents, vw, vh);

    // 1. Set transition tokens so CSS animates the slide
    set({
      layoutMode: null, // stays in auto-flow mode
      layoutPhase: 'arranging',
      layoutTransition: resolveLayoutTransition(),
    });

    // 2. Commit all agent positions, sizes, and viewport frame in one shot
    const appStore = useAppStore.getState();
    appStore.updateAgentPositions(positions);
    for (const s of sizes) {
      appStore.updateAgentSize(s.id, s.width, s.height);
    }
    commitViewportFrame(pan, zoom, vw, vh);

    // 3. Settle after animation completes
    requestAnimationFrame(() => {
      setTimeout(() => {
        set({ layoutPhase: 'settled' });
      }, LAYOUT_ENGINE_SPEC.animation.duration + 50);
    });
  },

  arrangeTidy: () => {
    const agents = useAppStore.getState().agents.filter(
      (a) => a.status !== 'deleted',
    );
    if (agents.length === 0) return;

    const { vw, vh } = getViewportCenter();

    // For explicit tidy mode, we run flow → micro-tidy → frame
    // (same pipeline as auto-arrange but with layoutMode='tidy')
    const { positions, sizes, pan, zoom } = computeAutoArrange(agents, vw, vh);

    set({
      layoutMode: 'tidy',
      layoutPhase: 'arranging',
      layoutTransition: resolveLayoutTransition(),
    });

    const appStore = useAppStore.getState();
    appStore.updateAgentPositions(positions);
    for (const s of sizes) {
      appStore.updateAgentSize(s.id, s.width, s.height);
    }
    commitViewportFrame(pan, zoom, vw, vh);

    requestAnimationFrame(() => {
      setTimeout(() => {
        set({ layoutPhase: 'settled' });
      }, LAYOUT_ENGINE_SPEC.animation.duration + 50);
    });
  },

  arrangeGrid: () => {
    const agents = useAppStore.getState().agents.filter(
      (a) => a.status !== 'deleted',
    );
    if (agents.length === 0) return;

    const { vw, vh } = getViewportCenter();
    const gridResult = computeGridLayout(agents, vw, vh);

    // Micro-tidy polish then frame
    const polished = computeMicroTidy(
      gridResult.map((r) => ({ id: r.id, x: r.x, y: r.y })),
      agents,
    );
    const posMap = new Map(polished.map((p) => [p.id, p]));
    const framedAgents = agents.map((a) => {
      const pos = posMap.get(a.id);
      return pos ? { ...a, x: pos.x, y: pos.y } : a;
    });
    const chromeTop = LAYOUT_ENGINE_SPEC.chrome.topOffset;
    const { pan, zoom } = computeFrameViewport(framedAgents, vw, vh, chromeTop);

    set({
      layoutMode: 'grid',
      layoutPhase: 'arranging',
      layoutTransition: resolveLayoutTransition(),
    });

    const appStore = useAppStore.getState();
    appStore.updateAgentPositions(polished);
    for (const r of gridResult) {
      appStore.updateAgentSize(r.id, r.width, r.height);
    }
    commitViewportFrame(pan, zoom, vw, vh);

    requestAnimationFrame(() => {
      setTimeout(() => {
        set({ layoutPhase: 'settled' });
      }, LAYOUT_ENGINE_SPEC.animation.duration + 50);
    });
  },

  arrangeStage: () => {
    const agents = useAppStore.getState().agents.filter(
      (a) => a.status !== 'deleted',
    );
    if (agents.length === 0) return;

    const selectedAgentId = useAppStore.getState().selectedAgentId;
    const { vw, vh } = getViewportCenter();
    const updates = computeStageLayout(agents, selectedAgentId, vw, vh);

    // Micro-tidy polish on the secondary column, then frame the whole stage
    const polished = computeMicroTidy(
      updates.map((u) => ({ id: u.id, x: u.x, y: u.y })),
      agents,
    );

    // Merge sizes back from the original stage computation
    const stageMap = new Map(updates.map((u) => [u.id, u]));
    const finalUpdates = polished.map((p) => {
      const stage = stageMap.get(p.id);
      return {
        ...p,
        width: stage?.width ?? LAYOUT_ENGINE_SPEC.defaultAgentWidth,
        height: stage?.height ?? LAYOUT_ENGINE_SPEC.defaultAgentHeight,
      };
    });

    // Build framed agents for viewport computation
    const framedAgents = agents.map((a) => {
      const up = stageMap.get(a.id);
      return {
        ...a,
        x: up?.x ?? a.x,
        y: up?.y ?? a.y,
        width: up?.width ?? a.width,
        height: up?.height ?? a.height,
      };
    });
    const chromeTop = LAYOUT_ENGINE_SPEC.chrome.topOffset;
    const { pan, zoom } = computeFrameViewport(framedAgents, vw, vh, chromeTop);

    set({
      layoutMode: 'stage',
      layoutPhase: 'arranging',
      layoutTransition: resolveLayoutTransition(),
    });

    const appStore = useAppStore.getState();
    appStore.updateAgentPositions(
      finalUpdates.map((u) => ({ id: u.id, x: u.x, y: u.y })),
    );
    for (const u of finalUpdates) {
      appStore.updateAgentSize(u.id, u.width, u.height);
    }
    commitViewportFrame(pan, zoom, vw, vh);

    requestAnimationFrame(() => {
      setTimeout(() => {
        set({ layoutPhase: 'settled' });
      }, LAYOUT_ENGINE_SPEC.animation.duration + 50);
    });
  },

  setLayoutMode: (mode) => {
    if (!mode) {
      // Disable explicit layout mode — return to auto-flow
      set({
        layoutMode: null,
        layoutPhase: 'idle',
        layoutTransition: '',
      });
      return;
    }

    // Immediately execute the chosen layout
    const { autoArrange, arrangeGrid, arrangeStage } = get();
    switch (mode) {
      case 'tidy':  autoArrange(); break; // tidy = flow→micro-tidy→frame
      case 'grid':  arrangeGrid(); break;
      case 'stage': arrangeStage(); break;
    }
  },

  notifyAgentChanged: () => {
    const { layoutMode, autoArrange, arrangeGrid, arrangeStage } = get();
    switch (layoutMode) {
      case 'tidy':  autoArrange(); break;
      case 'grid':  arrangeGrid(); break;
      case 'stage': arrangeStage(); break;
      // null = auto-flow — handled by debounce lifecycle subscription
    }
  },

  toggleSetting: (key) => {
    set((state) => ({
      settings: { ...state.settings, [key]: !state.settings[key] },
    }));
  },
  };
});

// ── Helpers ──────────────────────────────────────────────────

function updateRecentList(
  list: WorkspaceMeta[],
  path: string,
  name: string,
  lastOpened: number,
): WorkspaceMeta[] {
  // Remove duplicate entry for this path, then prepend
  const filtered = list.filter((w) => w.path !== path);
  return [{ path, name, lastOpened }, ...filtered].slice(0, 20);
}
