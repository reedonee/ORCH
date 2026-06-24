// ── ORCH Drawing Layer ─────────────────────────────────────────
// HTML5 Canvas for freehand drawing strokes.
// Coordinate remapping: inverts pan/zoom transform so strokes
// stay in canvas-space coordinates.
// pointer-events controlled by active tool (auto for pen, none for select).

import React, { useRef, useEffect, useCallback } from 'react';
import { useCanvasStore, type CanvasPoint } from '../stores/useCanvasStore';

interface DrawingLayerProps {
  pan: { x: number; y: number };
  zoom: number;
}

export const DrawingLayer: React.FC<DrawingLayerProps> = ({ pan, zoom }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const {
    elements, activeTool, strokeColor, strokeWidth,
    isDrawing, currentStroke,
    startStroke, addStrokePoint, endStroke,
  } = useCanvasStore();

  const isPen = activeTool === 'pen';

  // Convert screen coords → canvas workspace coords
  const screenToCanvas = useCallback((clientX: number, clientY: number): CanvasPoint => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: clientX, y: clientY };
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    return {
      x: (sx - pan.x) / zoom,
      y: (sy - pan.y) / zoom,
    };
  }, [pan, zoom]);

  // ── Redraw all elements on every frame ─────────────────────
  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Match canvas resolution to device pixels
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Clear and apply pan/zoom
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(pan.x, pan.y);
    ctx.scale(zoom, zoom);

    // Draw finished strokes
    for (const el of elements) {
      if (el.type !== 'drawing' || !el.points || el.points.length < 2) continue;
      ctx.beginPath();
      ctx.strokeStyle = el.strokeColor;
      ctx.lineWidth = el.strokeWidth;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const pts = el.points;
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(pts[i].x, pts[i].y);
      }
      ctx.stroke();
    }

    // Draw current in-progress stroke
    if (isDrawing && currentStroke.length > 1) {
      ctx.beginPath();
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = strokeWidth;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.moveTo(currentStroke[0].x, currentStroke[0].y);
      for (let i = 1; i < currentStroke.length; i++) {
        ctx.lineTo(currentStroke[i].x, currentStroke[i].y);
      }
      ctx.stroke();
    }

    ctx.restore();
  }, [elements, isDrawing, currentStroke, strokeColor, strokeWidth, pan, zoom]);

  // Redraw on every relevant change
  useEffect(() => {
    redraw();
  }, [redraw]);

  // ── Mouse handlers ─────────────────────────────────────────
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (!isPen) return;
    const pt = screenToCanvas(e.clientX, e.clientY);
    startStroke(pt);
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  }, [isPen, screenToCanvas, startStroke]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!isPen || !isDrawing) return;
    const pt = screenToCanvas(e.clientX, e.clientY);
    addStrokePoint(pt);
  }, [isPen, isDrawing, screenToCanvas, addStrokePoint]);

  const handlePointerUp = useCallback(() => {
    if (!isPen) return;
    endStroke();
  }, [isPen, endStroke]);

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
    />
  );
};
