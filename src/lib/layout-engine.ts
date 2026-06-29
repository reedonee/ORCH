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

/** Measured chrome insets injected at runtime. When provided, overrides
 *  the static CHROME constant — allows dynamic adaptation when pill bar
 *  height changes or notification banners appear. */
export interface ChromeInsets {
  topBarBottom: number;
  bottomBarTop: number;
  leftReserved: number;
  rightReserved: number;
}

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
  /** Optional live chrome measurements; when provided, computeSafeRegion
   *  uses actual DOM positions instead of the hardcoded CHROME constant. */
  chromeInsets?: ChromeInsets;
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
// Accepts optional dynamic chrome insets; when provided, overrides
// the static CHROME constant. Also guards against zero/negative regions.
export function computeSafeRegion(
  vw: number,
  vh: number,
  grid: number = 32,
  chrome?: ChromeInsets,
): SafeRegion {
  const PADDING = 16; // outer breathing room — half of grid unit

  let top = chrome
    ? chrome.topBarBottom + PADDING
    : CHROME.pillBar.top + CHROME.pillBar.height + PADDING;
  let bottom = chrome
    ? chrome.bottomBarTop - PADDING
    : vh - CHROME.chatBar.bottom - CHROME.chatBar.height - PADDING;
  let left = chrome
    ? chrome.leftReserved + PADDING
    : CHROME.leftReserved + PADDING;
  let right = chrome
    ? vw - chrome.rightReserved - PADDING
    : vw - PADDING;
  let w = Math.max(0, right - left);
  let h = Math.max(0, bottom - top);

  // Minimum region guard: if safe area is too small to fit 2 cells,
  // expand the boundaries outward to prevent zero/negative dimensions
  // which produce NaN positions downstream. This expands region.right
  // and region.bottom so that w and h remain consistent with left/right/top/bottom.
  const MIN_REGION_W = 320 * 2 + grid; // 672
  const MIN_REGION_H = 200 * 2 + grid; // 432
  if (w < MIN_REGION_W) {
    const deficit = MIN_REGION_W - w;
    right += deficit;
    w = MIN_REGION_W;
  }
  if (h < MIN_REGION_H) {
    const deficit = MIN_REGION_H - h;
    bottom += deficit;
    h = MIN_REGION_H;
  }

  return {
    top, bottom, left, right,
    width: w,
    height: h,
  };
}

// ── Adaptive Cell Size ────────────────────────────────────────
// Single uniform cell size for agent-grid rows.
// Column count: 1→1, 2→2 (side by side), 3-4→2 cols, 5+→3 cols.
// Divides available space evenly, snaps DOWN to grid, fills region.
export function computeAdaptiveCellSize(
  count: number,
  region: SafeRegion,
  grid: number = 32,
  gap: number = 32,
): { w: number; h: number } {
  const cols = count === 1 ? 1
             : count === 2 ? 2
             : count <= 4 ? 2
             : count <= 6 ? 3
             : 3;

  const rows = Math.ceil(count / cols);

  // Available space minus all inter-cell gaps
  const availW = region.right - region.left - (cols - 1) * gap;
  const availH = region.bottom - region.top - (rows - 1) * gap;

  // Divide evenly per cell, snap DOWN to grid to guarantee no overflow
  const rawW = Math.floor(availW / cols);
  const rawH = Math.floor(availH / rows);
  const cellW = Math.floor(rawW / 32) * 32;
  const cellH = Math.floor(rawH / 32) * 32;

  return {
    w: Math.max(320, Math.min(1000, cellW)),
    h: Math.max(240, Math.min(800, cellH)),
  };
}

// ── Shelf Pack (grid-based adaptive) ───────────────────────────
// Grid-positions panels using adaptive cell sizes computed from
// the region and panel count. Centers the entire grid within the
// safe region. Returns positions WITH sizes so the caller doesn't
// need to reconstruct them separately.
export function shelfPack(
  items: PanelItem[],
  region: SafeRegion,
  gap: number = 32,
  grid: number = 32,
  cellOverride?: { w: number; h: number },
): Array<{ id: string; x: number; y: number; width: number; height: number }> {
  if (items.length === 0) return [];

  const n = items.length;
  const cell = cellOverride ?? computeAdaptiveCellSize(n, region, gap);
  const cols = n === 1 ? 1 : n === 2 ? 2 : n <= 4 ? 2 : 3;
  const rows = Math.ceil(n / cols);

  // Total grid dimensions
  const gridW = cols * cell.w + (cols - 1) * gap;
  const gridH = rows * cell.h + (rows - 1) * gap;

  // Center the WHOLE grid within the safe region.
  // startX/startY are the top-left corner of the grid block.
  const startX = Math.round(region.left + (region.width - gridW) / 2);
  const startY = Math.round(region.top + (region.height - gridH) / 2);

  return items.map((item, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const w = item.naturalW ?? cell.w;
    const h = item.naturalH ?? cell.h;
    return {
      id: item.id,
      x: Math.round(startX + col * (cell.w + gap)),
      y: Math.round(startY + row * (cell.h + gap)),
      width: w,
      height: h,
    };
  });
}

