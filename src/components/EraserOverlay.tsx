// ── ORCH Eraser Overlay ───────────────────────────────────────
// Drag to erase, with a brush you can see.
//
// The old eraser deleted on click and hit-tested strokes by sampling
// their stored vertices — which, after simplification, can sit 60 units
// apart. A stroke was effectively unerasable anywhere except right on a
// sample point, and a whole erasing pass left one undo entry per
// deleted element.
//
// Now: the brush sweeps a segment per pointer move, hit-testing against
// real geometry (see canvas-geometry), and a whole pass is one undo
// step.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useCanvasStore } from '../stores/useCanvasStore';
import { hitTestElement, type Rect } from '../lib/canvas-geometry';
import { useLatestRef } from '../lib/use-latest-ref';

interface EraserOverlayProps {
  pan: { x: number; y: number };
  zoom: number;
}

/** Brush radius in screen pixels, before the stroke-width modifier. */
const BASE_RADIUS = 12;

export const EraserOverlay: React.FC<EraserOverlayProps> = ({ pan, zoom }) => {
  const activeTool = useCanvasStore((s) => s.activeTool);
  const strokeWidth = useCanvasStore((s) => s.strokeWidth);

  const rootRef = useRef<HTMLDivElement>(null);
  const brushRef = useRef<HTMLDivElement>(null);
  const erasingRef = useRef(false);
  const lastRef = useRef<{ x: number; y: number } | null>(null);
  const [doomed, setDoomed] = useState<Rect[]>([]);

  const isEraser = activeTool === 'eraser';
  const radiusPx = BASE_RADIUS + strokeWidth * 2;

  const viewRef = useLatestRef({ pan, zoom, radiusPx });

  const toCanvas = useCallback((clientX: number, clientY: number) => {
    const rect = rootRef.current?.getBoundingClientRect();
    const { pan: p, zoom: z } = viewRef.current;
    if (!rect) return { x: clientX, y: clientY };
    return { x: (clientX - rect.left - p.x) / z, y: (clientY - rect.top - p.y) / z };
  }, [viewRef]);

  /**
   * Erase everything the brush touched between two samples.
   *
   * Testing only the current point leaves gaps at any speed the pointer
   * can actually move, so the segment is walked at brush-radius steps.
   */
  const sweep = useCallback((from: { x: number; y: number } | null, to: { x: number; y: number }) => {
    const store = useCanvasStore.getState();
    const r = viewRef.current.radiusPx / viewRef.current.zoom;

    const samples: Array<{ x: number; y: number }> = [to];
    if (from) {
      const dist = Math.hypot(to.x - from.x, to.y - from.y);
      const steps = Math.min(64, Math.ceil(dist / Math.max(1, r * 0.6)));
      for (let i = 1; i < steps; i++) {
        samples.push({
          x: from.x + ((to.x - from.x) * i) / steps,
          y: from.y + ((to.y - from.y) * i) / steps,
        });
      }
    }

    const kill: string[] = [];
    for (const el of store.elements) {
      if (el.locked) continue;
      if (samples.some((s) => hitTestElement(s, el, r))) kill.push(el.id);
    }
    if (kill.length > 0) store.removeElements(kill);
  }, [viewRef]);

  const moveBrush = useCallback((clientX: number, clientY: number) => {
    const rect = rootRef.current?.getBoundingClientRect();
    const brush = brushRef.current;
    if (!rect || !brush) return;
    // Positioned imperatively: a state update per pointer move would
    // re-render the whole overlay 120 times a second for a cursor.
    brush.style.transform =
      `translate(${clientX - rect.left}px, ${clientY - rect.top}px) translate(-50%, -50%)`;
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const store = useCanvasStore.getState();
    // One undo step for the whole pass, however many elements it eats.
    store.beginInteraction();
    erasingRef.current = true;
    const pt = toCanvas(e.clientX, e.clientY);
    lastRef.current = pt;
    setDoomed([]);
    sweep(null, pt);
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
  }, [toCanvas, sweep]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    moveBrush(e.clientX, e.clientY);
    const pt = toCanvas(e.clientX, e.clientY);

    if (erasingRef.current) {
      sweep(lastRef.current, pt);
      lastRef.current = pt;
      return;
    }

    // Not pressed: show what a click would take. Highlighting before
    // committing is the difference between an eraser and a trapdoor.
    const store = useCanvasStore.getState();
    const r = viewRef.current.radiusPx / viewRef.current.zoom;
    const hits: Rect[] = [];
    for (const el of store.elements) {
      if (el.locked) continue;
      if (!hitTestElement(pt, el, r)) continue;
      const b = el.type === 'drawing'
        ? null
        : { x: el.x ?? 0, y: el.y ?? 0, width: el.width ?? 0, height: el.height ?? 0 };
      if (b && b.width && b.height) hits.push(b);
    }
    setDoomed((prev) =>
      prev.length === hits.length &&
      prev.every((p, i) => p.x === hits[i].x && p.y === hits[i].y && p.width === hits[i].width)
        ? prev
        : hits,
    );
  }, [toCanvas, sweep, moveBrush, viewRef]);

  const stop = useCallback(() => {
    if (!erasingRef.current) return;
    erasingRef.current = false;
    lastRef.current = null;
    useCanvasStore.getState().endInteraction();
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    stop();
  }, [stop]);

  // Switching tools or losing the window mid-pass must close the undo
  // group, or every later edit joins it and Ctrl+Z swallows the lot.
  useEffect(() => {
    if (!isEraser) { stop(); return; }
    window.addEventListener('blur', stop);
    return () => { window.removeEventListener('blur', stop); stop(); };
  }, [isEraser, stop]);

  if (!isEraser) return null;

  return (
    <div
      ref={rootRef}
      style={{ position: 'absolute', inset: 0, zIndex: 65, cursor: 'none', overflow: 'hidden' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={() => { if (brushRef.current) brushRef.current.style.opacity = '0'; }}
      onPointerEnter={() => { if (brushRef.current) brushRef.current.style.opacity = '1'; }}
    >
      {/* What the brush is currently over. */}
      <svg
        style={{
          position: 'absolute', inset: 0, width: '100%', height: '100%',
          overflow: 'visible', pointerEvents: 'none',
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          transformOrigin: '0 0',
        }}
      >
        {doomed.map((b, i) => (
          <rect
            key={i}
            x={b.x} y={b.y} width={b.width} height={b.height}
            fill="rgba(231,111,81,0.14)"
            stroke="#E76F51"
            strokeWidth={1.5 / (zoom || 1)}
            strokeDasharray={`${4 / (zoom || 1)} ${3 / (zoom || 1)}`}
          />
        ))}
      </svg>

      <div
        ref={brushRef}
        style={{
          position: 'absolute', left: 0, top: 0,
          width: radiusPx * 2, height: radiusPx * 2,
          borderRadius: '50%',
          border: '1.5px solid rgba(231,111,81,0.9)',
          background: 'rgba(231,111,81,0.12)',
          boxShadow: '0 0 0 1px rgba(0,0,0,0.35)',
          pointerEvents: 'none',
          willChange: 'transform',
        }}
      />
    </div>
  );
};
