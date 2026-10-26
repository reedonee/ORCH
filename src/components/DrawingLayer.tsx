// ── ORCH Drawing Layer ─────────────────────────────────────────
// HTML5 Canvas for freehand strokes.
//
// Two things make this fast enough to draw on:
//
//   1. The live stroke lives in a ref, not the store. Pushing a point
//      per pointer sample meant a new array and a store notification
//      every few milliseconds — O(n^2) copying plus a re-render of
//      every subscriber, which is what made long strokes stutter.
//   2. Committed strokes are rendered once into an offscreen canvas and
//      blitted. Only the in-progress stroke is re-rendered per frame,
//      so cost is independent of how much is already on the canvas.
//
// Painting is rAF-driven off a dirty flag, so a burst of pointer events
// inside one frame costs one repaint.

import React, { useRef, useEffect, useCallback } from 'react';
import { useCanvasStore, type CanvasElement, type CanvasPoint } from '../stores/useCanvasStore';
import { sortByPaintOrder, traceSmoothPolyline } from '../lib/canvas-geometry';
import { withAlpha } from '../lib/color';
import { useLatestRef } from '../lib/use-latest-ref';

interface DrawingLayerProps {
  pan: { x: number; y: number };
  zoom: number;
}

/** Dash patterns in canvas units, scaled by the nib. */
function dashPattern(dash: string | undefined, w: number): number[] {
  if (dash === 'dashed') return [w * 3, w * 2.2];
  if (dash === 'dotted') return [0.1, w * 2.2];
  return [];
}

/** Nib width at each vertex, from pressure when the device reported it. */
function widthsFor(el: CanvasElement): number[] | null {
  if (!el.widths || !el.points || el.widths.length !== el.points.length) return null;
  // A mouse reports a constant 0.5 pressure, which yields a constant
  // width — no point paying for the segment-wise path in that case.
  const first = el.widths[0];
  return el.widths.some((w) => Math.abs(w - first) > 0.15) ? el.widths : null;
}

