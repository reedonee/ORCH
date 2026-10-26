// ── Canvas Media Node ───────────────────────────────────────────
// An image or file on the canvas. No chrome: the media IS the node.
//
// Drag anywhere on it to move. Approach an edge or corner and the cursor
// becomes a resize arrow — there is no visible handle, because a handle
// is a permanent piece of furniture on something that should read as a
// bare image sitting on the canvas.
//
// Dragging onto a running agent hands it the file. That is the natural
// gesture for "look at this" — a screenshot of a broken UI, a design
// mock — and the alternative is typing an absolute path into a terminal.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useCanvasStore, type CanvasElement } from '../stores/useCanvasStore';
import { useAppStore } from '../stores/useAppStore';
import { useTerminalStore } from '../stores/useTerminalStore';
import { shortName } from '../lib/voice-narration';
import { File as FileIcon, Send } from 'lucide-react';

interface Props {
  el: CanvasElement;
  /** Canvas zoom, to convert screen pointer deltas into canvas units. */
  zoom: number;
}

const MIN_W = 80;
const MIN_H = 60;

/** How close to an edge (in screen px) counts as "on" it. */
const EDGE = 10;

type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw' | null;

const CURSOR: Record<string, string> = {
  n: 'ns-resize', s: 'ns-resize',
  e: 'ew-resize', w: 'ew-resize',
  ne: 'nesw-resize', sw: 'nesw-resize',
  nw: 'nwse-resize', se: 'nwse-resize',
};

/** Which edge, if any, a point sits on within a rect. */
function edgeAt(e: React.MouseEvent, rect: DOMRect): Edge {
  const nearL = e.clientX - rect.left <= EDGE;
  const nearR = rect.right - e.clientX <= EDGE;
  const nearT = e.clientY - rect.top <= EDGE;
  const nearB = rect.bottom - e.clientY <= EDGE;

  if (nearT && nearL) return 'nw';
  if (nearT && nearR) return 'ne';
  if (nearB && nearL) return 'sw';
  if (nearB && nearR) return 'se';
  if (nearT) return 'n';
  if (nearB) return 's';
  if (nearL) return 'w';
  if (nearR) return 'e';
  return null;
}

/** Agent card under a viewport point, if any. */
function agentCardAt(clientX: number, clientY: number): string | null {
  const el = document.elementFromPoint(clientX, clientY);
  const card = el?.closest('[data-agent-card="true"]') as HTMLElement | null;
  if (!card) return null;
  return card.id.replace(/^agent-card-/, '') || null;
}

interface Gesture {
  mode: 'move' | 'resize';
  edge: Edge;
  x: number; y: number;
  ox: number; oy: number; ow: number; oh: number;
}

