// ── ORCH Coordinate Space Mapper ─────────────────────────────
// Converts between canvas-space and window-space coordinates.
//
// Canvas-space:  the logical coordinate system where agent cards live,
//                transformed by pan (translate) and zoom (scale).
// Window-space:  the physical pixel coordinate system (position: fixed).
//
// The layout engine works in canvas-space. Fixed overlays (Browser,
// MusicPlayer) must be projected into canvas-space for collision
// detection and framing calculations.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PanZoom {
  pan: { x: number; y: number };
  zoom: number;
}

/**
 * Convert a window-space rect to canvas-space.
 * Inverse of the canvas transform: translate(panX, panY) scale(zoom).
 */
export function windowToCanvas(
  rect: Rect,
  viewport: PanZoom,
): Rect {
  return {
    x: (rect.x - viewport.pan.x) / viewport.zoom,
    y: (rect.y - viewport.pan.y) / viewport.zoom,
    w: rect.w / viewport.zoom,
    h: rect.h / viewport.zoom,
  };
}

/**
 * Convert a canvas-space rect to window-space.
 * Applies the canvas transform: translate(panX, panY) scale(zoom).
 */
export function canvasToWindow(
  rect: Rect,
  viewport: PanZoom,
): Rect {
  return {
    x: rect.x * viewport.zoom + viewport.pan.x,
    y: rect.y * viewport.zoom + viewport.pan.y,
    w: rect.w * viewport.zoom,
    h: rect.h * viewport.zoom,
  };
}

/**
 * Helper: convert a single coordinate from window-space to canvas-space.
 */
export function windowToCanvasPoint(
  wx: number,
  wy: number,
  viewport: PanZoom,
): { x: number; y: number } {
  return {
    x: (wx - viewport.pan.x) / viewport.zoom,
    y: (wy - viewport.pan.y) / viewport.zoom,
  };
}

/**
 * Helper: convert a single coordinate from canvas-space to window-space.
 */
export function canvasToWindowPoint(
  cx: number,
  cy: number,
  viewport: PanZoom,
): { x: number; y: number } {
  return {
    x: cx * viewport.zoom + viewport.pan.x,
    y: cy * viewport.zoom + viewport.pan.y,
  };
}

/**
 * Compute the bounding box of multiple rects (in the same coordinate space).
 * Returns zero rect if the input is empty.
 */
export function boundingBox(rects: Rect[]): Rect {
  if (rects.length === 0) return { x: 0, y: 0, w: 800, h: 600 };

  let minX = Infinity, minY = Infinity;
  let maxX = -Infinity, maxY = -Infinity;

  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (r.x < minX) minX = r.x;
    if (r.y < minY) minY = r.y;
    if (r.x + r.w > maxX) maxX = r.x + r.w;
    if (r.y + r.h > maxY) maxY = r.y + r.h;
  }

  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
