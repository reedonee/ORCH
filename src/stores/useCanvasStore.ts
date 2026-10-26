// ── ORCH Canvas Workspace Store ────────────────────────────────
// Manages freehand drawings, shapes, text notes, and images
// on the infinite canvas.
// NOTE: Persistence is now handled by useWorkspaceStore (file-based).
// Undo/redo and drag conflict prevention are session-only (not persisted).

import { create } from 'zustand';
import { normalizeRect, simplifyStrokeIndices } from '../lib/canvas-geometry';

export type CanvasTool = 'select' | 'hand' | 'pen' | 'shape' | 'text' | 'eraser';
export type ShapeType = 'rect' | 'ellipse' | 'diamond' | 'arrow' | 'line' | 'frame';
export type CanvasElementType = 'drawing' | 'shape' | 'text' | 'image';

/** Shapes stored as a directed segment: normalising them would reverse them. */
export const DIRECTIONAL_SHAPES: ShapeType[] = ['line', 'arrow'];

export interface CanvasPoint {
  x: number;
  y: number;
}

export interface CanvasElement {
  id: string;
  type: CanvasElementType;
  // Drawing stroke
  points?: CanvasPoint[];
  /** Per-point nib width, when the input device reported pressure. */
  widths?: number[];
  // Shape / frame
  shapeType?: ShapeType;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  // Text
  text?: string;
  fontSize?: number;
  // Image / media
  src?: string;       // orch-asset:// URL, file path, or object URL
  alt?: string;
  /** Present when an agent produced this node via canvas_add_file. */
  fileMeta?: {
    path: string;
    kind: 'image' | 'video' | 'audio' | 'text' | 'pdf' | 'file';
    ext: string;
    sizeBytes: number;
    producedBy: string;
  };
  // Common styling
  strokeColor: string;
  strokeWidth: number;
  fillColor?: string;
  /** 0-1. Applies to the whole element, fill and stroke alike. */
  opacity?: number;
  /** Solid when absent. */
  dash?: 'solid' | 'dashed' | 'dotted';
  rotation?: number;
  /** Excluded from hit-testing, selection and erasing while true. */
  locked?: boolean;
  zIndex: number;
  createdAt: number;
}

interface CanvasWorkspaceState {
  elements: CanvasElement[];
  activeTool: CanvasTool;
  /** Restored when a transient tool (hand while Space is held) releases. */
  previousTool: CanvasTool;
  activeShapeType: ShapeType;
  strokeColor: string;
  strokeWidth: number;
  fillEnabled: boolean;
  fillOpacity: number;       // 0-100
  fontSize: number;          // for text tool
  dashStyle: 'solid' | 'dashed' | 'dotted';
  snapToGrid: boolean;
  gridSize: number;
  isDrawing: boolean;        // currently drawing a stroke
  currentStroke: CanvasPoint[];  // in-progress stroke buffer

  // Undo / redo stacks (snapshots of elements[]) — session only
  undoStack: CanvasElement[][];
  redoStack: CanvasElement[][];
  /**
   * Depth of the open interaction, if any. A drag is one undo step, so
   * pushHistory() snapshots on entry and then goes quiet until the
   * gesture ends.
   */
  interactionDepth: number;
  /** Whether the open interaction has actually snapshotted anything yet. */
  interactionDirty: boolean;

  // Drag conflict prevention — only one drag target at a time
  dragTarget: string | null;

  // ── Selection (lasso) ──────────────────────────────────────
  selectedElementIds: string[];
  selectionBox: { x1: number; y1: number; x2: number; y2: number } | null;
  /**
   * Text note currently open for editing. Lives here so whoever creates
   * a note (the text tool, a paste, an agent) can drop the caret into
   * it without reaching across components.
   */
  editingElementId: string | null;

  // ── Tool actions ────────────────────────────────────────────
  setActiveTool: (tool: CanvasTool) => void;
  setActiveShapeType: (t: ShapeType) => void;
  setStrokeColor: (c: string) => void;
  setStrokeWidth: (w: number) => void;
  setFillEnabled: (v: boolean) => void;
  setFillOpacity: (v: number) => void;
  setFontSize: (v: number) => void;
  setDashStyle: (v: 'solid' | 'dashed' | 'dotted') => void;
  setSnapToGrid: (v: boolean) => void;
  setGridSize: (v: number) => void;
  addElement: (el: CanvasElement) => void;
  addElements: (els: CanvasElement[]) => void;
  removeElement: (id: string) => void;
  removeElements: (ids: string[]) => void;
  updateElement: (id: string, patch: Partial<CanvasElement>) => void;
  /** Patch several elements in one history step. */
  updateElements: (patches: Array<{ id: string; patch: Partial<CanvasElement> }>) => void;
  /** Silent patch — no history, no redo reset. For measurement caches. */
  updateElementQuiet: (id: string, patch: Partial<CanvasElement>) => void;
  clearCanvas: () => void;

