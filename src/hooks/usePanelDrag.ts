// ── ORCH Unified Panel Drag/Resize Hook ─────────────────────
// Single source of drag + resize behaviour for every panel type.
//
// PRINCIPLES:
//   - Local state during manipulation (zero store writes on mousemove)
//   - Commit + snap + clamp on mouseup
//   - Coordinates with the panel registry for z-stack/drag lifecycle
//   - Canvas-space panels snap to grid; fixed panels don't
//   - Edge constraint prevents panels from going fully off-screen
//
// USAGE:
//   const { dragHandlers, resizeHandlers, positionStyle, isDragging, isResizing }
//     = usePanelDrag({ panelId: agent.id, snapToGrid: 32 });

import { useState, useRef, useEffect, useCallback } from 'react';
import { usePanelRegistry } from '../stores/usePanelRegistry';
import { clampPanelToViewport } from '../lib/viewport-constraints';

export interface UsePanelDragOptions {
  /** Panel ID in the registry (e.g. agent.id, 'browser', 'music') */
  panelId: string;
  /** Snap interval in px (null = no snap) */
  snapToGrid?: number;
  /** Min visible px after clamping (default 40) */
  edgeConstraint?: number;
}

export interface UsePanelDragReturn {
  /** Bind to the draggable region (title bar) */
  dragHandlers: {
    onMouseDown: (e: React.MouseEvent) => void;
  };
  /** Bind to the resize handle (bottom-right corner) */
  resizeHandlers: {
    onMouseDown: (e: React.MouseEvent) => void;
  };
  /** Position + size style — spread onto the panel's wrapper div */
  positionStyle: React.CSSProperties;
  /** Resolved CSS transition string for this panel (engine-aware) */
  transition: string;
  /** Whether this panel is currently being dragged */
  isDragging: boolean;
  /** Whether this panel is currently being resized */
  isResizing: boolean;
}

// Premium default motion — used whenever the engine hasn't pinned a
// specific token (true idle). Keeps every programmatic move graceful
// instead of snapping. Mirrors the layout engine's deceleration curve.
const DEFAULT_MOTION_TRANSITION =
  'left 320ms cubic-bezier(0.16, 1, 0.3, 1), top 320ms cubic-bezier(0.16, 1, 0.3, 1), ' +
  'width 320ms cubic-bezier(0.16, 1, 0.3, 1), height 320ms cubic-bezier(0.16, 1, 0.3, 1)';

