// ── ORCH Viewport Edge Constraints ───────────────────────────
// Ensures panels remain meaningfully visible within the viewport.
//
// After any position change (drag end, auto-arrange, viewport resize),
// constrain the panel so that at least `minVisiblePx` of it stays
// inside the visible area.

import type { Rect } from './space-mapper';

/**
 * Clamp a panel's position so it doesn't drift completely off-screen.
 *
 * `minVisiblePx` controls how many pixels of the panel must remain
 * inside the viewport on each axis. Default 40px gives a visible
 * edge so the user can grab and re-drag it back.
 */
export function clampPanelToViewport(
  panel: Rect,
  viewportW: number,
  viewportH: number,
  minVisiblePx: number = 40,
): { x: number; y: number } {
  let { x, y, w, h } = panel;

  // ── Horizontal constraint ──────────────────────────────────
  // Left edge: can't push more than (w - minVisiblePx) off-screen to the left
  if (x < -(w - minVisiblePx)) {
    x = -(w - minVisiblePx);
  }
  // Right edge: can't push more than (w - minVisiblePx) off-screen to the right
  if (x > viewportW - minVisiblePx) {
    x = viewportW - minVisiblePx;
  }

  // ── Vertical constraint ────────────────────────────────────
  // Top edge
  if (y < -(h - minVisiblePx)) {
    y = -(h - minVisiblePx);
  }
  // Bottom edge
  if (y > viewportH - minVisiblePx) {
    y = viewportH - minVisiblePx;
  }

  return { x, y };
}

/**
 * Resolve all panels in a list so none escape the viewport.
 * Returns a map of id → {x, y} for panels that were clamped.
 */
export function clampAllPanels(
  panels: Array<{ id: string; x: number; y: number; width: number; height: number }>,
  viewportW: number,
  viewportH: number,
  minVisiblePx?: number,
): Record<string, { x: number; y: number }> {
  const result: Record<string, { x: number; y: number }> = {};

  for (let i = 0; i < panels.length; i++) {
    const p = panels[i];
    const clamped = clampPanelToViewport(
      { x: p.x, y: p.y, w: p.width, h: p.height },
      viewportW,
      viewportH,
      minVisiblePx,
    );
    if (clamped.x !== p.x || clamped.y !== p.y) {
      result[p.id] = clamped;
    }
  }

  return result;
}

// ── Canvas-space clamping ────────────────────────────────────
// Agent cards live in canvas-space (logical coords transformed by
// pan/zoom). To keep an agent visible we must clamp against the
// CANVAS-space view rectangle, not window pixels.

export interface CanvasView {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Derive the currently-visible canvas-space rectangle from the viewport
 * transform. `viewLeft = -pan.x / zoom`, etc.
 */
export function canvasViewFromViewport(
  pan: { x: number; y: number },
  zoom: number,
  vw: number,
  vh: number,
): CanvasView {
  return {
    left: -pan.x / zoom,
    top: -pan.y / zoom,
    right: (vw - pan.x) / zoom,
    bottom: (vh - pan.y) / zoom,
  };
}

/**
 * Clamp a canvas-space panel so at least `minVisiblePx` of it stays
 * inside the given canvas view. Returns the clamped {x, y}.
 *
 * This is the defensive guardrail the layout engine runs after every
 * arrange pass — it catches obstacle-collision pushes that would
 * otherwise animate a panel to a spot the user can't currently see.
 */
export function clampCanvasPanel(
  panel: { x: number; y: number; w: number; h: number },
  view: CanvasView,
  minVisiblePx: number = 60,
): { x: number; y: number } {
  let { x, y, w, h } = panel;
  const viewW = view.right - view.left;
  const viewH = view.bottom - view.top;

  // Horizontal — keep at least minVisiblePx inside [view.left, view.right]
  if (x < view.left - (w - minVisiblePx)) x = view.left - (w - minVisiblePx);
  if (x > view.right - minVisiblePx) x = view.right - minVisiblePx;
  // Vertical
  if (y < view.top - (h - minVisiblePx)) y = view.top - (h - minVisiblePx);
  if (y > view.bottom - minVisiblePx) y = view.bottom - minVisiblePx;

  // If the view is smaller than the panel, anchor to the view origin to
  // avoid oscillation when extremely zoomed in.
  if (viewW < w) x = view.left;
  if (viewH < h) y = view.top;

  return { x, y };
}

/**
 * Apply canvas-space clamping to a batch of position records.
 * Returns a new array with clamped coordinates.
 */
export function clampCanvasPositions(
  positions: Array<{ id: string; x: number; y: number; width: number; height: number }>,
  view: CanvasView,
  minVisiblePx?: number,
): Array<{ id: string; x: number; y: number }> {
  const result: Array<{ id: string; x: number; y: number }> = [];
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    const clamped = clampCanvasPanel(
      { x: p.x, y: p.y, w: p.width, h: p.height },
      view,
      minVisiblePx,
    );
    result.push({ id: p.id, x: clamped.x, y: clamped.y });
  }
  return result;
}
