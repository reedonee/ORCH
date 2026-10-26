import React, { useRef, useState, useCallback, useEffect, useMemo } from 'react';
import { AgentCard } from './AgentCard';
import { useAppStore } from '../stores/useAppStore';
import {
  useCanvasStore, makeElementId,
  type CanvasElement, type CanvasTool as CanvasToolName,
} from '../stores/useCanvasStore';
import { useWorkspaceStore } from '../stores/useWorkspaceStore';
import { DrawingLayer } from './DrawingLayer';
import { VectorLayer } from './VectorLayer';
import { CanvasToolbar } from './CanvasToolbar';
import { CanvasTextNotes, CanvasImages } from './CanvasElements';
import { CanvasPropertiesPanel } from './CanvasPropertiesPanel';
import { EraserOverlay } from './EraserOverlay';
import { elementsInRect } from '../lib/canvas-geometry';
import { CanvasSelectionLayer } from './CanvasSelectionLayer';
import { saveCanvasAsset, type SavedAsset } from '../lib/electron-api';
import { Z_BASE_LAYERS } from '../lib/z-stack-manager';
import { frameViewport } from '../lib/layout-engine';
import { boundingBox } from '../lib/layout-modes';
import { usePanelRegistry } from '../stores/usePanelRegistry';
import { useMusicPlayerStore } from '../stores/useMusicPlayerStore';
import { useBrowserStore } from '../stores/useBrowserStore';
import { MusicPlayer } from './MusicPlayer';
import { BrowserPreview } from './BrowserPreview';
import ForgeNode from './ForgeNode';
import BugReporter from './BugReporter';

// Zoom limits live in one place: the wheel, the buttons and pinch each
// clamped to a different range, so the buttons refused to go below 0.25
// while the wheel happily reached 0.1 and then could not be undone.
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 5;
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

const MINIMAP_W = 190;
const MINIMAP_H = 130;

// Cards outside this viewport multiplier aren't rendered
const VP_BUFFER = 1.5;

// Zoom button style — module-level to avoid GC churn on re-renders
const ZOOM_BTN: React.CSSProperties = {
  width: 24, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center',
  border: 'none', background: 'transparent', cursor: 'pointer', borderRadius: 3,
  padding: 0, lineHeight: 1, fontSize: 14, fontWeight: 700, color: 'var(--text)',
};

/** Compute a triangular arrowhead polygon points at the end of a line. */
function computeArrowhead(x1: number, y1: number, x2: number, y2: number, size: number = 8): string {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const tipX = x2;
  const tipY = y2;
  const leftX = tipX - size * Math.cos(angle - Math.PI / 6);
  const leftY = tipY - size * Math.sin(angle - Math.PI / 6);
  const rightX = tipX - size * Math.cos(angle + Math.PI / 6);
  const rightY = tipY - size * Math.sin(angle + Math.PI / 6);
  return `${tipX},${tipY} ${leftX},${leftY} ${rightX},${rightY}`;
}


/**
 * Build a canvas node for a saved image.
 *
 * `src` MUST be the orch-asset:// URL, never `file://` — the renderer
 * blocks file:// for its own content, so the previous version produced
 * nodes that could never load and fell through to a generic file card.
 */