  // ── Bulk element operations ─────────────────────────────────
  moveElements: (ids: string[], dx: number, dy: number) => void;
  duplicateElements: (ids: string[], offset?: number) => string[];
  bringToFront: (ids: string[]) => void;
  sendToBack: (ids: string[]) => void;
  setLocked: (ids: string[], locked: boolean) => void;
  /** Next free paint-order slot. */
  nextZIndex: () => number;

  // ── Drawing session ─────────────────────────────────────────
  startStroke: (point: CanvasPoint) => void;
  addStrokePoint: (point: CanvasPoint) => void;
  /**
   * Commit a stroke. The live buffer is owned by the drawing layer (a
   * store write per pointer sample is what made long strokes stutter),
   * so it hands the final points back here.
   */
  commitStroke: (points: CanvasPoint[], widths?: number[]) => void;
  endStroke: () => void;
  cancelStroke: () => void;

  // ── Undo / Redo ─────────────────────────────────────────────
  undo: () => void;
  redo: () => void;
  /** Open a multi-mutation gesture that collapses to one undo step. */
  beginInteraction: () => void;
  endInteraction: () => void;
  /** Roll the open gesture back to where it started and forget it. */
  abortInteraction: () => void;

  // ── Drag conflict prevention ────────────────────────────────
  setDragTarget: (target: string | null) => void;

  // ── Selection / lasso ──────────────────────────────────────
  setSelectedElementIds: (ids: string[]) => void;
  toggleSelection: (id: string, additive: boolean) => void;
  selectAll: () => void;
  setSelectionBox: (box: { x1: number; y1: number; x2: number; y2: number } | null) => void;
  clearSelection: () => void;
  setEditingElement: (id: string | null) => void;

  // ── Internal history snapshot (called before mutations) ──────
  pushHistory: () => void;

  // ── Workspace persistence helpers ───────────────────────────
  /** Serialise persistent canvas state for .orch-workspace.json */
  toWorkspaceData: () => {
    elements: CanvasElement[];
    strokeColor: string;
    strokeWidth: number;
    fillEnabled: boolean;
    fillOpacity: number;
    fontSize: number;
    dashStyle: 'solid' | 'dashed' | 'dotted';
    snapToGrid: boolean;
    gridSize: number;
  };
  /** Hydrate canvas state from workspace file data */
  hydrateFromWorkspace: (data: {
    elements?: CanvasElement[];
    strokeColor?: string;
    strokeWidth?: number;
    fillEnabled?: boolean;
    fillOpacity?: number;
    fontSize?: number;
    dashStyle?: 'solid' | 'dashed' | 'dotted';
    snapToGrid?: boolean;
    gridSize?: number;
  }) => void;
  /** Reset canvas to default (called when closing a workspace) */
  resetCanvas: () => void;
}

const HISTORY_LIMIT = 100;

const INITIAL_STATE = {
  elements: [] as CanvasElement[],
  activeTool: 'select' as CanvasTool,
  previousTool: 'select' as CanvasTool,
  activeShapeType: 'rect' as ShapeType,
  strokeColor: '#ff781f',
  strokeWidth: 2,
  fillEnabled: false,
  fillOpacity: 20,
  fontSize: 14,
  dashStyle: 'solid' as 'solid' | 'dashed' | 'dotted',
  snapToGrid: false,
  gridSize: 20,
  isDrawing: false,
  currentStroke: [] as CanvasPoint[],
  undoStack: [] as CanvasElement[][],
  redoStack: [] as CanvasElement[][],
  interactionDepth: 0,
  interactionDirty: false,
  dragTarget: null as string | null,
  selectedElementIds: [] as string[],
  selectionBox: null as { x1: number; y1: number; x2: number; y2: number } | null,
  editingElementId: null as string | null,
};

let idCounter = 0;
/** Collision-free even inside a single millisecond, unlike Date.now(). */
export function makeElementId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

/**
 * Repair an element loaded from disk.
 *
 * Older builds stored drag rectangles with negative extents and left
 * zIndex undefined. Both are load-bearing now — hit-testing and paint
 * order read them — so legacy files are fixed up on the way in rather
 * than every consumer defending against them.
 */
