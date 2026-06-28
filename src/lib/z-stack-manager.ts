// ── ORCH Z-Stack Manager ─────────────────────────────────────
// Central layering contract for every surface in the app.
//
// No component hardcodes zIndex values — they call computePanelZIndex
// which reads the panel's base layer, applies elevation for drag/focus,
// and resolves sub-layer ordering from the registry's zStack.

/** Immutable layering zones — panels declare their baseZIndex from these. */
export const Z_BASE_LAYERS = {
  /** Canvas background grid */
  canvasBackground: 0,
  /** Dropped images on canvas */
  canvasImages: 7,
  /** Drawing layer when tool is NOT active (pass-through) */
  drawingInactive: 8,
  /** Vector/shape layer when tool is NOT active */
  vectorInactive: 9,
  /** Agent card in default (unselected) state */
  agentDefault: 10,
  /** Agent card when selected/focused */
  agentSelected: 100,
  /** Canvas text and image elements */
  canvasElements: 60,
  /** Eraser tool overlay */
  eraserOverlay: 200,
  /** Canvas toolbar (left) and properties panel (right) */
  chromeToolbar: 200,
  /** BrowserPreview panel (normal state) */
  browserDefault: 500,
  /** MusicPlayer panel (normal state) */
  musicDefault: 600,
  /** Minimap PiP */
  minimap: 100,
  /** Zoom controls */
  zoomControls: 110,
  /** PillBar — always-on-top chrome */
  pillBar: 1000,
  /** Dropdown menus inside PillBar */
  dropdown: 2000,
  /** Modal dialogs */
  modal: 5000,
  /** Any panel being dragged (temporary, overrides base) */
  canvasDragging: 1000,
  /** Fixed overlay being dragged */
  overlayDragging: 9999,
} as const;

/**
 * Compute the effective z-index for a panel given its base layer,
 * current interaction state, and z-stack position.
 *
 * Rules:
 *  - Dragging/resizing panels jump to the drag layer for their space.
 *  - Focused panels get +90 above their base (just below drag layer).
 *  - Within the same base layer, zStack order provides sub-layering
 *    so the most recently clicked panel appears on top.
 */
export function computePanelZIndex(
  panelId: string,
  space: 'canvas' | 'fixed' | 'chrome' | 'modal',
  baseZIndex: number,
  focusable: boolean,
  activePanelId: string | null,
  dragPanelId: string | null,
  resizePanelId: string | null,
  zStack: string[],
): number {
  // 1. Dragging — use the drag layer for the panel's space
  if (panelId === dragPanelId || panelId === resizePanelId) {
    if (space === 'canvas') return Z_BASE_LAYERS.canvasDragging;
    if (space === 'fixed') return Z_BASE_LAYERS.overlayDragging;
    return Z_BASE_LAYERS.overlayDragging; // catch-all for floating elements
  }

  // 2. Focus elevation — active panel gets a bump
  let z = baseZIndex;
  if (panelId === activePanelId && focusable) {
    z = baseZIndex + 90; // Just below the lowest drag layer (1000 - 90 = 910)
  }

  // 3. Sub-layer ordering via zStack position — ensures click order is preserved
  //    within the same base layer. Each panel gets +1 for each position in stack.
  const stackPos = zStack.indexOf(panelId);
  if (stackPos !== -1) {
    // Cap sub-layer at 50 to avoid bleeding into next layer
    z += Math.min(stackPos, 50);
  }

  return z;
}
