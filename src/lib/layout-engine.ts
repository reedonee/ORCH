// ── ORCH Layout Engine — viewport & region math ─────────────────
// Pure functions — no React, no Zustand.
//
// This module owns the *frame*: where the usable canvas area is, and how
// to point the camera at a set of panels. The placement algorithms —
// deciding where each card goes — live in layout-modes.ts.
//
// The previous shelf-pack/hero/stage placement functions and their
// 20-pass overlap sweep were removed once layout-modes.ts replaced them;
// keeping two placement engines around is how they drift apart.

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
// The rectangle of canvas not covered by chrome. Accepts optional
// measured insets; when provided they override the static CHROME
// constant. Guards against zero/negative regions, which would otherwise
// produce NaN geometry downstream.
export function computeSafeRegion(
  vw: number,
  vh: number,
  grid: number = 32,
  chrome?: ChromeInsets,
): SafeRegion {
  const PADDING = 16; // outer breathing room — half of a grid unit

  const top = chrome
    ? chrome.topBarBottom + PADDING
    : CHROME.pillBar.top + CHROME.pillBar.height + PADDING;
  let bottom = chrome
    ? chrome.bottomBarTop - PADDING
    : vh - CHROME.chatBar.bottom - CHROME.chatBar.height - PADDING;
  const left = chrome
    ? chrome.leftReserved + PADDING
    : CHROME.leftReserved + PADDING;
  let right = chrome
    ? vw - chrome.rightReserved - PADDING
    : vw - PADDING;

  let w = Math.max(0, right - left);
  let h = Math.max(0, bottom - top);

  // Minimum region guard: expand outward rather than returning a
  // degenerate rectangle. right/bottom are moved so width/height stay
  // consistent with the edges.
  const MIN_REGION_W = 320 * 2 + grid;
  const MIN_REGION_H = 200 * 2 + grid;
  if (w < MIN_REGION_W) {
    right += MIN_REGION_W - w;
    w = MIN_REGION_W;
  }
  if (h < MIN_REGION_H) {
    bottom += MIN_REGION_H - h;
    h = MIN_REGION_H;
  }

  return { top, bottom, left, right, width: w, height: h };
}

// ── Frame Viewport ───────────────────────────────────────────
// Computes pan + zoom to fit a bounding box into the window.
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

// ── Find Spawn Slot ──────────────────────────────────────────
// Expanding-perimeter search outward from the viewport centre, so a new
// agent appears near where the user is looking rather than at a fixed
// origin. `viewportCenter` is in canvas-space coordinates.
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
    existing.some((e) =>
      !(cx + cellW + gap <= e.x || cx >= e.x + e.w + gap ||
        cy + cellH + gap <= e.y || cy >= e.y + e.h + gap));

  for (let radius = 0; radius <= 40; radius++) {
    for (let row = baseRow - radius; row <= baseRow + radius; row++) {
      for (let col = baseCol - radius; col <= baseCol + radius; col++) {
        // Only walk the perimeter of each ring; the interior was covered
        // by a smaller radius already.
        if (radius > 0 && Math.abs(col - baseCol) < radius && Math.abs(row - baseRow) < radius) continue;

        const cx = Math.max(region.left, Math.min(col * (cellW + gap), region.right - cellW));
        const cy = Math.max(region.top, Math.min(row * (cellH + gap), region.bottom - cellH));
        if (!overlapsAny(cx, cy)) {
          return { x: snap(cx, grid), y: snap(cy, grid) };
        }
      }
    }
  }

  // Fallback: centre of the viewport.
  return {
    x: snap(centerX - cellW / 2, grid),
    y: snap(centerY - cellH / 2, grid),
  };
}
