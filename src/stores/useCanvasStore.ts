// ── ORCH Canvas Workspace Store ────────────────────────────────
// Manages freehand drawings, shapes, text notes, and images
// on the infinite canvas.
// NOTE: Persistence is now handled by useWorkspaceStore (file-based).
// Undo/redo and drag conflict prevention are session-only (not persisted).

import { create } from 'zustand';

export type CanvasTool = 'select' | 'pen' | 'shape' | 'text' | 'eraser';
export type ShapeType = 'rect' | 'ellipse' | 'arrow' | 'frame';
export type CanvasElementType = 'drawing' | 'shape' | 'text' | 'image';

export interface CanvasPoint {
  x: number;
  y: number;
}

export interface CanvasElement {
  id: string;
  type: CanvasElementType;
  // Drawing stroke
  points?: CanvasPoint[];
  // Shape / frame
  shapeType?: ShapeType;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  // Text
  text?: string;
  fontSize?: number;
  // Image
  src?: string;       // file path or object URL
  alt?: string;
  // Common styling
  strokeColor: string;
  strokeWidth: number;
  fillColor?: string;
  rotation?: number;
  zIndex: number;
  createdAt: number;
}

interface CanvasWorkspaceState {
  elements: CanvasElement[];
  activeTool: CanvasTool;
  activeShapeType: ShapeType;
  strokeColor: string;
  strokeWidth: number;
  fillEnabled: boolean;
  fillOpacity: number;       // 0-100
  fontSize: number;          // for text tool
  isDrawing: boolean;        // currently drawing a stroke
  currentStroke: CanvasPoint[];  // in-progress stroke buffer

  // Undo / redo stacks (snapshots of elements[]) — session only
  undoStack: CanvasElement[][];
  redoStack: CanvasElement[][];

  // Drag conflict prevention — only one drag target at a time
  dragTarget: string | null;

  // ── Tool actions ────────────────────────────────────────────
  setActiveTool: (tool: CanvasTool) => void;
  setActiveShapeType: (t: ShapeType) => void;
  setStrokeColor: (c: string) => void;
  setStrokeWidth: (w: number) => void;
  setFillEnabled: (v: boolean) => void;
  setFillOpacity: (v: number) => void;
  setFontSize: (v: number) => void;
  addElement: (el: CanvasElement) => void;
  removeElement: (id: string) => void;
  updateElement: (id: string, patch: Partial<CanvasElement>) => void;
  clearCanvas: () => void;

  // ── Drawing session ─────────────────────────────────────────
  startStroke: (point: CanvasPoint) => void;
  addStrokePoint: (point: CanvasPoint) => void;
  endStroke: () => void;

  // ── Undo / Redo ─────────────────────────────────────────────
  undo: () => void;
  redo: () => void;

  // ── Drag conflict prevention ────────────────────────────────
  setDragTarget: (target: string | null) => void;

  // Internal history snapshot (called before mutations)
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
  };
  /** Hydrate canvas state from workspace file data */
  hydrateFromWorkspace: (data: {
    elements?: CanvasElement[];
    strokeColor?: string;
    strokeWidth?: number;
    fillEnabled?: boolean;
    fillOpacity?: number;
    fontSize?: number;
  }) => void;
  /** Reset canvas to default (called when closing a workspace) */
  resetCanvas: () => void;
}

const INITIAL_STATE = {
  elements: [] as CanvasElement[],
  activeTool: 'select' as CanvasTool,
  activeShapeType: 'frame' as ShapeType,
  strokeColor: '#ff781f',
  strokeWidth: 2,
  fillEnabled: false,
  fillOpacity: 20,
  fontSize: 14,
  isDrawing: false,
  currentStroke: [] as CanvasPoint[],
  undoStack: [] as CanvasElement[][],
  redoStack: [] as CanvasElement[][],
  dragTarget: null as string | null,
};

export const useCanvasStore = create<CanvasWorkspaceState>()(
  (set, get) => ({
    ...INITIAL_STATE,

    // ── Snapshot helper ──────────────────────────────────────
    // Pushes current elements onto undo stack (call BEFORE mutations)
    pushHistory: () => {
      const { elements, undoStack } = get();
      set({ undoStack: [...undoStack.slice(-49), [...elements]], redoStack: [] });
    },

    setActiveTool: (tool) => set({ activeTool: tool }),
    setActiveShapeType: (t) => set({ activeShapeType: t }),
    setStrokeColor: (c) => set({ strokeColor: c }),
    setStrokeWidth: (w) => set({ strokeWidth: w }),
    setFillEnabled: (v) => set({ fillEnabled: v }),
    setFillOpacity: (v) => set({ fillOpacity: v }),
    setFontSize: (v) => set({ fontSize: v }),

    addElement: (el) => {
      get().pushHistory();
      set((s) => ({ elements: [...s.elements, el] }));
    },

    removeElement: (id) => {
      get().pushHistory();
      set((s) => ({ elements: s.elements.filter((e) => e.id !== id) }));
    },

    updateElement: (id, patch) => {
      get().pushHistory();
      set((s) => ({
        elements: s.elements.map((e) => (e.id === id ? { ...e, ...patch } : e)),
      }));
    },

    clearCanvas: () => {
      get().pushHistory();
      set({ elements: [] });
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

    endStroke: () => {
      const { currentStroke, strokeColor, strokeWidth, elements } = get();
      if (currentStroke.length < 2) {
        set({ isDrawing: false, currentStroke: [] });
        return;
      }
      // Snapshot before committing stroke
      get().pushHistory();
      // Simplify: keep every Nth point to reduce vertex count
      const simplified = currentStroke.filter((_, i) => i % 2 === 0);
      const el: CanvasElement = {
        id: `draw_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        type: 'drawing',
        points: simplified,
        strokeColor,
        strokeWidth,
        zIndex: elements.length,
        createdAt: Date.now(),
      };
      set((s) => ({
        elements: [...s.elements, el],
        isDrawing: false,
        currentStroke: [],
      }));
    },

    // ── Undo / Redo ─────────────────────────────────────────
    undo: () => {
      const { elements, undoStack } = get();
      if (undoStack.length === 0) return;
      const prev = undoStack[undoStack.length - 1];
      set({
        elements: prev,
        undoStack: undoStack.slice(0, -1),
        redoStack: [...get().redoStack.slice(-49), [...elements]],
      });
    },

    redo: () => {
      const { elements, redoStack } = get();
      if (redoStack.length === 0) return;
      const next = redoStack[redoStack.length - 1];
      set({
        elements: next,
        redoStack: redoStack.slice(0, -1),
        undoStack: [...get().undoStack.slice(-49), [...elements]],
      });
    },

    // ── Drag conflict prevention ────────────────────────────
    setDragTarget: (target) => set({ dragTarget: target }),

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
      };
    },

    hydrateFromWorkspace: (data) => {
      set({
        elements: data.elements ?? [],
        strokeColor: data.strokeColor ?? '#ff781f',
        strokeWidth: data.strokeWidth ?? 2,
        fillEnabled: data.fillEnabled ?? false,
        fillOpacity: data.fillOpacity ?? 20,
        fontSize: data.fontSize ?? 14,
        // Reset session-only state
        undoStack: [],
        redoStack: [],
        dragTarget: null,
        isDrawing: false,
        currentStroke: [],
      });
    },

    resetCanvas: () => {
      set({
        ...INITIAL_STATE,
      });
    },
  }),
);