export function usePanelDrag(options: UsePanelDragOptions): UsePanelDragReturn {
  const { panelId, snapToGrid, edgeConstraint } = options;

  // ── Read panel from registry ───────────────────────────────
  // Selector is refined per field to avoid unnecessary re-renders.
  const panel = usePanelRegistry((s) => s.panels[panelId]);
  const dragPanelId = usePanelRegistry((s) => s.dragPanelId);
  const resizePanelId = usePanelRegistry((s) => s.resizePanelId);
  const beginDrag = usePanelRegistry((s) => s.beginDrag);
  const endDrag = usePanelRegistry((s) => s.endDrag);
  const beginResize = usePanelRegistry((s) => s.beginResize);
  const endResize = usePanelRegistry((s) => s.endResize);
  const updatePanel = usePanelRegistry((s) => s.updatePanel);
  const bringToFront = usePanelRegistry((s) => s.bringToFront);
  // ── Engine motion token (the layout engine drives this) ────
  const motionTransition = usePanelRegistry((s) => s.layoutMotion.transition);

  const isDragging = dragPanelId === panelId;
  const isResizing = resizePanelId === panelId;

  // ── Local state — zero store writes during manipulation ────
  // null = using registry values; {x,y,w,h} = actively dragging/resizing
  const [local, setLocal] = useState<{
    x: number; y: number; w: number; h: number;
  } | null>(null);

  // Derive display values: local during manipulation, registry otherwise
  const displayX = local !== null ? local.x : (panel?.x ?? 0);
  const displayY = local !== null ? local.y : (panel?.y ?? 0);
  const displayW = local !== null ? local.w : (panel?.width ?? 520);
  const displayH = local !== null ? local.h : (panel?.height ?? 360);

  // ── Refs ─────────────────────────────────────────────────
  const dragRef = useRef({
    sx: 0, sy: 0,  // start mouse position
    startX: 0, startY: 0,  // start panel position
  });
  const resizeRef = useRef({
    sx: 0, sy: 0,
    startW: 0, startH: 0,
  });
  // Keep a ref to latest display values for closures
  const displayRef = useRef({ x: displayX, y: displayY, w: displayW, h: displayH });
  displayRef.current = { x: displayX, y: displayY, w: displayW, h: displayH };

  // ── DRAG ────────────────────────────────────────────────────
  useEffect(() => {
    if (!isDragging) return;

    // Capture starting position once
    const start = dragRef.current;

    const onMove = (e: MouseEvent) => {
      const dx = e.clientX - start.sx;
      const dy = e.clientY - start.sy;
      setLocal({
        x: start.startX + dx,
        y: start.startY + dy,
        w: displayRef.current.w,
        h: displayRef.current.h,
      });
    };

    const onUp = () => {
      // Snapshot final local position
      const finalX = displayRef.current.x;
      const finalY = displayRef.current.y;
      const finalW = displayRef.current.w;
      const finalH = displayRef.current.h;

      // Snap to grid (for canvas-space panels)
      let snappedX = finalX;
      let snappedY = finalY;
      if (snapToGrid && snapToGrid > 0) {
        snappedX = Math.round(finalX / snapToGrid) * snapToGrid;
        snappedY = Math.round(finalY / snapToGrid) * snapToGrid;
      }

      // Edge clamp (only for fixed-space panels; canvas panels pan freely)
      let clampedX = snappedX;
      let clampedY = snappedY;
      if (panel?.space === 'fixed') {
        const viewportW = window.innerWidth;
        const viewportH = window.innerHeight;
        const clamped = clampPanelToViewport(
          { x: snappedX, y: snappedY, w: finalW, h: finalH },
          viewportW,
          viewportH,
          edgeConstraint ?? 40,
        );
        clampedX = clamped.x;
        clampedY = clamped.y;
      }

      // Commit to registry
      updatePanel(panelId, { x: clampedX, y: clampedY });
      endDrag();
      setLocal(null);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [isDragging, panelId, snapToGrid, edgeConstraint, updatePanel, endDrag]);

  // ── RESIZE ──────────────────────────────────────────────────
  useEffect(() => {
    if (!isResizing) return;

    const start = resizeRef.current;
    const minW = panel?.minWidth ?? 180;
    const minH = panel?.minHeight ?? 120;

    const onMove = (e: MouseEvent) => {
      const dw = e.clientX - start.sx;
      const dh = e.clientY - start.sy;
      // Track the cursor 1:1 during the gesture (no snapping yet)
      setLocal({
        x: displayRef.current.x,
        y: displayRef.current.y,
        w: Math.max(minW, start.startW + dw),
        h: Math.max(minH, start.startH + dh),
      });
    };

    const onUp = () => {
      // Snap the final dimensions to the grid so the commit lands clean
      let finalW = displayRef.current.w;
      let finalH = displayRef.current.h;
      if (snapToGrid && snapToGrid > 0) {
        finalW = Math.max(minW, Math.round(finalW / snapToGrid) * snapToGrid);
        finalH = Math.max(minH, Math.round(finalH / snapToGrid) * snapToGrid);
      }
      // Commit the new size to the registry.
      // The panel-registry→originating-store sync (appStore/browserStore/musicStore)
      // is owned by each component; we only write the canonical registry here.
      updatePanel(panelId, { width: finalW, height: finalH });
      // Mark this panel as user-pinned so the layout engine does NOT
      // immediately re-arrange and snap it back to the adaptive cell size.
      usePanelRegistry.getState().updatePanel(panelId, { locked: true });
      endResize();
      setLocal(null);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [isResizing, panelId, snapToGrid, panel?.minWidth, panel?.minHeight, updatePanel, endResize]);

  // ── Handlers ────────────────────────────────────────────────

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    // Respect no-drag regions (buttons, inputs inside the title bar)
    if ((e.target as HTMLElement).closest('.no-drag')) return;
    e.preventDefault();
    e.stopPropagation();

    // Capture start state from registry
    const p = usePanelRegistry.getState().panels[panelId];
    dragRef.current = {
      sx: e.clientX,
      sy: e.clientY,
      startX: p?.x ?? 0,
      startY: p?.y ?? 0,
    };

    // Bring to front + begin drag
    bringToFront(panelId);
    beginDrag(panelId);
  }, [panelId, bringToFront, beginDrag]);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const p = usePanelRegistry.getState().panels[panelId];
    resizeRef.current = {
      sx: e.clientX,
      sy: e.clientY,
      startW: p?.width ?? 520,
      startH: p?.height ?? 360,
    };

    bringToFront(panelId);
    beginResize(panelId);
  }, [panelId, bringToFront, beginResize]);

  // ── Position style ──────────────────────────────────────────
  // Transition resolution order while NOT manipulating:
  //   1. Engine token (auto-arrange/grid/stage spring) — highest authority
  //   2. Premium default deceleration                 — graceful idle move
  // While manipulating: 'none' so the panel tracks the cursor 1:1.
  const resolvedTransition =
    isDragging || isResizing
      ? 'none'
      : (motionTransition && motionTransition.length > 0
          ? motionTransition
          : DEFAULT_MOTION_TRANSITION);

  const positionStyle: React.CSSProperties = {
    left: displayX,
    top: displayY,
    width: displayW,
    height: displayH,
    transition: resolvedTransition,
    // Cursor feedback
    cursor: isDragging ? 'grabbing' : isResizing ? 'nwse-resize' : undefined,
  };

  return {
    dragHandlers: { onMouseDown: handleDragStart },
    resizeHandlers: { onMouseDown: handleResizeStart },
    positionStyle,
    transition: resolvedTransition,
    isDragging,
    isResizing,
  };
}
