// ── ORCH Layout Engine ─────────────────────────────────────────
// Pure functions — no React, no Zustand.
// All layout math lives here. One engine, no duplicates.

// ── Chrome ────────────────────────────────────────────────────
// UI overlays that reduce the visible canvas area.
export const CHROME = {
  pillBar: { top: 26, height: 36 },
  chatBar: { bottom: 28, height: 44 },
  leftReserved: 0,
} as const;

// ── Types ─────────────────────────────────────────────────────
export interface PanelItem {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  naturalW?: number;  // optional overrides for shelfPack
  naturalH?: number;
  /** When true the engine treats this panel as a fixed obstacle and will
   *  never move or resize it — used for user-pinned panels (manual resize). */
  locked?: boolean;
}

export interface SafeRegion {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

export interface CellSize {
  cellW: number;
  cellH: number;
  agentW: number;
  agentH: number;
  cols: number;
}

export interface LayoutResult {
  positions: Array<{ id: string; x: number; y: number }>;
  sizes: Array<{ id: string; width: number; height: number }>;
  pan: { x: number; y: number };
  zoom: number;
}

export interface Viewport {
  w: number;
  h: number;
  pan: { x: number; y: number };
  zoom: number;
}

export interface LayoutCtx {
  panels: PanelItem[];
  viewport: Viewport;
  browserVisible: boolean;
  musicVisible: boolean;
  grid?: number;
  gap?: number;
}

export interface FrameSpec {
  maxZoom: number;
  minZoom: number;
  padding: number;
}

// ── Helpers ───────────────────────────────────────────────────

function snap(v: number, grid: number): number {
  return Math.round(v / grid) * grid;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// ── Safe Region ───────────────────────────────────────────────
// Encodes the user's exact insets from chrome elements.
export function computeSafeRegion(
  vw: number,
  vh: number,
  grid: number = 32,
): SafeRegion {
  const top = CHROME.pillBar.top + CHROME.pillBar.height + grid;
  const bottom = vh - CHROME.chatBar.bottom - CHROME.chatBar.height - grid;
  const left = CHROME.leftReserved + grid;
  const right = vw - grid;
  return {
    top, bottom, left, right,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

// ── Adaptive Cell Size ────────────────────────────────────────
// Single uniform cell size for agent-grid rows.
// Column count: 1→1, 2→1 stacked, 3-4→2 cols, 5+→3 cols.
export function computeAdaptiveCellSize(
  count: number,
  region: SafeRegion,
  grid: number = 32,
  spec?: {
    minAgentWidth?: number;
    minAgentHeight?: number;
    maxAgentWidth?: number;
    maxAgentHeight?: number;
    targetMaxVisibleRows?: number;
    defaultAgentWidth?: number;
    defaultAgentHeight?: number;
  },
): CellSize {
  const defW = spec?.defaultAgentWidth ?? 520;
  const defH = spec?.defaultAgentHeight ?? 360;
  const minW = spec?.minAgentWidth ?? 320;
  const minH = spec?.minAgentHeight ?? 200;
  const maxW = spec?.maxAgentWidth ?? 600;
  const maxH = spec?.maxAgentHeight ?? 420;
  const maxRows = spec?.targetMaxVisibleRows ?? 3;
  const pad = grid; // gap between cells = 1 grid box
  const availableW = region.width;
  const availableH = region.height;
  const aspect = defW / defH;

  // Column count based on agent count
  let optimalCols: number;
  if (count <= 2) optimalCols = 1;
  else if (count <= 4) optimalCols = 2;
  else optimalCols = 3;

  const idealRows = Math.ceil(count / optimalCols);

  if (idealRows <= maxRows && count >= 1) {
    const colsUsed = Math.min(optimalCols, count);
    const growW = (availableW / colsUsed) - pad;
    const growH = (availableH / idealRows) - pad;
    let agentW = Math.round(Math.min(maxW, Math.max(defW, growW)));
    let agentH = Math.round(Math.min(maxH, Math.max(defH, growH)));
    // Preserve aspect
    let finalW = agentW;
    let finalH = Math.round(agentW / aspect);
    if (finalH > agentH) {
      finalH = agentH;
      finalW = Math.round(agentH * aspect);
    }
    return {
      cellW: snap(finalW + pad, grid),
      cellH: snap(finalH + pad, grid),
      agentW: snap(finalW, grid),
      agentH: snap(finalH, grid),
      cols: optimalCols,
    };
  }

  // Overflow: shrink proportionally
  if (count <= 1) {
    return { cellW: snap(defW + pad, grid), cellH: snap(defH + pad, grid), agentW: snap(defW, grid), agentH: snap(defH, grid), cols: 1 };
  }
  const neededCols = Math.ceil(count / maxRows);
  const cellW = Math.max(minW + pad, availableW / neededCols);
  const scale = (cellW - pad) / defW;
  const cellH = Math.max(minH + pad, (defH + pad) * scale);
  return {
    cellW: snap(cellW, grid),
    cellH: snap(cellH, grid),
    agentW: snap(Math.round(cellW - pad), grid),
    agentH: snap(Math.round(cellH - pad), grid),
    cols: neededCols,
  };
}

// ── Shelf Pack (first-fit row packer) ─────────────────────────
// Heterogeneous first-fit row packer. Guarantees exactly `gap`
// between every node, left→right wrap, zero overlaps.
export function shelfPack(
  items: PanelItem[],
  region: SafeRegion,
  gap: number = 32,
  grid: number = 32,
): Array<{ id: string; x: number; y: number }> {
  if (items.length === 0) return [];
  const results: Array<{ id: string; x: number; y: number }> = [];
  let currentX = region.left;
  let currentY = region.top;
  let rowH = 0;
  for (const item of items) {
    const w = item.naturalW ?? item.width;
    const h = item.naturalH ?? item.height;
    // Wrap to next row if this item overflows
    if (currentX + w > region.right && currentX > region.left) {
      currentX = region.left;
      currentY += rowH + gap;
      rowH = 0;
    }
    results.push({ id: item.id, x: snap(currentX, grid), y: snap(currentY, grid) });
    currentX += w + gap;
    if (h > rowH) rowH = h;
  }
  return results;
}

// ── Hero Layout (single node) ────────────────────────────────
// Centered, full safe height, width capped to heroMax.
export function heroLayout(
  item: PanelItem,
  region: SafeRegion,
  grid: number = 32,
): { x: number; y: number; width: number; height: number } {
  const heroMax = region.width * 0.65;
  const w = snap(Math.min(item.width, heroMax), grid);
  const h = snap(Math.min(item.height, region.height), grid);
  return {
    x: snap(region.left + (region.width - w) / 2, grid),
    y: snap(region.top + (region.height - h) / 2, grid),
    width: w,
    height: h,
  };
}

// ── Stage Layout (browser open) ──────────────────────────────
// Browser takes left half, full safe height.
// Other nodes (+music) shelfPack into the right half as sub-grid.
export function stageLayout(
  browser: PanelItem,
  others: PanelItem[],
  region: SafeRegion,
  gap: number = 32,
  grid: number = 32,
): Array<{ id: string; x: number; y: number; width?: number; height?: number }> {
  const results: Array<{ id: string; x: number; y: number; width?: number; height?: number }> = [];

  // Browser takes left half width
  const browserW = snap(region.width * 0.5, grid);
  const browserH = snap(region.height, grid);
  results.push({
    id: browser.id,
    x: region.left,
    y: region.top,
    width: browserW,
    height: browserH,
  });

  // Others shelf-pack into the right half
  const rightRegion: SafeRegion = {
    ...region,
    left: region.left + browserW + gap,
    width: region.width - browserW - gap,
  };

  if (others.length > 0) {
    const subResults = shelfPack(others.map(o => ({
      ...o,
      naturalW: o.naturalW ?? (rightRegion.width - gap),
      naturalH: o.naturalH ?? o.height,
    })), rightRegion, gap, grid);
    results.push(...subResults);
  }

  return results;
}

// ── Frame Viewport ───────────────────────────────────────────
// Computes pan + zoom to fit a bounding box into the safe region.
export function frameViewport(
  bbox: { minX: number; minY: number; maxX: number; maxY: number },
  vw: number,
  vh: number,
  spec?: Partial<FrameSpec>,
): { pan: { x: number; y: number }; zoom: number } {
  const maxZoom = spec?.maxZoom ?? 1.0;
  const minZoom = spec?.minZoom ?? 0.35;
  const pad = spec?.padding ?? 60;

  const contentW = (bbox.maxX - bbox.minX) + pad * 2;
  const contentH = (bbox.maxY - bbox.minY) + pad * 2;

  if (contentW <= 0 || contentH <= 0) {
    return { pan: { x: 0, y: 0 }, zoom: 1 };
  }

  let zoom = Math.min(vw / contentW, vh / contentH);
  zoom = clamp(zoom, minZoom, maxZoom);

  const centerX = (bbox.minX + bbox.maxX) / 2;
  const centerY = (bbox.minY + bbox.maxY) / 2;

  return {
    pan: {
      x: vw / 2 - centerX * zoom,
      y: vh / 2 - centerY * zoom,
    },
    zoom,
  };
}

// ── Resolve Layout (the orchestrator) ─────────────────────────
// Given panels + viewport, picks the mode automatically:
//   0 nodes → no-op
//   1 node  → heroLayout
//   browser visible → stageLayout
//   else → shelfPack over adaptive cells
// Always → snap + clamp + final overlap-sweep
export function resolveLayout(ctx: LayoutCtx): LayoutResult {
  const grid = ctx.grid ?? 32;
  const gap = ctx.gap ?? 32;
  const region = computeSafeRegion(ctx.viewport.w, ctx.viewport.h, grid);

  if (ctx.panels.length === 0) {
    return { positions: [], sizes: [], pan: ctx.viewport.pan, zoom: ctx.viewport.zoom };
  }

  const agents = ctx.panels.filter((p) => p.type === 'agent');
  const browser = ctx.panels.find((p) => p.type === 'browser');
  const music = ctx.panels.find((p) => p.type === 'music');
  const otherPanels = ctx.panels.filter((p) => p.type !== 'agent');

  let positions: Array<{ id: string; x: number; y: number }> = [];
  let sizes: Array<{ id: string; width: number; height: number }> = [];

  // ── Mode selection ────────────────────────────────────────
  if (agents.length === 0 && otherPanels.length === 0) {
    return { positions: [], sizes: [], pan: ctx.viewport.pan, zoom: ctx.viewport.zoom };
  }

  if (agents.length === 1 && !browser && otherPanels.length === 0) {
    // Hero mode: single agent
    const hero = heroLayout(agents[0], region, grid);
    positions = [{ id: agents[0].id, x: hero.x, y: hero.y }];
    sizes = [{ id: agents[0].id, width: hero.width, height: hero.height }];
  } else if (ctx.browserVisible && browser) {
    // Stage mode: browser left, agents + music right
    const others = ctx.panels.filter((p) => p.id !== browser.id);
    const stageResults = stageLayout(browser, others, region, gap, grid);
    positions = stageResults.map((r) => ({ id: r.id, x: r.x, y: r.y }));
    sizes = ctx.panels.map((p) => {
      const sr = stageResults.find((r) => r.id === p.id);
      return {
        id: p.id,
        width: sr?.width ?? p.width,
        height: sr?.height ?? p.height,
      };
    });
  } else {
    // Default: shelfPack over adaptive cells
    // Compute adaptive cell for agents
    const agentCount = agents.length;
    const cell = agentCount > 0
      ? computeAdaptiveCellSize(agentCount, region, grid)
      : { cellW: 520 + gap, cellH: 360 + gap, agentW: 520, agentH: 360, cols: 3 };

    // Assign natural sizes for shelf pack
    const shelved = ctx.panels.map((p) => ({
      ...p,
      naturalW: p.type === 'agent' ? cell.agentW : p.width,
      naturalH: p.type === 'agent' ? cell.agentH : p.height,
    }));

    positions = shelfPack(shelved, region, gap, grid);
    sizes = ctx.panels.map((p) => ({
      id: p.id,
      width: p.type === 'agent' ? cell.agentW : p.width,
      height: p.type === 'agent' ? cell.agentH : p.height,
    }));
  }

  // ── Final overlap-sweep pass ──────────────────────────────
  // Defensive: run micro-tidy collision resolution. Locked panels are passed
  // as fixed obstacles — the sweep pushes movable panels away from them but
  // never moves the locked ones themselves.
  const lockedSet = new Set(ctx.panels.filter((p) => p.locked).map((p) => p.id));
  const swept = overlapSweep(positions, sizes, gap, grid, region, lockedSet);

  // Hard guarantee: restore every locked panel to its original geometry, so
  // nothing in the pipeline (mode, sweep, clamp) can have shifted it.
  for (const p of ctx.panels) {
    if (!p.locked) continue;
    const li = swept.findIndex((s) => s.id === p.id);
    if (li >= 0) {
      swept[li] = { id: p.id, x: snap(p.x, grid), y: snap(p.y, grid) };
    }
    const si = sizes.findIndex((s) => s.id === p.id);
    if (si >= 0) {
      sizes[si] = { id: p.id, width: snap(p.width, grid), height: snap(p.height, grid) };
    }
  }

  // ── Frame viewport to fit all panels ──────────────────────
  const bbox = computeBoundingBox(swept, sizes);
  const { pan, zoom } = frameViewport(bbox, ctx.viewport.w, ctx.viewport.h);

  return {
    positions: swept,
    sizes,
    pan,
    zoom,
  };
}

// ── Overlap Sweep ────────────────────────────────────────────
// Multi-pass collision separation until resolved or max passes.
// Panels whose id is in `locked` are fixed obstacles: the sweep pushes
// movable panels away from them but never moves the locked panel itself.
function overlapSweep(
  positions: Array<{ id: string; x: number; y: number }>,
  sizes: Array<{ id: string; width: number; height: number }>,
  gap: number,
  grid: number,
  region: SafeRegion,
  locked: Set<string> = new Set(),
): Array<{ id: string; x: number; y: number }> {
  if (positions.length < 2) return positions.map((p) => ({
    id: p.id,
    x: snap(clamp(p.x, region.left, region.right - (sizes.find((s) => s.id === p.id)?.width ?? 320)), grid),
    y: snap(clamp(p.y, region.top, region.bottom - (sizes.find((s) => s.id === p.id)?.height ?? 200)), grid),
  }));

  const sizeMap = new Map(sizes.map((s) => [s.id, s]));
  const panels = positions.map((p) => {
    const s = sizeMap.get(p.id);
    return {
      id: p.id, x: p.x, y: p.y,
      w: s?.width ?? 520, h: s?.height ?? 360,
      locked: locked.has(p.id),
    };
  });

  const MAX_PASSES = 10;
  let anyMoved = true;

  for (let pass = 0; pass < MAX_PASSES && anyMoved; pass++) {
    anyMoved = false;
    // Panel ↔ panel separation
    for (let i = 0; i < panels.length; i++) {
      for (let j = i + 1; j < panels.length; j++) {
        const a = panels[i];
        const b = panels[j];
        const vec = separationVector(a, b, gap);
        if (!vec) continue;
        // Locked panels never move; the other side absorbs the full push.
        const aLocked = a.locked;
        const bLocked = b.locked;
        if (aLocked && bLocked) continue; // both pinned — leave as-is
        if (aLocked) {
          b.x -= vec.dx * 2; b.y -= vec.dy * 2;
        } else if (bLocked) {
          a.x += vec.dx * 2; a.y += vec.dy * 2;
        } else {
          a.x += vec.dx; a.y += vec.dy;
          b.x -= vec.dx; b.y -= vec.dy;
        }
        anyMoved = true;
      }
    }
  }

  return panels.map((p) => ({
    id: p.id,
    // Locked panels keep their exact (already-snapped) position; no clamp.
    x: p.locked ? snap(p.x, grid) : snap(clamp(p.x, region.left, region.right - p.w), grid),
    y: p.locked ? snap(p.y, grid) : snap(clamp(p.y, region.top, region.bottom - p.h), grid),
  }));
}

// ── Separation Vector ────────────────────────────────────────
interface PanelRect {
  id: string; x: number; y: number; w: number; h: number;
}
function rectsOverlap(a: PanelRect, b: PanelRect, pad: number): boolean {
  return !(a.x + a.w + pad <= b.x || b.x + b.w + pad <= a.x || a.y + a.h + pad <= b.y || b.y + b.h + pad <= a.y);
}
function separationVector(a: PanelRect, b: PanelRect, pad: number): { dx: number; dy: number } | null {
  if (!rectsOverlap(a, b, pad)) return null;
  const overlapX = Math.min(a.x + a.w + pad - b.x, b.x + b.w + pad - a.x);
  const overlapY = Math.min(a.y + a.h + pad - b.y, b.y + b.h + pad - a.y);
  if (overlapX < overlapY) {
    const sign = a.x < b.x ? 1 : -1;
    return { dx: overlapX * sign, dy: 0 };
  }
  const sign = a.y < b.y ? 1 : -1;
  return { dx: 0, dy: overlapY * sign };
}

// ── Bounding Box ─────────────────────────────────────────────
function computeBoundingBox(
  positions: Array<{ id: string; x: number; y: number }>,
  sizes: Array<{ id: string; width: number; height: number }>,
): { minX: number; minY: number; maxX: number; maxY: number } {
  if (positions.length === 0) return { minX: 0, minY: 0, maxX: 800, maxY: 600 };
  const sizeMap = new Map(sizes.map((s) => [s.id, s]));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of positions) {
    const s = sizeMap.get(p.id);
    const w = s?.width ?? 520;
    const h = s?.height ?? 360;
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x + w > maxX) maxX = p.x + w;
    if (p.y + h > maxY) maxY = p.y + h;
  }
  return { minX, minY, maxX, maxY };
}

// ── Find Spawn Slot ──────────────────────────────────────────
// Expanding-perimeter search from region center.
export function findSpawnSlot(
  existing: Array<{ x: number; y: number; w: number; h: number }>,
  region: SafeRegion,
  grid: number = 32,
  defaultCell?: { w: number; h: number },
): { x: number; y: number } {
  const cellW = defaultCell?.w ?? 520;
  const cellH = defaultCell?.h ?? 360;
  const gap = grid;

  const centerX = region.left + region.width / 2;
  const centerY = region.top + region.height / 2;
  const baseCol = Math.floor(centerX / (cellW + gap));
  const baseRow = Math.floor(centerY / (cellH + gap));

  const overlapsAny = (cx: number, cy: number): boolean =>
    existing.some((e) => !(cx + cellW + gap <= e.x || cx >= e.x + e.w + gap || cy + cellH + gap <= e.y || cy >= e.y + e.h + gap));

  for (let radius = 0; radius <= 20; radius++) {
    for (let row = baseRow - radius; row <= baseRow + radius; row++) {
      for (let col = baseCol - radius; col <= baseCol + radius; col++) {
        if (radius > 0 && Math.abs(col - baseCol) < radius && Math.abs(row - baseRow) < radius) continue;
        const cx = col * (cellW + gap);
        const cy = row * (cellH + gap);
        // Clamp to region
        const cxClamped = Math.max(region.left, Math.min(cx, region.right - cellW));
        const cyClamped = Math.max(region.top, Math.min(cy, region.bottom - cellH));
        if (!overlapsAny(cxClamped, cyClamped)) {
          return { x: snap(cxClamped, grid), y: snap(cyClamped, grid) };
        }
      }
    }
  }

  // Fallback: center of region
  return {
    x: snap(centerX - cellW / 2, grid),
    y: snap(centerY - cellH / 2, grid),
  };
}

// ── Compute bounding box from PanelItems ─────────────────────
export function computeBBoxFromPanels(
  items: PanelItem[],
): { minX: number; minY: number; maxX: number; maxY: number } {
  if (items.length === 0) return { minX: 0, minY: 0, maxX: 800, maxY: 600 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const item of items) {
    if (item.x < minX) minX = item.x;
    if (item.y < minY) minY = item.y;
    if (item.x + item.width > maxX) maxX = item.x + item.width;
    if (item.y + item.height > maxY) maxY = item.y + item.height;
  }
  return { minX, minY, maxX, maxY };
}