export const CanvasMediaNode: React.FC<Props> = ({ el, zoom }) => {
  const updateElement = useCanvasStore((s) => s.updateElement);
  const removeElement = useCanvasStore((s) => s.removeElement);
  const setDragTarget = useCanvasStore((s) => s.setDragTarget);

  const rootRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<Gesture | null>(null);

  const [failed, setFailed] = useState(false);
  const [hoverAgentId, setHoverAgentId] = useState<string | null>(null);
  const [hoverEdge, setHoverEdge] = useState<Edge>(null);
  // `active` alone isn't enough for the cursor: the render path needs to
  // know WHICH gesture is running, and a ref mutation triggers no
  // re-render, so reading gestureRef here would never update the cursor.
  const [active, setActive] = useState<null | 'move' | 'resize'>(null);
  const [selected, setSelected] = useState(false);
  const [busy, setBusy] = useState(false);

  const meta = el.fileMeta;
  const kind = meta?.kind ?? 'image';

  // ── Match the image's real aspect ratio ─────────────────────
  // Dropped images arrive in a placeholder box; a fixed box letterboxes
  // anything that isn't the same shape.
  const onImageLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    if (!img.naturalWidth || !img.naturalHeight) return;
    const w = el.width ?? 320;
    const h = Math.round(w * (img.naturalHeight / img.naturalWidth));
    // Quiet: matching the intrinsic aspect ratio is derived from the
    // decoded image, not something the user did, so it does not belong
    // on the undo stack.
    if (Math.abs((el.height ?? 0) - h) > 2) {
      useCanvasStore.getState().updateElementQuiet(el.id, { height: h });
    }
  }, [el.id, el.width, el.height]);

  // ── Gesture start ───────────────────────────────────────────
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;

    e.preventDefault();
    e.stopPropagation();
    setSelected(true);

    const edge = edgeAt(e, rect);
    gestureRef.current = {
      mode: edge ? 'resize' : 'move',
      edge,
      x: e.clientX, y: e.clientY,
      ox: el.x ?? 0, oy: el.y ?? 0,
      ow: el.width ?? 320, oh: el.height ?? 200,
    };
    setActive(edge ? 'resize' : 'move');
    // The gesture is one undo step. Without this, updateElement's
    // per-call snapshot turned a single drag into a few hundred entries
    // and Ctrl+Z crawled back a pixel at a time.
    useCanvasStore.getState().beginInteraction();
    setDragTarget(el.id);
  }, [el.id, el.x, el.y, el.width, el.height, setDragTarget]);

  // ── Cursor feedback ─────────────────────────────────────────
  const onMouseMoveLocal = useCallback((e: React.MouseEvent) => {
    if (gestureRef.current) return; // mid-gesture; cursor is already set
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    setHoverEdge(edgeAt(e, rect));
  }, []);

  // ── Gesture tracking ────────────────────────────────────────
  useEffect(() => {
    if (!active) return;

    const onMove = (e: MouseEvent) => {
      const g = gestureRef.current;
      if (!g) return;
      // Pointer deltas are screen pixels; canvas coordinates are zoomed.
      const dx = (e.clientX - g.x) / zoom;
      const dy = (e.clientY - g.y) / zoom;

      if (g.mode === 'move') {
        updateElement(el.id, { x: g.ox + dx, y: g.oy + dy });
        setHoverAgentId(agentCardAt(e.clientX, e.clientY));
        return;
      }

      // Resize. Dragging a north/west edge moves the origin as well as
      // the size, so the opposite edge stays put.
      const edge = g.edge ?? 'se';
      let { ox: x, oy: y, ow: w, oh: h } = g;

      if (edge.includes('e')) w = Math.max(MIN_W, g.ow + dx);
      if (edge.includes('s')) h = Math.max(MIN_H, g.oh + dy);
      if (edge.includes('w')) {
        w = Math.max(MIN_W, g.ow - dx);
        x = g.ox + (g.ow - w);
      }
      if (edge.includes('n')) {
        h = Math.max(MIN_H, g.oh - dy);
        y = g.oy + (g.oh - h);
      }
      updateElement(el.id, { x, y, width: w, height: h });
    };

    const onUp = async (e: MouseEvent) => {
      const g = gestureRef.current;
      gestureRef.current = null;
      setActive(null);
      setDragTarget(null);
      useCanvasStore.getState().endInteraction();
      if (!g) return;

      const target = g.mode === 'move' ? agentCardAt(e.clientX, e.clientY) : null;
      setHoverAgentId(null);
      if (!target) return;

      // Hand the file over as a path — the one reference every CLI agent
      // already understands, with no per-provider handling.
      const agent = useAppStore.getState().agents.find((a) => a.id === target);
      const path = el.fileMeta?.path;
      if (!agent?.terminalId || !path) return;

      setBusy(true);
      try {
        await useTerminalStore.getState().writeToTerminal(agent.terminalId, path);
        useAppStore.getState().setSelectedAgent(agent.id);
        useAppStore.getState().pushToast({
          text: `Gave the image to ${shortName(agent.name)}`,
          tone: 'success',
        });
      } finally {
        setBusy(false);
      }
      // The node belongs on the canvas, not inside the card.
      updateElement(el.id, { x: g.ox, y: g.oy });
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [active, zoom, el.id, el.fileMeta?.path, updateElement, setDragTarget]);

  // ── Deselect / delete ───────────────────────────────────────
  // Delete replaces a close button: a permanent × on every image is
  // clutter, and Delete-on-selection is the canvas idiom users expect.
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        removeElement(el.id);
      } else if (e.key === 'Escape') {
        setSelected(false);
      }
    };
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setSelected(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [selected, el.id, removeElement]);

  // ── Highlight the agent under the cursor ────────────────────
  useEffect(() => {
    if (!hoverAgentId) return;
    const card = document.getElementById(`agent-card-${hoverAgentId}`);
    if (!card) return;
    const prevOutline = card.style.outline;
    const prevOffset = card.style.outlineOffset;
    card.style.outline = '2px solid #6BBF8A';
    card.style.outlineOffset = '3px';
    return () => {
      card.style.outline = prevOutline;
      card.style.outlineOffset = prevOffset;
    };
  }, [hoverAgentId]);

  const dropping = hoverAgentId !== null;

  const cursor = active === 'move' ? 'grabbing'
    : hoverEdge ? CURSOR[hoverEdge]
    : 'grab';

  const isImage = kind === 'image' && el.src && !failed;
  const isVideo = kind === 'video' && el.src && !failed;

  return (
    <div
      ref={rootRef}
      data-canvas-media={el.id}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMoveLocal}
      onMouseLeave={() => setHoverEdge(null)}
      style={{
        position: 'absolute',
        left: el.x ?? 0,
        top: el.y ?? 0,
        width: el.width || 320,
        height: el.height || 'auto',
        zIndex: el.zIndex,
        cursor,
        // The layer above sets pointerEvents:'none' so clicks fall through
        // to the canvas on empty space — the node has to opt back in, or
        // it can never be dragged at all.
        pointerEvents: 'auto',
        userSelect: 'none',
        // No frame, no caption, no buttons: the media is the node. A ring
        // appears only while selected or being dropped on an agent.
        borderRadius: 6,
        outline: dropping ? '2px solid #6BBF8A'
          : selected ? '1.5px solid var(--accent)'
          : 'none',
        outlineOffset: 2,
        boxShadow: dropping
          ? '0 0 0 5px rgba(107,191,138,0.20), 0 10px 30px rgba(0,0,0,0.45)'
          : '0 6px 22px rgba(0,0,0,0.38)',
        overflow: 'hidden',
      }}
    >
      {isImage && (
        <img
          src={el.src}
          alt={el.alt || ''}
          onLoad={onImageLoad}
          onError={() => setFailed(true)}
          draggable={false}
          style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block', pointerEvents: 'none' }}
        />
      )}

      {isVideo && (
        <video
          src={el.src}
          controls
          preload="metadata"
          onError={() => setFailed(true)}
          // Controls need their own events; the edges still resize.
          onMouseDown={(e) => { if (!hoverEdge) e.stopPropagation(); }}
          style={{ width: '100%', height: '100%', background: '#000', display: 'block' }}
        />
      )}

      {!isImage && !isVideo && (
        <div style={{
          width: '100%', height: '100%',
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 8,
          background: 'var(--surface)',
          border: '1px solid var(--border-dim)',
          borderRadius: 6,
          color: 'var(--text-secondary)', fontSize: 11, padding: 12, textAlign: 'center',
        }}>
          <FileIcon size={22} />
          <span style={{ wordBreak: 'break-all', opacity: 0.7 }}>
            {meta?.path?.split(/[\\/]/).pop() ?? el.alt ?? 'File'}
          </span>
        </div>
      )}

      {dropping && (
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
          background: 'rgba(107,191,138,0.28)',
          color: '#08140E', fontSize: 12, fontWeight: 700,
          fontFamily: "'JetBrains Mono', monospace",
          pointerEvents: 'none', textShadow: '0 1px 2px rgba(255,255,255,0.35)',
        }}>
          <Send size={13} />
          Release to give to {shortName(useAppStore.getState().agents.find((a) => a.id === hoverAgentId)?.name ?? 'agent')}
        </div>
      )}

      {busy && (
        <div style={{
          position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--text)', fontSize: 11, pointerEvents: 'none',
        }}>
          Sending…
        </div>
      )}
    </div>
  );
};
