import React, { useRef, useState, useCallback, useEffect, useMemo } from 'react';
import { AgentCard } from './AgentCard';
import { useAppStore } from '../stores/useAppStore';
import { useCanvasStore } from '../stores/useCanvasStore';
import { useWorkspaceStore } from '../stores/useWorkspaceStore';
import { DrawingLayer } from './DrawingLayer';
import { VectorLayer } from './VectorLayer';
import { CanvasToolbar } from './CanvasToolbar';
import { CanvasTextNotes, CanvasImages } from './CanvasElements';
import { CanvasPropertiesPanel } from './CanvasPropertiesPanel';
import { EraserOverlay } from './EraserOverlay';
import { invoke } from '../lib/electron-api';

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

export const InfiniteCanvas: React.FC = () => {
  const agents = useAppStore((s) => s.agents);
  const removeAgent = useAppStore((s) => s.removeAgent);
  const updateAgentPositions = useAppStore((s) => s.updateAgentPositions);
  const selectedAgentId = useAppStore((s) => s.selectedAgentId);
  const focusTarget = useAppStore((s) => s.focusTarget);
  const clearFocusTarget = useAppStore((s) => s.clearFocusTarget);
  const delegationLinks = useAppStore((s) => s.delegationLinks);
  const activeTool = useCanvasStore((s) => s.activeTool);
  const addElement = useCanvasStore((s) => s.addElement);
  // const setActiveTool = useCanvasStore((s) => s.setActiveTool);

  const canvasRef = useRef<HTMLDivElement>(null);
  const minimapRef = useRef<HTMLDivElement>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef({ x: 0, y: 0, mx: 0, my: 0 });
  const [winSize, setWinSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [hoveredDot, setHoveredDot] = useState<string | null>(null);
  const [showMinimap, setShowMinimap] = useState(true);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pokeIdleRef = useRef<() => void>(() => {});

  const pokeIdle = useCallback(() => {
    setShowMinimap(true);
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => setShowMinimap(false), 1000);
  }, []);

  // keep ref in sync so effects with stable deps can use it
  pokeIdleRef.current = pokeIdle;

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

  // ── window resize ──────────────────────────────────────────────────────────
  useEffect(() => {
    const onResize = () => setWinSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // ── wheel zoom ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest('[data-agent-card]')) return;
      e.preventDefault();
      pokeIdleRef.current();
      const dz = e.deltaY > 0 ? 0.9 : 1.1;
      setZoom((z) => Math.min(Math.max(z * dz, 0.1), 5));
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
        store.addElement({
          id: `txt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          type: 'text',
          text: 'Type here',
          x: cx, y: cy,
          fontSize: store.fontSize || 14,
          strokeColor: '#EAF4F4',
          strokeWidth: 0,
          zIndex: store.elements.length,
          createdAt: Date.now(),
        });
        store.setActiveTool('select');
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
            const result = await invoke<{ success: boolean; path: string }>('save_canvas_asset', { data: b64, ext: 'png' });
            if (result.success) {
              store.addElement({
                id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                type: 'image',
                src: `file://${result.path}`,
                alt: file.name,
                x: cx, y: cy,
                width: 200,
                strokeColor: 'transparent',
                strokeWidth: 0,
                zIndex: store.elements.length,
                createdAt: Date.now(),
              });
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
        setZoom(Math.min(Math.max(touchRef.current.zoom * (dist / touchRef.current.dist), 0.1), 5));
      }
    }
  }, []);

  // ── Center-anchored zoom (keeps viewport stable, no jump to origin) ──
  const zoomToCenter = useCallback((factor: number) => {
    setZoom((prevZoom) => {
      const nextZoom = Math.min(5, Math.max(0.25, +(prevZoom * factor).toFixed(2)));
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
    // Compute bounding box of all agent positions
    const CARD_W = 340; const CARD_H = 320; const GAP = 20;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const a of agents) {
      if (a.x < minX) minX = a.x; if (a.y < minY) minY = a.y;
      if (a.x + CARD_W > maxX) maxX = a.x + CARD_W;
      if (a.y + CARD_H > maxY) maxY = a.y + CARD_H;
    }
    const contentW = maxX - minX + GAP;
    const contentH = maxY - minY + GAP;
    const scaleX = (window.innerWidth - 60) / contentW;
    const scaleY = (window.innerHeight - 60) / contentH;
    const fitZoom = Math.min(1, Math.min(scaleX, scaleY));
    const centerX = (minX + maxX) / 2 * fitZoom;
    const centerY = (minY + maxY) / 2 * fitZoom;
    setZoom(fitZoom);
    setPan({ x: window.innerWidth / 2 - centerX, y: window.innerHeight / 2 - centerY });
  }, [agents]);

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
          position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none',
          backgroundImage: 'none',
          backgroundSize: '40px 40px',
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          transformOrigin: '0 0',
        }}
      />
      {/* Panning background — z-index 1, below agents at z-index 10 */}
      <div
        style={{
          position: 'absolute', inset: 0, zIndex: 1, cursor: isPanning ? 'grabbing' : 'grab',
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
          zIndex: 10,
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
      </div>

      {/* Drawing layer — below agents in select mode, above when pen active */}
      <div style={{
        position: 'absolute', inset: 0,
        zIndex: activeTool === 'pen' ? 50 : 8,
        pointerEvents: activeTool === 'pen' ? 'auto' : 'none',
      }}>
        <DrawingLayer pan={pan} zoom={zoom} />
      </div>
      {/* Vector layer — same strategy */}
      <div style={{
        position: 'absolute', inset: 0,
        zIndex: activeTool === 'shape' ? 51 : 9,
        pointerEvents: activeTool === 'shape' ? 'auto' : 'none',
      }}>
        <VectorLayer pan={pan} zoom={zoom} />
      </div>
      {/* Text notes — moves with canvas pan/zoom */}
      <div style={{
        position: 'absolute', inset: 0, overflow: 'visible',
        transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
        transformOrigin: '0 0',
        zIndex: 60, pointerEvents: 'none',
      }}>
        <CanvasTextNotes />
      </div>
      {/* Dropped images — below everything */}
      <div style={{ position: 'absolute', inset: 0, zIndex: 7, pointerEvents: 'none' }}>
        <CanvasImages />
      </div>

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
            zIndex: 100,
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
            zIndex: 110,
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
        <div style={{ position: 'absolute', inset: 0, zIndex: 200, pointerEvents: 'none' }}>
          <div style={{ pointerEvents: 'auto' }}>
            <CanvasToolbar />
          </div>
        </div>

        {/* Unified canvas tool panel (right) — properties per tool */}
        <div style={{ position: 'absolute', inset: 0, zIndex: 200, pointerEvents: 'none' }}>
          <div style={{ pointerEvents: 'auto' }}>
            <CanvasPropertiesPanel />
          </div>
        </div>

        {/* Drop zone overlay — handles file drag-and-drop */}
        <div
          style={{
            position: 'absolute', inset: 0, zIndex: 200,
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
                  const result = await invoke<{ success: boolean; path: string }>('save_canvas_asset', { data: b64, ext: 'png' });
                  if (result.success) {
                    addElement({
                      id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                      type: 'image',
                      src: `file://${result.path}`,
                      alt: file.name,
                      x: cx, y: cy,
                      width: 200,
                      strokeColor: 'transparent',
                      strokeWidth: 0,
                      zIndex: useCanvasStore.getState().elements.length,
                      createdAt: Date.now(),
                    });
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