// ── Hero Layout (single node) ────────────────────────────────
// Centered, ~72% width, ~85% height, capped at 880×700.
// Only used when the sole visible panel is an agent with no other
// auto-layout panels present (music, forge etc. will use shelfPack).
export function heroLayout(
  item: PanelItem,
  region: SafeRegion,
  grid: number = 32,
): { x: number; y: number; width: number; height: number } {
  const HERO_MAX_W = 880;
  const HERO_MAX_H = 700;
  const w = snap(Math.min(HERO_MAX_W, region.width * 0.72), grid);
  const h = snap(Math.min(HERO_MAX_H, region.height * 0.85), grid);
  return {
    x: snap(region.left + (region.width - w) / 2, grid),
    y: snap(region.top + (region.height - h) / 2, grid),
    width: w,
    height: h,
  };
}

// ── Stage Layout (browser open) ──────────────────────────────
// Browser takes left portion (min 480px), full safe height.
// Other nodes (+music) shelfPack into the right half as sub-grid.
// Returns { results, rightRegion } so the caller can clamp
// non-browser panels against the browser's right edge.
export function stageLayout(
  browser: PanelItem,
  others: PanelItem[],
  region: SafeRegion,
  gap: number = 32,
  grid: number = 32,
): {
  results: Array<{ id: string; x: number; y: number; width: number; height: number }>;
  rightRegion: SafeRegion;
} {
  const results: Array<{ id: string; x: number; y: number; width: number; height: number }> = [];

  const BROWSER_MIN_W = 480;
  const browserRatio = Math.max(BROWSER_MIN_W / region.width, 0.5);
  // If browser would take > 75% of safe region, fall through to shelf-pack
  if (browserRatio >= 0.75) {
    const allPanels = [browser, ...others];
    const shelf = shelfPack(allPanels, region, gap, grid);
    return {
      results: shelf.map((r) => ({ id: r.id, x: r.x, y: r.y, width: r.width, height: r.height })),
      rightRegion: region,
    };
  }

  const browserW = snap(region.width * browserRatio, grid);
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

  return { results, rightRegion };
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
  const region = computeSafeRegion(ctx.viewport.w, ctx.viewport.h, grid, ctx.chromeInsets);

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
    // Hero mode: single agent, no other auto-layout panels present
    const hero = heroLayout(agents[0], region, grid);
    positions = [{ id: agents[0].id, x: hero.x, y: hero.y }];
    sizes = [{ id: agents[0].id, width: hero.width, height: hero.height }];
  } else if (ctx.browserVisible && browser) {
    // Stage mode: browser left, agents + music right
    const others = ctx.panels.filter((p) => p.id !== browser.id);
    const stageResult = stageLayout(browser, others, region, gap, grid);
    const { results: stageResults, rightRegion } = stageResult;
    positions = stageResults.map((r) => ({ id: r.id, x: r.x, y: r.y }));
    sizes = stageResults.map((r) => ({ id: r.id, width: r.width, height: r.height }));
    // Override region clamp for non-browser panels so overlapSweep doesn't
    // push them left into the browser column — browser's right edge is a hard wall
    if (rightRegion !== region) {
      // Store rightRegion as a metadata flag for the sweep
      (region as any)._rightOnlyForIds = new Set(others.map((o) => o.id));
      (region as any)._rightClamp = rightRegion;
    }
  } else {
    // Default: grid-based shelfPack with adaptive cells
    const shelved = ctx.panels.map((p) => ({
      ...p,
      // Pass natural size overrides so non-agent panels can be different sizes
      naturalW: p.naturalW ?? p.width,
      naturalH: p.naturalH ?? p.height,
    }));
    const packed = shelfPack(shelved, region, gap, grid);
    positions = packed.map((r) => ({ id: r.id, x: r.x, y: r.y }));
    sizes = packed.map((r) => ({ id: r.id, width: r.width, height: r.height }));
  }

  // ── Final overlap-sweep pass ──────────────────────────────
  // Defensive: run micro-tidy collision resolution using the FRESH sizes
  // from this layout pass (NOT from ctx.panels which may have stale registry sizes).
  const lockedSet = new Set(ctx.panels.filter((p) => p.locked).map((p) => p.id));
  const swept = overlapSweep(positions, sizes, gap, grid, region, lockedSet);

  // NaN/zero guard — if any position or size is NaN/Infinity/<=0, clamp to region defaults
  for (let k = 0; k < positions.length; k++) {
    const pos = positions[k];
    const sz = sizes.find((s) => s.id === pos.id);
    if (!isFinite(pos.x) || !isFinite(pos.y) || (sz && (!isFinite(sz.width) || sz.width <= 0 || !isFinite(sz.height) || sz.height <= 0))) {
      console.warn('[Layout] NaN/zero detected in layout result, clamping to fallback', pos, sz);
      pos.x = region.left;
      pos.y = region.top;
      if (sz) { sz.width = 520; sz.height = 360; }
    }
  }

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

  const MAX_PASSES = 20;
  let anyMoved = true;

  // Detect stage-mode rightRegion — non-browser panels in stage mode must
  // clamp to the right sub-region to prevent drift into the browser column.
  const rightClamp = (region as any)._rightClamp as SafeRegion | undefined;
  const rightOnlyIds = (region as any)._rightOnlyForIds as Set<string> | undefined;

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

    // Clamp every panel to region after each pass — prevents cascade drift.
    // In stage mode, non-browser panels clamp to rightRegion (browser's right edge = hard wall).
    for (let k = 0; k < panels.length; k++) {
      if (!panels[k].locked) {
        const r = (rightClamp && rightOnlyIds?.has(panels[k].id)) ? rightClamp : region;
        panels[k].x = clamp(panels[k].x, r.left, r.right - panels[k].w);
        panels[k].y = clamp(panels[k].y, r.top, r.bottom - panels[k].h);
      }
    }

    // Index-based jitter on stall: inject deterministic tie-break to break
    // symmetric push cancellation where two same-sized panels push against each
    // other and their separation vectors cancel out.
    if (pass >= 2 && !anyMoved) {
      for (let i = 0; i < panels.length && !anyMoved; i++) {
        for (let j = i + 1; j < panels.length && !anyMoved; j++) {
          const a = panels[i];
          const b = panels[j];
          if (!rectsOverlap({ id: a.id, x: a.x, y: a.y, w: a.w, h: a.h }, { id: b.id, x: b.x, y: b.y, w: b.w, h: b.h }, gap)) continue;
          // Jitter: offset by (index diff) * grid/2 along the secondary axis
          const jitter = (i - j) * (grid / 2);
          if (Math.abs(a.x - b.x) < Math.abs(a.y - b.y)) {
            panels[i].x += jitter; // horizontal separation stalling → nudge vertically
          } else {
            panels[i].y += jitter; // vertical separation stalling → nudge horizontally
          }
          anyMoved = true;
        }
      }
      break;
    }
  }

  // ── Post-sweep validation ─────────────────────────────────────
  // Final O(n²) scan. If any pair still overlaps by > 2px, do one
  // emergency separation on the Y axis and log a warning.
  let warningEmitted = false;
  for (let i = 0; i < panels.length && !warningEmitted; i++) {
    for (let j = i + 1; j < panels.length && !warningEmitted; j++) {
      const a = panels[i];
      const b = panels[j];
      if (!rectsOverlap({ id: a.id, x: a.x, y: a.y, w: a.w, h: a.h }, { id: b.id, x: b.x, y: b.y, w: b.w, h: b.h }, gap)) continue;
      // Emergency Y-axis separation: push the lower-indexed panel up
      const overlapY = Math.min(a.y + a.h + gap - b.y, b.y + b.h + gap - a.y);
      if (a.y < b.y) {
        a.y -= overlapY;
      } else {
        b.y -= overlapY;
      }
      if (!warningEmitted) {
        console.warn('[Layout] Post-sweep emergency separation applied — overlap detected after convergence');
        warningEmitted = true;
      }
    }
  }

  return panels.map((p) => ({
    id: p.id,
    // Locked panels keep their exact (already-snapped) position; no clamp.
    x: p.locked ? snap(p.x, grid) : (() => {
      const r = (rightClamp && rightOnlyIds?.has(p.id)) ? rightClamp : region;
      return snap(clamp(p.x, r.left, r.right - p.w), grid);
    })(),
    y: p.locked ? snap(p.y, grid) : (() => {
      const r = (rightClamp && rightOnlyIds?.has(p.id)) ? rightClamp : region;
      return snap(clamp(p.y, r.top, r.bottom - p.h), grid);
    })(),
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
    const sign = a.x < b.x ? -1 : 1;
    return { dx: (overlapX / 2) * sign, dy: 0 };
  }
  const sign = a.y < b.y ? -1 : 1;
  return { dx: 0, dy: (overlapY / 2) * sign };
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
// Expanding-perimeter search from viewport center (or region center as fallback).
// `viewportCenter` should be in canvas-space coordinates.
export function findSpawnSlot(
  existing: Array<{ x: number; y: number; w: number; h: number }>,
  region: SafeRegion,
  grid: number = 32,
  defaultCell?: { w: number; h: number },
  viewportCenter?: { x: number; y: number },
): { x: number; y: number } {
  const cellW = defaultCell?.w ?? 520;
  const cellH = defaultCell?.h ?? 360;
  const gap = grid;

  const centerX = viewportCenter?.x ?? (region.left + region.width / 2);
  const centerY = viewportCenter?.y ?? (region.top + region.height / 2);
  const baseCol = Math.floor(centerX / (cellW + gap));
  const baseRow = Math.floor(centerY / (cellH + gap));

  const overlapsAny = (cx: number, cy: number): boolean =>
    existing.some((e) => !(cx + cellW + gap <= e.x || cx >= e.x + e.w + gap || cy + cellH + gap <= e.y || cy >= e.y + e.h + gap));

  for (let radius = 0; radius <= 40; radius++) {
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

  // Fallback: center of viewport (or region)
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