function makeImageElement(
  asset: SavedAsset,
  name: string,
  x: number,
  y: number,
): CanvasElement {
  return {
    id: `img_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    type: 'image',
    src: asset.url,
    alt: name,
    text: name,
    x, y,
    // Placeholder box; CanvasMediaNode measures the real image on load and
    // resizes to its true aspect ratio.
    width: 320,
    height: 200,
    strokeColor: 'transparent',
    strokeWidth: 0,
    // Paint order is an ordinal, not a timestamp. Date.now() here put
    // every agent-created node ~1.8e12 above the rest, so they always
    // outranked user content and sendToBack had to go absurdly
    // negative to get beneath them.
    zIndex: useCanvasStore.getState().nextZIndex(),
    createdAt: Date.now(),
    fileMeta: {
      path: asset.path ?? '',
      kind: 'image',
      ext: asset.ext ?? 'png',
      sizeBytes: asset.sizeBytes ?? 0,
      producedBy: 'user',
    },
  };
}

export const InfiniteCanvas: React.FC = () => {
  const agents = useAppStore((s) => s.agents);
  const removeAgent = useAppStore((s) => s.removeAgent);
  const updateAgentPositions = useAppStore((s) => s.updateAgentPositions);
  const selectedAgentId = useAppStore((s) => s.selectedAgentId);
  const focusTarget = useAppStore((s) => s.focusTarget);
  const clearFocusTarget = useAppStore((s) => s.clearFocusTarget);
  const viewportFrame = useAppStore((s) => s.viewportFrame);
  const clearViewportFrame = useAppStore((s) => s.clearViewportFrame);
  const delegationLinks = useAppStore((s) => s.delegationLinks);
  const activeTool = useCanvasStore((s) => s.activeTool);
  const addElement = useCanvasStore((s) => s.addElement);
  const selectionBox = useCanvasStore((s) => s.selectionBox);
  // const setActiveTool = useCanvasStore((s) => s.setActiveTool);

  const canvasRef = useRef<HTMLDivElement>(null);
  const minimapRef = useRef<HTMLDivElement>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [isPanning, setIsPanning] = useState(false);
  const [isShiftPanning, setIsShiftPanning] = useState(false);
  const [isSelecting, setIsSelecting] = useState(false);
  const panStart = useRef({ x: 0, y: 0, mx: 0, my: 0 });
  const selectDragStart = useRef<{ x: number; y: number } | null>(null);
  const selectDragCurrent = useRef<{ x: number; y: number } | null>(null);
  const panRef = useRef(pan);
  const zoomRef = useRef(zoom);
  const [winSize, setWinSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [hoveredDot, setHoveredDot] = useState<string | null>(null);
  const [showMinimap, setShowMinimap] = useState(true);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pokeIdleRef = useRef<() => void>(() => {});

  // ── Read layout motion tokens for canvas transform transition ──
  const layoutMotion = usePanelRegistry((s) => s.layoutMotion);
  const canvasTransition = layoutMotion.mode === 'spring' && !isPanning
    ? 'transform 0.45s cubic-bezier(0.34, 1.56, 0.64, 1)'
    : 'none';

  const pokeIdle = useCallback(() => {
    setShowMinimap(true);
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => setShowMinimap(false), 1000);
  }, []);

  // keep refs in sync so effects with stable deps can use them
  pokeIdleRef.current = pokeIdle;
  panRef.current = pan;
  zoomRef.current = zoom;

  // ── Sync canvas elements (text notes, images) to panel registry for framing ──
  const canvasElements = useCanvasStore((s) => s.elements);
  useEffect(() => {
    const registry = usePanelRegistry.getState();
    // Collect current canvas element IDs that should be registered
    const currentIds = new Set<string>();
    for (let i = 0; i < canvasElements.length; i++) {
      const el = canvasElements[i];
      if (el.type !== 'text' && el.type !== 'image') continue;
      const id = `canvas-${el.id}`;
      currentIds.add(id);
      if (!registry.panels[id]) {
        registry.registerPanel({
          id,
          type: el.type === 'text' ? 'textnote' : 'image',
          space: 'canvas',
          x: el.x ?? 0,
          y: el.y ?? 0,
          width: el.width ?? 200,
          height: el.height ?? 60,
          minWidth: 40,
          minHeight: 20,
          defaultWidth: 200,
          defaultHeight: 60,
          participatesInAutoLayout: false,
          participatesInFraming: true,
          participatesInCollision: false,
          draggable: false,
          resizable: false,
          focusable: false,
          baseZIndex: 60,
          persistent: false,
        });
      } else {
        // Update position
        registry.updatePanel(id, {
          x: el.x ?? 0,
          y: el.y ?? 0,
          width: el.width ?? 200,
          height: el.height ?? 60,
        });
      }
    }
    // Unregister elements no longer in the canvas
    const allPanelIds = Object.keys(registry.panels);
    for (let i = 0; i < allPanelIds.length; i++) {
      const pid = allPanelIds[i];
      if (pid.startsWith('canvas-') && !currentIds.has(pid)) {
        registry.unregisterPanel(pid);
      }
    }
  }, [canvasElements]);

  // initial show on mount, hide after 2s
  useEffect(() => {
    pokeIdle();
    return () => { if (idleTimerRef.current) clearTimeout(idleTimerRef.current); };
  }, [pokeIdle]);

  // show when agents open/close
  useEffect(() => { pokeIdleRef.current(); }, [agents.length]);

  // ── sync viewport to store for smart agent spawning ────────
  useEffect(() => {
    useAppStore.getState().setViewport(pan, zoom, winSize);
  }, [pan.x, pan.y, zoom, winSize]);

  // ── react to focus target (from focusOnAgent) ──────────────
  useEffect(() => {
    if (!focusTarget) return;
    setPan({ x: focusTarget.x, y: focusTarget.y });
    setZoom(focusTarget.zoom);
    clearFocusTarget();
  }, [focusTarget, clearFocusTarget]);

  // ── react to engine-driven framing (auto-arrange / tidy / stage / preset)
  // The layout engine computes pan+zoom and pushes it here via the store.
  // Without this, the engine's framing wrote to the store silently and the
  // canvas never moved — so arranges positioned nodes off-screen. seq keys the
  // dependency so repeated identical framings still fire.
  useEffect(() => {
    if (!viewportFrame) return;
    setPan({ x: viewportFrame.x, y: viewportFrame.y });
    setZoom(viewportFrame.zoom);
    clearViewportFrame();
  }, [viewportFrame, clearViewportFrame]);

  // ── window resize ──────────────────────────────────────────────────────────
  useEffect(() => {
    const onResize = () => setWinSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // ── wheel zoom (cursor-centered) ───────────────────────────────────────────
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest('[data-agent-card]')) return;
      e.preventDefault();
      pokeIdleRef.current();
      const rect = el.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      setZoom((prevZoom) => {
        const newZoom = clampZoom(prevZoom * (e.deltaY > 0 ? 0.9 : 1.1));
        setPan((prev) => ({
          x: mouseX - (mouseX - prev.x) * (newZoom / prevZoom),
          y: mouseY - (mouseY - prev.y) * (newZoom / prevZoom),
        }));
        return newZoom;
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // ── canvas pan (window-level mouse) ────────────────────────────────────────
  useEffect(() => {
    if (!isPanning) return;
    const onMove = (e: MouseEvent) => {
      setPan({
        x: panStart.current.mx + (e.clientX - panStart.current.x),
        y: panStart.current.my + (e.clientY - panStart.current.y),
      });
      pokeIdleRef.current();
    };
    const onUp = () => setIsPanning(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [isPanning]);

  // ── Shift key → shift-pan mode ────────────────────────────────────────────
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if (e.key === 'Shift') {
        setIsShiftPanning(true);
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') {
        setIsShiftPanning(false);
      }
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
    };
  }, []);

  // ── Selection lasso (window-level mouse) ────────────────────────────────────
  useEffect(() => {
    if (!isSelecting) return;
    const onMove = (e: MouseEvent) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const p = panRef.current;
      const z = zoomRef.current;
      const cx = (e.clientX - rect.left - p.x) / z;
      const cy = (e.clientY - rect.top - p.y) / z;
      selectDragCurrent.current = { x: cx, y: cy };
      const start = selectDragStart.current;
      if (!start) return;
      useCanvasStore.getState().setSelectionBox({
        x1: Math.min(start.x, cx),
        y1: Math.min(start.y, cy),
        x2: Math.max(start.x, cx),
        y2: Math.max(start.y, cy),
      });
    };
    const onUp = () => {
      const start = selectDragStart.current;
      const current = selectDragCurrent.current;
      if (start && current) {
        const store = useCanvasStore.getState();
        const x1 = Math.min(start.x, current.x);
        const y1 = Math.min(start.y, current.y);
        const x2 = Math.max(start.x, current.x);
        const y2 = Math.max(start.y, current.y);
        // Real bounds per element type. Reading x/y/width/height
        // straight off the element treated every freehand stroke as a
        // 40x20 box at the origin — so a lasso near 0,0 grabbed every
        // stroke on the canvas and a lasso over an actual stroke
        // grabbed none.
        const selected = elementsInRect(
          store.elements.filter((el) => !el.locked),
          { x: x1, y: y1, width: x2 - x1, height: y2 - y1 },
        );
        store.setSelectedElementIds(selected.map((el) => el.id));
        store.setSelectionBox(null);
      }
      selectDragStart.current = null;
      selectDragCurrent.current = null;
      setIsSelecting(false);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [isSelecting]);

  const handleCanvasMouseDown = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('[data-agent-card]')) return;
    if ((e.target as HTMLElement).closest('[data-minimap]')) return;
    if (e.button !== 0 && e.button !== 1) return;

    // Don't start pan if a drawing tool is active or an element is being dragged
    const tool = useCanvasStore.getState().activeTool;
    const store = useCanvasStore.getState();
    if (tool === 'pen' || tool === 'shape' || tool === 'eraser') return;
    if (useCanvasStore.getState().dragTarget) return;

    // Text tool: place a text note at click position
    if (tool === 'text') {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (rect) {
        const cx = (e.clientX - rect.left - pan.x) / zoom;
        const cy = (e.clientY - rect.top - pan.y) / zoom;
        // Empty, with the caret already in it. Dropping a literal
        // "Type here" placeholder and leaving the user to discover that
        // a double-click edits it is two steps too many.
        const id = makeElementId('txt');
        store.addElement({
          id,
          type: 'text',
          text: '',
          x: cx, y: cy,
          width: 260,
          fontSize: store.fontSize || 14,
          strokeColor: store.strokeColor || '#EAF4F4',
          strokeWidth: 0,
          zIndex: store.nextZIndex(),
          createdAt: Date.now(),
        });
        store.setActiveTool('select');
        store.setEditingElement(id);
      }
      return;
    }

    // Don't steal focus from interactive or terminal inputs
    const target = e.target as HTMLElement | null;
    if (
      target?.closest('[data-agent-card]') ||
      target?.closest('input,textarea,select,button') ||
      target?.closest('.xterm') ||
      target?.closest('[contenteditable]')
    ) return;

    e.preventDefault();
    useAppStore.getState().setSelectedAgent(null);
    pokeIdleRef.current();

    const activeElement = document.activeElement as HTMLElement | null;
    if (activeElement && !target?.closest('.xterm')) {
      activeElement.blur();
    }
    canvasRef.current?.focus();

    // Shift-click always initiates panning
    if (e.shiftKey) {
      panStart.current = { x: e.clientX, y: e.clientY, mx: pan.x, my: pan.y };
      setIsPanning(true);
      return;
    }

    // Select mode: start lasso selection on empty space
    if (tool === 'select') {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (rect) {
        const cx = (e.clientX - rect.left - pan.x) / zoom;
        const cy = (e.clientY - rect.top - pan.y) / zoom;
        selectDragStart.current = { x: cx, y: cy };
        selectDragCurrent.current = { x: cx, y: cy };
        setIsSelecting(true);
        store.clearSelection();
      }
      return;
    }

    panStart.current = { x: e.clientX, y: e.clientY, mx: pan.x, my: pan.y };
    setIsPanning(true);
  }, [pan.x, pan.y, zoom]);

  // ── Cmd/Ctrl+L → auto-layout cards in a grid ───────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'l' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        (document.activeElement as HTMLElement)?.blur();
        canvasRef.current?.focus();
        // Use the workspace store's smart auto-arrange (includes framing)
        useWorkspaceStore.getState().autoArrange();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [winSize]);

  // ── Ctrl+V → paste text/image onto canvas ─────────────────
  useEffect(() => {
    const handler = async (e: ClipboardEvent) => {
      const tool = useCanvasStore.getState().activeTool;
      if (tool !== 'select' && tool !== 'text') return;
      const items = Array.from(e.clipboardData?.items || []);
      if (items.length === 0) return;
      // Don't capture if focus is inside an input/textarea
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      e.preventDefault();
      const store = useCanvasStore.getState();
      const { viewportPan, viewportZoom } = useAppStore.getState();
      // Place pasted content near center of current viewport
      const cx = -viewportPan.x / viewportZoom + (window.innerWidth / 2) / viewportZoom;
      const cy = -viewportPan.y / viewportZoom + (window.innerHeight / 2) / viewportZoom;

      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (!file) continue;
          // Save to disk via IPC for persistence across restarts
          const reader = new FileReader();
          reader.onload = async () => {
            const b64 = (reader.result as string).split(',')[1];
            const ext = (file.name?.split('.').pop() || 'png').toLowerCase();
            const result = await saveCanvasAsset(b64, ext);
            if (result.success && result.url) {
              store.addElement(makeImageElement(result, file.name || 'Pasted image', cx, cy));
            }
          };
          reader.readAsDataURL(file);
        } else if (item.type === 'text/plain') {
          const text = await new Promise<string>((res) => item.getAsString(res));
          if (!text.trim()) continue;
          store.addElement({
            id: `txt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            type: 'text',
            text: text.slice(0, 2000),
            x: cx,
            y: cy,
            fontSize: 14,
            strokeColor: '#EAF4F4',
            strokeWidth: 0,
            zIndex: store.elements.length,
            createdAt: Date.now(),
          });
        }
      }
    };
    window.addEventListener('paste', handler);
    return () => window.removeEventListener('paste', handler);
  }, []);

  // ── touch support ──────────────────────────────────────────────────────────
  const touchRef = useRef({ x: 0, y: 0, px: 0, py: 0, dist: 0, zoom: 1 });
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      touchRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, px: pan.x, py: pan.y, dist: 0, zoom };
    } else if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      touchRef.current = { x: 0, y: 0, px: pan.x, py: pan.y, dist: Math.sqrt(dx * dx + dy * dy), zoom };
    }
  }, [pan, zoom]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      setPan({
        x: touchRef.current.px + (e.touches[0].clientX - touchRef.current.x),
        y: touchRef.current.py + (e.touches[0].clientY - touchRef.current.y),
      });
    } else if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (touchRef.current.dist > 0) {
        setZoom(clampZoom(touchRef.current.zoom * (dist / touchRef.current.dist)));
      }
    }
  }, []);

  // ── Center-anchored zoom (keeps viewport stable, no jump to origin) ──
  const zoomToCenter = useCallback((factor: number) => {
    setZoom((prevZoom) => {
      const nextZoom = clampZoom(+(prevZoom * factor).toFixed(2));
      setPan((prevPan) => {
        const cx = window.innerWidth / 2;
        const cy = window.innerHeight / 2;
        return {
          x: cx - (cx - prevPan.x) * (nextZoom / prevZoom),
          y: cy - (cy - prevPan.y) * (nextZoom / prevZoom),
        };
      });
      return nextZoom;
    });
  }, []);

  // ── Fit all agent cards to screen ──
  const fitToScreen = useCallback(() => {
    if (agents.length === 0) { setZoom(1); setPan({ x: 0, y: 0 }); return; }
    const panels = agents.map(a => ({
      id: a.id, type: 'agent',
      x: a.x, y: a.y,
      width: a.width ?? 520, height: a.height ?? 360,
    }));
    const bbox = boundingBox(panels);
    const { pan, zoom } = frameViewport(bbox, winSize.w, winSize.h);
    setZoom(zoom);
    setPan(pan);
  }, [agents, winSize]);

  // ── minimap: viewport-synchronised (follows pan/zoom like a PiP) ─────
  const viewport = useMemo(() => {
    const left = -pan.x / zoom;
    const top = -pan.y / zoom;
    const w = winSize.w / zoom;
    const h = winSize.h / zoom;
    return { left, top, w, h };
  }, [pan.x, pan.y, zoom, winSize]);

  const minimapCards = useMemo(() => {
    const DEFAULT_W = 520, DEFAULT_H = 360;
    const vp = viewport;
    return agents.map((a) => {
      const cw = a.width || DEFAULT_W;
      const ch = a.height || DEFAULT_H;
      const rx = a.x - vp.left;
      const ry = a.y - vp.top;
      const mw = (cw / vp.w) * MINIMAP_W;
      const mh = (ch / vp.h) * MINIMAP_H;
      return {
        id: a.id,
        color: a.color,
        name: a.name,
        status: a.status,
        ml: (rx / vp.w) * MINIMAP_W,
        mt: (ry / vp.h) * MINIMAP_H,
        mw: Math.max(2, mw),
        mh: Math.max(1, mh),
      };
    });
  }, [agents, viewport]);

  // ── Virtualization: only render cards inside the buffered viewport ──
  const orderedAgents = useMemo(() => {
    if (!selectedAgentId) return agents;
    return [...agents].sort((left, right) => {
      if (left.id === selectedAgentId) return 1;
      if (right.id === selectedAgentId) return -1;
      return 0;
    });
  }, [agents, selectedAgentId]);

  const visibleAgents = useMemo(() => {
    if (orderedAgents.length === 0) return orderedAgents;

    // buffered viewport bounds in canvas coordinates
    const vpW = (winSize.w / zoom) * VP_BUFFER;
    const vpH = (winSize.h / zoom) * VP_BUFFER;
    const cx = -pan.x / zoom + (winSize.w / zoom) / 2;
    const cy = -pan.y / zoom + (winSize.h / zoom) / 2;
    const left = cx - vpW / 2;
    const top = cy - vpH / 2;
    const right = cx + vpW / 2;
    const bottom = cy + vpH / 2;

    return orderedAgents.filter((a) => {
      const cw = a.width || 520;
      const ch = a.height || 360;
      return (
        a.x + cw >= left &&
        a.y + ch >= top &&
        a.x <= right &&
        a.y <= bottom
      );
    });
  }, [orderedAgents, pan.x, pan.y, zoom, winSize]);

  // reverse mapping — minimap pixel → canvas coordinate
  const minimapToCanvas = useCallback((mx: number, my: number) => {
    const vp = viewport;
    return {
      cx: vp.left + (mx / MINIMAP_W) * vp.w,
      cy: vp.top + (my / MINIMAP_H) * vp.h,
    };
  }, [viewport]);

  // ── minimap interaction ────────────────────────────────────────────────────
  const goToCanvas = useCallback((cx: number, cy: number, nextZoom?: number) => {
    const targetZoom = nextZoom ?? zoom;
    setZoom(targetZoom);
    setPan({
      x: winSize.w / 2 - cx * targetZoom,
      y: winSize.h / 2 - cy * targetZoom,
    });
  }, [zoom, winSize]);

  // ── Cmd/Ctrl+K → focus selected agent ──────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'k' && (e.ctrlKey || e.metaKey)) {
        const { agents, selectedAgentId } = useAppStore.getState();
        if (!selectedAgentId) return;
        const agent = agents.find((item) => item.id === selectedAgentId);
        if (!agent) return;
        e.preventDefault();
        const cardW = agent.width || 520;
        const cardH = agent.height || 360;
        goToCanvas(agent.x + cardW / 2, agent.y + cardH / 2, 1);
        pokeIdleRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goToCanvas]);

  // ── Ctrl+Z / Ctrl+Shift+Z → undo / redo canvas elements ───
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key.toLowerCase() === 'z') {
        // Don't capture if focus is inside an input/textarea
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        e.preventDefault();
        if (e.shiftKey) {
          useCanvasStore.getState().redo();
        } else {
          useCanvasStore.getState().undo();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ── Canvas tools and element commands ──────────────────────────────────
  useEffect(() => {
    /** True while the user is typing somewhere a keystroke belongs. */
    const isTyping = (t: EventTarget | null): boolean => {
      const el = t as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
    };

    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      const store = useCanvasStore.getState();
      const key = e.key.toLowerCase();
      const mod = e.ctrlKey || e.metaKey;

      if (mod && !e.altKey) {
        if (key === 'a') {
          e.preventDefault();
          store.selectAll();
          return;
        }
        if (key === 'd') {
          e.preventDefault();
          store.duplicateElements(store.selectedElementIds);
          return;
        }
        // Ctrl+Z / Ctrl+Shift+Z are handled by the undo effect above.
        return;
      }
      if (e.altKey) return;

      // Space holds the hand tool for as long as it is down — the
      // pan gesture every canvas app has, and the reason select mode
      // no longer needs to steal the left button.
      if (e.code === 'Space' && !e.repeat) {
        e.preventDefault();
        if (store.activeTool !== 'hand') store.setActiveTool('hand');
        return;
      }

      const TOOL_KEYS: Record<string, CanvasToolName> = {
        v: 'select', h: 'hand', p: 'pen', b: 'pen',
        o: 'shape', r: 'shape', t: 'text', e: 'eraser',
      };
      if (TOOL_KEYS[key]) {
        e.preventDefault();
        // R and O both reach for the shape tool; make them pick the
        // shape they are named after rather than whatever was last used.
        if (key === 'r') store.setActiveShapeType('rect');
        if (key === 'o') store.setActiveShapeType('ellipse');
        store.setActiveTool(TOOL_KEYS[key]);
        return;
      }

      const ids = store.selectedElementIds;

      if (key === 'delete' || key === 'backspace') {
        if (ids.length === 0) return;
        e.preventDefault();
        // One call, one undo entry. Looping removeElement pushed a
        // separate snapshot per element, so undoing a multi-delete took
        // as many presses as there were elements.
        store.removeElements(ids);
        return;
      }

      if (key === 'escape') {
        store.clearSelection();
        return;
      }

      if (key === '[' || key === ']') {
        if (ids.length === 0) return;
        e.preventDefault();
        if (key === ']') store.bringToFront(ids); else store.sendToBack(ids);
        return;
      }

      const NUDGE: Record<string, [number, number]> = {
        arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1],
      };
      const dir = NUDGE[key];
      if (dir && ids.length > 0) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : store.snapToGrid ? store.gridSize : 1;
        store.moveElements(ids, dir[0] * step, dir[1] * step);
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      const store = useCanvasStore.getState();
      if (store.activeTool === 'hand') {
        store.setActiveTool(store.previousTool === 'hand' ? 'select' : store.previousTool);
      }
    };

    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  const handleMinimapClick = useCallback((e: React.MouseEvent) => {
    const rect = minimapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mmx = e.clientX - rect.left;
    const mmy = e.clientY - rect.top;

    // check if clicking inside a card rect
    for (const card of minimapCards) {
      if (mmx >= card.ml && mmx <= card.ml + card.mw &&
          mmy >= card.mt && mmy <= card.mt + card.mh) {
        const agent = agents.find((a) => a.id === card.id);
        if (agent) {
          const cw = agent.width || 520;
          const ch = agent.height || 360;
          goToCanvas(agent.x + cw / 2, agent.y + ch / 2);
        }
        return;
      }
    }
    // empty area → pan to that relative position
    const { cx, cy } = minimapToCanvas(mmx, mmy);
    goToCanvas(cx, cy);
  }, [minimapCards, agents, goToCanvas, minimapToCanvas]);

  return (
    <div
      ref={canvasRef}
      tabIndex={-1}
      style={{
        position: 'absolute', inset: 0, overflow: 'hidden',
        background: 'transparent',
      }}
    >
      {/* Grid background */}
      <div
        style={{
          position: 'absolute', inset: 0, zIndex: Z_BASE_LAYERS.canvasBackground, pointerEvents: 'none',
          backgroundImage: 'none',
          backgroundSize: '40px 40px',
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          transformOrigin: '0 0',
          transition: canvasTransition,
        }}
      />
      {/* Panning background — z-index 1, below agents at z-index 10 */}
      <div
        style={{
          position: 'absolute', inset: 0, zIndex: 1,
          cursor: isPanning ? 'grabbing'
            : (isShiftPanning || activeTool === 'hand') ? 'grab'
            : 'default',
        }}
        onMouseDown={handleCanvasMouseDown}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
      />

      {/* Transform container with agent cards */}
      <div
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          transformOrigin: '0 0',
          width: 0, height: 0,
          position: 'relative',
          zIndex: Z_BASE_LAYERS.agentDefault,
          transition: isPanning ? 'none' : canvasTransition,
        }}
      >
        {/* Delegation link lines */}
        <svg
          style={{
            position: 'absolute', left: 0, top: 0,
            width: 0, height: 0, overflow: 'visible',
            pointerEvents: 'none', zIndex: 0,
          }}
        >
          {delegationLinks.map((link) => {
            const fromAgent = agents.find((a) => a.id === link.fromAgentId);
            const toAgent = agents.find((a) => a.id === link.toAgentId);
            if (!fromAgent || !toAgent) return null;

            const fromCx = fromAgent.x + (fromAgent.width || 520) / 2;
            const fromCy = fromAgent.y + (fromAgent.height || 360) / 2;
            const toCx = toAgent.x + (toAgent.width || 520) / 2;
            const toCy = toAgent.y + (toAgent.height || 360) / 2;

            // Animate pulse for in-progress links
            const isActive = link.status === 'in-progress';
            const isDone = link.status === 'completed';
            const isFailed = link.status === 'failed';

            let strokeColor = 'rgba(255, 120, 31, 0.25)'; // amber/pending
            let strokeWidth = 1.5;
            if (isActive) { strokeColor = 'rgba(255, 120, 31, 0.6)'; strokeWidth = 2; }
            if (isDone) { strokeColor = 'rgba(107, 191, 138, 0.35)'; strokeWidth = 1; }
            if (isFailed) { strokeColor = 'rgba(231, 111, 81, 0.4)'; strokeWidth = 1; }

            // Glowing filter
            return (
              <g key={link.id}>
                {/* Glow layer */}
                <line
                  x1={fromCx} y1={fromCy} x2={toCx} y2={toCy}
                  stroke={strokeColor}
                  strokeWidth={isActive ? 6 : 3}
                  strokeLinecap="round"
                  opacity={isActive ? 0.3 : 0.12}
                />
                {/* Core line */}
                <line
                  x1={fromCx} y1={fromCy} x2={toCx} y2={toCy}
                  stroke={strokeColor}
                  strokeWidth={strokeWidth}
                  strokeLinecap="round"
                  strokeDasharray={isActive ? '6 3' : isDone ? 'none' : '3 3'}
                >
                  {isActive && (
                    <animate
                      attributeName="stroke-dashoffset"
                      from="0" to="-18"
                      dur="1s" repeatCount="indefinite"
                    />
                  )}
                </line>
                {/* Arrowhead at target */}
                <polygon
                  points={computeArrowhead(fromCx, fromCy, toCx, toCy, 8)}
                  fill={strokeColor}
                  opacity={isActive ? 0.7 : 0.3}
                />
              </g>
            );
          })}
        </svg>
        {visibleAgents.map((agent) => (
          <AgentCard
            key={agent.id}
            agent={agent}
            onClose={() => removeAgent(agent.id)}
          />
        ))}
        <MusicPlayer />
        <BrowserPreview />
        <ForgeNode />
        <BugReporter />
      </div>

      {/* Drawing layer — below agents in select mode, above when pen active */}
      <div style={{
        position: 'absolute', inset: 0,
        zIndex: activeTool === 'pen' ? 50 : Z_BASE_LAYERS.drawingInactive,
        pointerEvents: activeTool === 'pen' ? 'auto' : 'none',
      }}>
        <DrawingLayer pan={pan} zoom={zoom} />
      </div>
      {/* Vector layer — same strategy */}
      <div style={{
        position: 'absolute', inset: 0,
        zIndex: activeTool === 'shape' ? 51 : Z_BASE_LAYERS.vectorInactive,
        pointerEvents: activeTool === 'shape' ? 'auto' : 'none',
      }}>
        <VectorLayer pan={pan} zoom={zoom} />
      </div>
      {/* Text notes — moves with canvas pan/zoom */}
      <div style={{
        position: 'absolute', inset: 0, overflow: 'visible',
        transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
        transformOrigin: '0 0',
        zIndex: Z_BASE_LAYERS.canvasElements, pointerEvents: 'none',
      }}>
        <CanvasTextNotes zoom={zoom} />
        {/* Selection rectangle */}
        {selectionBox && (() => {
          const x = Math.min(selectionBox.x1, selectionBox.x2);
          const y = Math.min(selectionBox.y1, selectionBox.y2);
          const w = Math.abs(selectionBox.x2 - selectionBox.x1);
          const h = Math.abs(selectionBox.y2 - selectionBox.y1);
          return (
            <div style={{
              position: 'absolute',
              left: x, top: y,
              width: w, height: h,
              border: '1.5px dashed #F4A261',
              background: 'rgba(244, 162, 97, 0.08)',
              pointerEvents: 'none',
              zIndex: 999,
            }} />
          );
        })()}
      </div>
      {/* Media nodes — in world space, like every other element.
          This wrapper had no transform, so a pasted image sat in screen
          coordinates: it stayed put while the canvas panned under it,
          and its stored x/y meant nothing. */}
      <div style={{
        position: 'absolute', inset: 0, overflow: 'visible',
        transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
        transformOrigin: '0 0',
        zIndex: Z_BASE_LAYERS.canvasImages, pointerEvents: 'none',
      }}>
        <CanvasImages zoom={zoom} />
      </div>

      {/* Select / move / resize / rotate for shapes and strokes.
          Its hit surface sits under the cards and notes, so anything
          they do not consume is tested against canvas geometry, and
          empty space falls through to the pan-and-lasso handler. */}
      <CanvasSelectionLayer
        pan={pan}
        zoom={zoom}
        onBackgroundMouseDown={handleCanvasMouseDown}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
      />

      {/* Eraser overlay — appears above all elements when eraser tool active */}
      <EraserOverlay pan={pan} zoom={zoom} />

      {agents.length > 0 && minimapCards.length > 0 && (
        <div
          ref={minimapRef}
          data-minimap="true"
          onClick={handleMinimapClick}
          className="glass"
          style={{
            position: 'absolute', bottom: 24, right: 20,
            width: MINIMAP_W, height: MINIMAP_H,
            borderRadius: 'var(--radius-md)',
            background: 'rgba(14, 26, 20, 0.75)',
            border: '1px solid rgba(234, 244, 244, 0.07)',
            overflow: 'hidden',
            cursor: 'crosshair',
            zIndex: Z_BASE_LAYERS.minimap,
            boxShadow: '0 8px 32px rgba(0,0,0,0.35)',
            opacity: showMinimap ? 1 : 0,
            pointerEvents: showMinimap ? 'auto' : 'none',
            transition: 'opacity 0.35s ease',
            userSelect: 'none',
          }}
        >
        {/* empty state */}
        {agents.length === 0 && (
          <div
            style={{
              position: 'absolute', inset: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 9, color: 'var(--text-muted)', letterSpacing: 0.8,
              textTransform: 'uppercase', opacity: 0.35, pointerEvents: 'none',
            }}
          >
            minimap
          </div>
        )}

        {/* agent cards as minimap shapes */}
        {minimapCards.map((card) => {
          const isHovered = hoveredDot === card.id;
          const isActive = card.status === 'active' || card.status === 'busy';
          return (
            <div
              key={card.id}
              title={`${card.name} (${card.status})`}
              onMouseEnter={() => setHoveredDot(card.id)}
              onMouseLeave={() => setHoveredDot(null)}
              style={{
                position: 'absolute',
                left: card.ml,
                top: card.mt,
                width: card.mw,
                height: card.mh,
                borderRadius: isActive ? 3 : 2,
                background: card.color,
                opacity: 0.7,
                boxShadow: isHovered
                  ? `0 0 10px ${card.color}, inset 0 0 4px rgba(255,255,255,0.25)`
                  : `0 0 4px ${card.color}60`,
                transform: isHovered ? 'scale(1.15)' : 'scale(1)',
                transition: 'all var(--anim-fast)',
                pointerEvents: 'auto',
                cursor: 'pointer',
                border: isActive ? '1px solid rgba(255,255,255,0.25)' : 'none',
              }}
            />
          );
        })}

        {/* hover tooltip */}
        {hoveredDot && (
          <div
            style={{
              position: 'absolute',
              bottom: '100%', left: '50%',
              transform: 'translateX(-50%)',
              marginBottom: 6,
              padding: '3px 10px',
              borderRadius: 'var(--radius-sm)',
              background: 'rgba(14,26,20,0.88)',
              border: '1px solid var(--border)',
              fontSize: 10, fontWeight: 600, whiteSpace: 'nowrap',
              color: 'var(--text)',
              pointerEvents: 'none',
            }}
          >
            {(() => {
              const a = agents.find((x) => x.id === hoveredDot);
              return a ? `${a.name} · ${a.status}` : '';
            })()}
          </div>
        )}

        {/* bottom rim label */}
        <div
          style={{
            position: 'absolute', bottom: 4, right: 8,
            fontSize: 8, color: 'var(--text-muted)', opacity: 0.25,
            letterSpacing: 0.5,
            pointerEvents: 'none',
          }}
        >
          {agents.length} node{agents.length !== 1 ? 's' : ''}
        </div>
      </div>
      )}
 
         {agents.length > 0 && (
        <div
          className="glass"
          style={{
            position: 'absolute', bottom: 28, left: 20,
            display: 'flex', alignItems: 'center', gap: 2,
            padding: '4px', borderRadius: 'var(--radius-sm)',
            background: 'rgba(14,26,20,0.85)',
            border: '1px solid rgba(234,244,244,0.1)',
            zIndex: Z_BASE_LAYERS.zoomControls,
            userSelect: 'none',
          }}
        >
          <button onClick={() => zoomToCenter(0.8)} style={ZOOM_BTN} title="Zoom out">−</button>
          <span style={{ fontSize: 10, color: 'var(--text-muted)', minWidth: 36, textAlign: 'center', fontFamily: 'var(--font-mono)' }}>
            {Math.round(zoom * 100)}%
          </span>
          <button onClick={() => zoomToCenter(1.25)} style={ZOOM_BTN} title="Zoom in">+</button>
          <div style={{ width: 1, height: 12, background: 'var(--border-dim)', margin: '0 2px' }} />
          <button
            onClick={fitToScreen}
            style={{ ...ZOOM_BTN, fontSize: 9, color: 'var(--text-muted)' }}
            title="Fit all agents to screen"
          >⊡</button>
        </div>
        )}

        {/* Canvas workspace toolbar (left) */}
        <div style={{ position: 'absolute', inset: 0, zIndex: Z_BASE_LAYERS.chromeToolbar, pointerEvents: 'none' }}>
          <div style={{ pointerEvents: 'auto' }}>
            <CanvasToolbar />
          </div>
        </div>

        {/* Unified canvas tool panel (right) — properties per tool */}
        <div style={{ position: 'absolute', inset: 0, zIndex: Z_BASE_LAYERS.chromeToolbar, pointerEvents: 'none' }}>
          <div style={{ pointerEvents: 'auto' }}>
            <CanvasPropertiesPanel />
          </div>
        </div>

        {/* Drop zone overlay — handles file drag-and-drop */}
        <div
          style={{
            position: 'absolute', inset: 0, zIndex: Z_BASE_LAYERS.chromeToolbar,
            pointerEvents: 'none',
          }}
          onDragOver={(e) => { e.preventDefault(); }}
          onDrop={async (e) => {
            e.preventDefault();
            const files = Array.from(e.dataTransfer.files || []);
            const rect = canvasRef.current?.getBoundingClientRect();
            if (!rect) return;
            const sx = e.clientX - rect.left;
            const sy = e.clientY - rect.top;
            const cx = (sx - pan.x) / zoom;
            const cy = (sy - pan.y) / zoom;

            for (const file of files) {
              if (file.type.startsWith('image/')) {
                // Save to disk via IPC for persistence across restarts
                const reader = new FileReader();
                reader.onload = async () => {
                  const b64 = (reader.result as string).split(',')[1];
                  const ext = (file.name.split('.').pop() || 'png').toLowerCase();
                  const result = await saveCanvasAsset(b64, ext);
                  if (result.success && result.url) {
                    addElement(makeImageElement(result, file.name, cx, cy));
                  }
                };
                reader.readAsDataURL(file);
              } else if (file.type.startsWith('text/')) {
                const text = await file.text();
                addElement({
                  id: `txt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                  type: 'text',
                  text: text.slice(0, 2000),
                  x: cx,
                  y: cy,
                  fontSize: 13,
                  strokeColor: '#EAF4F4',
                  strokeWidth: 0,
                  zIndex: useCanvasStore.getState().elements.length,
                  createdAt: Date.now(),
                });
              }
            }
          }}
        />
      </div>
  );
};