function strokeElement(ctx: CanvasRenderingContext2D, el: CanvasElement): void {
  const pts = el.points;
  if (!pts || pts.length < 2) return;

  ctx.strokeStyle = el.strokeColor;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalAlpha = el.opacity ?? 1;

  const varying = widthsFor(el);
  if (varying) {
    // Variable nib: each segment carries its own width, so it cannot
    // share a single path.
    ctx.setLineDash([]);
    for (let i = 1; i < pts.length; i++) {
      ctx.beginPath();
      ctx.lineWidth = Math.max(0.2, (varying[i - 1] + varying[i]) / 2);
      ctx.moveTo(pts[i - 1].x, pts[i - 1].y);
      ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
    }
  } else {
    ctx.lineWidth = el.strokeWidth || 2;
    ctx.setLineDash(dashPattern(el.dash, el.strokeWidth || 2));
    ctx.beginPath();
    traceSmoothPolyline(ctx, pts);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.globalAlpha = 1;
}

export const DrawingLayer: React.FC<DrawingLayerProps> = ({ pan, zoom }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** Cache of everything already committed, at the current transform. */
  const staticRef = useRef<HTMLCanvasElement | null>(null);
  const staticDirty = useRef(true);
  const frameRef = useRef<number | null>(null);

  // Live stroke — deliberately outside React and outside the store.
  const liveRef = useRef<CanvasPoint[]>([]);
  const liveWidthsRef = useRef<number[]>([]);
  const drawingRef = useRef(false);

  // Narrow subscriptions: this component repaints on element and style
  // changes, and must not wake for unrelated canvas state.
  const elements = useCanvasStore((s) => s.elements);
  const activeTool = useCanvasStore((s) => s.activeTool);
  const strokeColor = useCanvasStore((s) => s.strokeColor);
  const strokeWidth = useCanvasStore((s) => s.strokeWidth);
  const dashStyle = useCanvasStore((s) => s.dashStyle);
  const selectedIds = useCanvasStore((s) => s.selectedElementIds);

  const isPen = activeTool === 'pen';

  const viewRef = useLatestRef({ pan, zoom });
  const styleRef = useLatestRef({ strokeColor, strokeWidth, dashStyle });

  // Screen coords (client) → canvas workspace coords.
  const screenToCanvas = useCallback((clientX: number, clientY: number): CanvasPoint => {
    const rect = canvasRef.current?.getBoundingClientRect();
    const { pan: p, zoom: z } = viewRef.current;
    if (!rect) return { x: clientX, y: clientY };
    return { x: (clientX - rect.left - p.x) / z, y: (clientY - rect.top - p.y) / z };
  }, [viewRef]);

  // ── Static cache ────────────────────────────────────────────
  const rebuildStatic = useCallback((w: number, h: number, dpr: number) => {
    let off = staticRef.current;
    if (!off) {
      off = document.createElement('canvas');
      staticRef.current = off;
    }
    if (off.width !== w * dpr || off.height !== h * dpr) {
      off.width = Math.max(1, Math.round(w * dpr));
      off.height = Math.max(1, Math.round(h * dpr));
    }
    const ctx = off.getContext('2d');
    if (!ctx) return;

    const { pan: p, zoom: z } = viewRef.current;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.scale(z, z);

    const selected = new Set(selectedIds);
    for (const el of sortByPaintOrder(elements)) {
      if (el.type !== 'drawing') continue;

      // Selection reads as a halo behind the stroke rather than a box
      // around it — a freehand mark is rarely rectangular.
      if (selected.has(el.id) && el.points && el.points.length > 1) {
        ctx.save();
        ctx.strokeStyle = withAlpha('#F4A261', 0.45);
        ctx.lineWidth = (el.strokeWidth || 2) + 6 / z;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        traceSmoothPolyline(ctx, el.points);
        ctx.stroke();
        ctx.restore();
      }

      strokeElement(ctx, el);
    }
    ctx.restore();
    staticDirty.current = false;
  }, [elements, selectedIds, viewRef]);

  // ── Compose: blit the cache, then the live stroke ───────────
  const paint = useCallback(() => {
    frameRef.current = null;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;

    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      staticDirty.current = true;
    }

    if (staticDirty.current) rebuildStatic(w, h, dpr);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (staticRef.current) ctx.drawImage(staticRef.current, 0, 0);

    const live = liveRef.current;
    if (drawingRef.current && live.length > 1) {
      const { pan: p, zoom: z } = viewRef.current;
      const st = styleRef.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.scale(z, z);
      strokeElement(ctx, {
        id: 'live', type: 'drawing', points: live,
        widths: liveWidthsRef.current,
        strokeColor: st.strokeColor, strokeWidth: st.strokeWidth,
        dash: st.dashStyle, zIndex: 0, createdAt: 0,
      });
      ctx.restore();
    }
  }, [rebuildStatic, styleRef, viewRef]);

  const schedule = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(paint);
  }, [paint]);

  // Anything that changes committed content or the viewport invalidates
  // the cache; the live stroke does not.
  useEffect(() => {
    staticDirty.current = true;
    schedule();
  }, [elements, selectedIds, pan.x, pan.y, zoom, schedule]);

  // Repaint when the canvas is resized by its container.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => { staticDirty.current = true; schedule(); });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [schedule]);

  useEffect(() => () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
  }, []);

  // ── Pen input ───────────────────────────────────────────────
  // Reads only refs, so it never needs to be re-created — and staying
  // stable keeps it out of the pointer handlers' dependency lists.
  const nibFor = useCallback((pressure: number): number => {
    // Pointer events report 0 for devices with no pressure sensor and
    // 0.5 for a plain mouse button; both should draw at the nominal
    // width rather than vanishing.
    const p = pressure > 0 ? pressure : 0.5;
    return styleRef.current.strokeWidth * (0.55 + p * 0.9);
  }, [styleRef]);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (!isPen || e.button !== 0) return;
    e.preventDefault();
    const pt = screenToCanvas(e.clientX, e.clientY);
    liveRef.current = [pt];
    liveWidthsRef.current = [nibFor(e.pressure)];
    drawingRef.current = true;
    useCanvasStore.getState().startStroke(pt);
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    schedule();
  }, [isPen, screenToCanvas, schedule, nibFor]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!drawingRef.current) return;

    // Browsers batch pointer moves between frames. Reading only the
    // latest event drops the samples in between, which shows up as
    // corners cut off a fast stroke.
    const native = e.nativeEvent;
    const batch = typeof native.getCoalescedEvents === 'function'
      ? native.getCoalescedEvents()
      : [native];

    for (const ev of batch.length > 0 ? batch : [native]) {
      const pt = screenToCanvas(ev.clientX, ev.clientY);
      const last = liveRef.current[liveRef.current.length - 1];
      // Drop samples the simplifier would discard anyway.
      if (last && Math.abs(last.x - pt.x) < 0.25 && Math.abs(last.y - pt.y) < 0.25) continue;
      liveRef.current.push(pt);
      liveWidthsRef.current.push(nibFor(ev.pressure));
    }
    schedule();
  }, [screenToCanvas, schedule, nibFor]);

  const finishStroke = useCallback((commit: boolean) => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    const pts = liveRef.current;
    const widths = liveWidthsRef.current;
    liveRef.current = [];
    liveWidthsRef.current = [];

    if (commit && pts.length >= 2) {
      useCanvasStore.getState().commitStroke(pts, widths);
    } else {
      useCanvasStore.getState().cancelStroke();
    }
    staticDirty.current = true;
    schedule();
  }, [schedule]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    finishStroke(true);
  }, [finishStroke]);

  // A stroke interrupted by the system (window blur, touch cancelled,
  // capture stolen) previously stayed "in progress" forever, and every
  // later pointer move kept appending to it.
  const handlePointerCancel = useCallback(() => finishStroke(false), [finishStroke]);

  useEffect(() => {
    if (!isPen) { if (drawingRef.current) finishStroke(true); return; }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && drawingRef.current) finishStroke(false);
    };
    const onBlur = () => { if (drawingRef.current) finishStroke(true); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onBlur);
    };
  }, [isPen, finishStroke]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'absolute', inset: 0,
        width: '100%', height: '100%',
        pointerEvents: isPen ? 'auto' : 'none',
        cursor: isPen ? 'crosshair' : 'default',
        touchAction: isPen ? 'none' : 'auto',
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onLostPointerCapture={handlePointerCancel}
    />
  );
};