function reviveElement(el: CanvasElement, i: number): CanvasElement {
  const out: CanvasElement = {
    ...el,
    zIndex: Number.isFinite(el.zIndex) ? el.zIndex : i,
  };
  if (
    out.type === 'shape' &&
    !DIRECTIONAL_SHAPES.includes(out.shapeType ?? 'rect') &&
    ((out.width ?? 0) < 0 || (out.height ?? 0) < 0)
  ) {
    const r = normalizeRect(out.x ?? 0, out.y ?? 0, out.width ?? 0, out.height ?? 0);
    out.x = r.x; out.y = r.y; out.width = r.width; out.height = r.height;
  }
  return out;
}

export const useCanvasStore = create<CanvasWorkspaceState>()(
  (set, get) => ({
    ...INITIAL_STATE,

    // ── Snapshot helper ──────────────────────────────────────
    // Pushes current elements onto undo stack (call BEFORE mutations).
    // Silent inside an open interaction: beginInteraction() already took
    // the one snapshot that gesture is entitled to. Without this a
    // single shape drag pushed ~300 entries and Ctrl+Z became useless.
    pushHistory: () => {
      const { elements, undoStack, interactionDepth, interactionDirty } = get();
      // Inside a gesture, only the first write snapshots. Snapshotting
      // when the gesture OPENS instead would charge an undo entry for
      // every click that grabbed something and then moved it nowhere.
      if (interactionDepth > 0 && interactionDirty) return;
      set({
        undoStack: [...undoStack.slice(-(HISTORY_LIMIT - 1)), elements],
        redoStack: [],
        interactionDirty: interactionDepth > 0,
      });
    },

    beginInteraction: () => {
      set((s) => ({
        interactionDepth: s.interactionDepth + 1,
        interactionDirty: s.interactionDepth === 0 ? false : s.interactionDirty,
      }));
    },

    endInteraction: () => {
      set((s) => {
        const depth = Math.max(0, s.interactionDepth - 1);
        return { interactionDepth: depth, interactionDirty: depth === 0 ? false : s.interactionDirty };
      });
    },

    // The snapshot taken by the gesture's first write IS its starting
    // state, so cancelling is: put it back, then drop it. Beats having
    // each caller reconstruct the original geometry by hand.
    abortInteraction: () => {
      const { interactionDepth, interactionDirty, undoStack } = get();
      if (interactionDepth === 0) return;
      if (interactionDirty && undoStack.length > 0) {
        set({
          elements: undoStack[undoStack.length - 1],
          undoStack: undoStack.slice(0, -1),
        });
      }
      set({ interactionDepth: 0, interactionDirty: false });
    },

    setActiveTool: (tool) =>
      set((s) => (s.activeTool === tool ? {} : { activeTool: tool, previousTool: s.activeTool })),
    setActiveShapeType: (t) => set({ activeShapeType: t }),
    setStrokeColor: (c) => set({ strokeColor: c }),
    setStrokeWidth: (w) => set({ strokeWidth: w }),
    setFillEnabled: (v) => set({ fillEnabled: v }),
    setFillOpacity: (v) => set({ fillOpacity: v }),
    setFontSize: (v) => set({ fontSize: v }),
    setDashStyle: (v) => set({ dashStyle: v }),
    setSnapToGrid: (v) => set({ snapToGrid: v }),
    setGridSize: (v) => set({ gridSize: Math.max(2, v) }),

    nextZIndex: () => {
      const els = get().elements;
      return els.length === 0 ? 0 : Math.max(...els.map((e) => e.zIndex ?? 0)) + 1;
    },

    addElement: (el) => {
      get().pushHistory();
      set((s) => ({ elements: [...s.elements, el] }));
    },

    addElements: (els) => {
      if (els.length === 0) return;
      get().pushHistory();
      set((s) => ({ elements: [...s.elements, ...els] }));
    },

    removeElement: (id) => {
      get().pushHistory();
      set((s) => ({
        elements: s.elements.filter((e) => e.id !== id),
        selectedElementIds: s.selectedElementIds.filter((s2) => s2 !== id),
      }));
    },

    removeElements: (ids) => {
      if (ids.length === 0) return;
      const kill = new Set(ids);
      get().pushHistory();
      set((s) => ({
        elements: s.elements.filter((e) => !kill.has(e.id)),
        selectedElementIds: s.selectedElementIds.filter((id) => !kill.has(id)),
      }));
    },

    updateElement: (id, patch) => {
      get().pushHistory();
      set((s) => ({
        elements: s.elements.map((e) => (e.id === id ? { ...e, ...patch } : e)),
      }));
    },

    updateElements: (patches) => {
      if (patches.length === 0) return;
      const byId = new Map(patches.map((p) => [p.id, p.patch]));
      get().pushHistory();
      set((s) => ({
        elements: s.elements.map((e) => {
          const p = byId.get(e.id);
          return p ? { ...e, ...p } : e;
        }),
      }));
    },

    // No snapshot: this exists for derived data the renderer measures
    // (a text note's painted box), which is not a user edit and must not
    // land on the undo stack or wipe the redo stack.
    updateElementQuiet: (id, patch) => {
      set((s) => ({
        elements: s.elements.map((e) => (e.id === id ? { ...e, ...patch } : e)),
      }));
    },

    clearCanvas: () => {
      get().pushHistory();
      set({ elements: [], selectedElementIds: [], selectionBox: null });
    },

    // ── Bulk operations ─────────────────────────────────────
    moveElements: (ids, dx, dy) => {
      if (ids.length === 0 || (dx === 0 && dy === 0)) return;
      const move = new Set(ids);
      get().pushHistory();
      set((s) => ({
        elements: s.elements.map((e) => {
          if (!move.has(e.id) || e.locked) return e;
          if (e.type === 'drawing' && e.points) {
            return { ...e, points: e.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
          }
          return { ...e, x: (e.x ?? 0) + dx, y: (e.y ?? 0) + dy };
        }),
      }));
    },

    duplicateElements: (ids, offset = 24) => {
      if (ids.length === 0) return [];
      const want = new Set(ids);
      const source = get().elements.filter((e) => want.has(e.id));
      if (source.length === 0) return [];

      let z = get().nextZIndex();
      const copies = source.map((e) => {
        const id = makeElementId(e.type.slice(0, 4));
        const copy: CanvasElement = {
          ...e,
          id,
          zIndex: z++,
          createdAt: Date.now(),
        };
        if (e.type === 'drawing' && e.points) {
          copy.points = e.points.map((p) => ({ x: p.x + offset, y: p.y + offset }));
        } else {
          copy.x = (e.x ?? 0) + offset;
          copy.y = (e.y ?? 0) + offset;
        }
        return copy;
      });

      get().pushHistory();
      set((s) => ({
        elements: [...s.elements, ...copies],
        selectedElementIds: copies.map((c) => c.id),
      }));
      return copies.map((c) => c.id);
    },

    bringToFront: (ids) => {
      if (ids.length === 0) return;
      const lift = new Set(ids);
      let z = get().nextZIndex();
      get().pushHistory();
      set((s) => ({
        elements: s.elements.map((e) => (lift.has(e.id) ? { ...e, zIndex: z++ } : e)),
      }));
    },

    sendToBack: (ids) => {
      if (ids.length === 0) return;
      const drop = new Set(ids);
      const els = get().elements;
      const floor = els.length === 0 ? 0 : Math.min(...els.map((e) => e.zIndex ?? 0));
      let z = floor - ids.length;
      get().pushHistory();
      set((s) => ({
        elements: s.elements.map((e) => (drop.has(e.id) ? { ...e, zIndex: z++ } : e)),
      }));
    },

    setLocked: (ids, locked) => {
      if (ids.length === 0) return;
      const target = new Set(ids);
      get().pushHistory();
      set((s) => ({
        elements: s.elements.map((e) => (target.has(e.id) ? { ...e, locked } : e)),
        selectedElementIds: locked ? [] : s.selectedElementIds,
      }));
    },

    // ── Drawing session ─────────────────────────────────────
    startStroke: (point) => {
      set({ isDrawing: true, currentStroke: [point] });
    },

    addStrokePoint: (point) => {
      const { isDrawing, currentStroke } = get();
      if (!isDrawing) return;
      set({ currentStroke: [...currentStroke, point] });
    },

    commitStroke: (points, widths) => {
      if (points.length < 2) {
        set({ isDrawing: false, currentStroke: [] });
        return;
      }
      const { strokeColor, strokeWidth, dashStyle } = get();

      // Ramer-Douglas-Peucker rather than the old "every other point":
      // it keeps both endpoints and spends vertices where the line
      // actually curves. Epsilon scales with the nib so a fat stroke is
      // not stored at hairline precision.
      const epsilon = Math.max(0.4, strokeWidth * 0.25);
      const kept = simplifyStrokeIndices(points, epsilon);
      const simplified = kept.map((i) => points[i]);

      // Carry the pressure track through by index. Keying on
      // coordinates would collide whenever the pointer paused and
      // reported the same position twice.
      const keptWidths =
        widths && widths.length === points.length
          ? kept.map((i) => widths[i])
          : undefined;

      const el: CanvasElement = {
        id: makeElementId('draw'),
        type: 'drawing',
        points: simplified,
        widths: keptWidths,
        strokeColor,
        strokeWidth,
        dash: dashStyle,
        zIndex: get().nextZIndex(),
        createdAt: Date.now(),
      };

      get().pushHistory();
      set((s) => ({
        elements: [...s.elements, el],
        isDrawing: false,
        currentStroke: [],
      }));
    },

    endStroke: () => {
      get().commitStroke(get().currentStroke);
    },

    cancelStroke: () => set({ isDrawing: false, currentStroke: [] }),

    // ── Undo / Redo ─────────────────────────────────────────
    undo: () => {
      const { elements, undoStack, redoStack } = get();
      if (undoStack.length === 0) return;
      const prev = undoStack[undoStack.length - 1];
      const live = new Set(prev.map((e) => e.id));
      set({
        elements: prev,
        undoStack: undoStack.slice(0, -1),
        redoStack: [...redoStack.slice(-(HISTORY_LIMIT - 1)), elements],
        // Selecting something that no longer exists leaves the
        // properties panel editing a ghost.
        selectedElementIds: get().selectedElementIds.filter((id) => live.has(id)),
        interactionDepth: 0,
        interactionDirty: false,
      });
    },

    redo: () => {
      const { elements, redoStack, undoStack } = get();
      if (redoStack.length === 0) return;
      const next = redoStack[redoStack.length - 1];
      const live = new Set(next.map((e) => e.id));
      set({
        elements: next,
        redoStack: redoStack.slice(0, -1),
        undoStack: [...undoStack.slice(-(HISTORY_LIMIT - 1)), elements],
        selectedElementIds: get().selectedElementIds.filter((id) => live.has(id)),
        interactionDepth: 0,
        interactionDirty: false,
      });
    },

    // ── Drag conflict prevention ────────────────────────────
    setDragTarget: (target) => set({ dragTarget: target }),

    // ── Selection / lasso ────────────────────────────────────
    setSelectedElementIds: (ids) => set({ selectedElementIds: ids }),

    toggleSelection: (id, additive) => {
      set((s) => {
        if (!additive) return { selectedElementIds: [id] };
        return s.selectedElementIds.includes(id)
          ? { selectedElementIds: s.selectedElementIds.filter((x) => x !== id) }
          : { selectedElementIds: [...s.selectedElementIds, id] };
      });
    },

    selectAll: () =>
      set((s) => ({ selectedElementIds: s.elements.filter((e) => !e.locked).map((e) => e.id) })),

    setSelectionBox: (box) => set({ selectionBox: box }),
    clearSelection: () => set({ selectedElementIds: [], selectionBox: null }),
    setEditingElement: (id) => set({ editingElementId: id }),

    // ── Workspace persistence ────────────────────────────────
    toWorkspaceData: () => {
      const s = get();
      return {
        elements: s.elements,
        strokeColor: s.strokeColor,
        strokeWidth: s.strokeWidth,
        fillEnabled: s.fillEnabled,
        fillOpacity: s.fillOpacity,
        fontSize: s.fontSize,
        dashStyle: s.dashStyle,
        snapToGrid: s.snapToGrid,
        gridSize: s.gridSize,
      };
    },

    hydrateFromWorkspace: (data) => {
      set({
        elements: (data.elements ?? []).map(reviveElement),
        strokeColor: data.strokeColor ?? '#ff781f',
        strokeWidth: data.strokeWidth ?? 2,
        fillEnabled: data.fillEnabled ?? false,
        fillOpacity: data.fillOpacity ?? 20,
        fontSize: data.fontSize ?? 14,
        dashStyle: data.dashStyle ?? 'solid',
        snapToGrid: data.snapToGrid ?? false,
        gridSize: data.gridSize ?? 20,
        // Reset session-only state
        undoStack: [],
        redoStack: [],
        interactionDepth: 0,
        interactionDirty: false,
        dragTarget: null,
        isDrawing: false,
        currentStroke: [],
        selectedElementIds: [],
        selectionBox: null,
        editingElementId: null,
      });
    },

    resetCanvas: () => {
      set({
        ...INITIAL_STATE,
      });
    },
  }),
);
