// ── ORCH Eraser Overlay ───────────────────────────────────────
// Transparent overlay that appears when eraser tool is active.
// Catches clicks, finds the nearest canvas element, and deletes it.
// Hit-testing uses proper measurement for text elements.

import React, { useCallback } from 'react';
import { useCanvasStore, type CanvasElement } from '../stores/useCanvasStore';

interface EraserOverlayProps {
  pan: { x: number; y: number };
  zoom: number;
}

// ── Text measurement cache ─────────────────────────────────────
// Uses an offscreen canvas context for accurate text width.
const measCtxRef: { ctx: CanvasRenderingContext2D | null } = { ctx: null };

function getMeasureCtx(): CanvasRenderingContext2D | null {
  if (measCtxRef.ctx) return measCtxRef.ctx;
  try {
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    if (ctx) measCtxRef.ctx = ctx;
    return ctx;
  } catch { return null; }
}

function measureTextWidth(text: string, fontSize: number): number {
  const ctx = getMeasureCtx();
  if (!ctx) return text.length * 8.5; // fallback
  ctx.font = `${fontSize}px 'JetBrains Mono', 'Cascadia Code', 'Fira Code', monospace`;
  const lines = text.split('\n');
  let maxW = 0;
  for (const line of lines) {
    const w = ctx.measureText(line).width;
    if (w > maxW) maxW = w;
  }
  return maxW + 4; // +4 for padding
}

function measureTextHeight(text: string, fontSize: number): number {
  const lines = text.split('\n').length;
  return fontSize * lines * 1.4;
}

// ── Hit testing ────────────────────────────────────────────────
function isPointInElement(pt: { x: number; y: number }, el: CanvasElement): boolean {
  const ex = el.x ?? 0;
  const ey = el.y ?? 0;

  switch (el.type) {
    case 'shape': {
      let w = el.width ?? 80;
      let h = el.height ?? 80;
      let x = ex, y = ey;
      if (w < 0) { x += w; w = Math.abs(w); }
      if (h < 0) { y += h; h = Math.abs(h); }
      return pt.x >= x && pt.x <= x + w && pt.y >= y && pt.y <= y + h;
    }
    case 'text': {
      const textContent = el.text || '';
      const textW = measureTextWidth(textContent, el.fontSize || 14);
      const textH = measureTextHeight(textContent, el.fontSize || 14);
      return pt.x >= ex && pt.x <= ex + textW && pt.y >= ey && pt.y <= ey + textH;
    }
    case 'image': {
      const imgW = el.width || 200;
      const imgH = el.height || 150;
      return pt.x >= ex && pt.x <= ex + imgW && pt.y >= ey && pt.y <= ey + imgH;
    }
    case 'drawing': {
      if (!el.points || el.points.length === 0) return false;
      const threshold = 10;
      for (const p of el.points) {
        const dx = pt.x - p.x;
        const dy = pt.y - p.y;
        if (Math.sqrt(dx * dx + dy * dy) < threshold) return true;
      }
      return false;
    }
    default:
      return false;
  }
}

// ── Component ──────────────────────────────────────────────────
export const EraserOverlay: React.FC<EraserOverlayProps> = ({ pan, zoom }) => {
  const activeTool = useCanvasStore((s) => s.activeTool);
  const elements = useCanvasStore((s) => s.elements);
  const removeElement = useCanvasStore((s) => s.removeElement);

  const handleClick = useCallback((e: React.MouseEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const cx = (e.clientX - rect.left - pan.x) / zoom;
    const cy = (e.clientY - rect.top - pan.y) / zoom;

    for (let i = elements.length - 1; i >= 0; i--) {
      const el = elements[i];
      if (isPointInElement({ x: cx, y: cy }, el)) {
        removeElement(el.id);
        return;
      }
    }
  }, [elements, removeElement, pan, zoom]);

  if (activeTool !== 'eraser') return null;

  return (
    <div
      style={{
        position: 'absolute', inset: 0,
        cursor: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Ccircle cx='12' cy='12' r='8' fill='none' stroke='%23ff781f' stroke-width='2' opacity='0.8'/%3E%3Ccircle cx='12' cy='12' r='4' fill='%23ff781f' opacity='0.3'/%3E%3Cline x1='6' y1='6' x2='18' y2='18' stroke='%23ff781f' stroke-width='2' opacity='0.8'/%3E%3Cline x1='18' y1='6' x2='6' y2='18' stroke='%23ff781f' stroke-width='2' opacity='0.8'/%3E%3C/svg%3E") 12 12, crosshair`,
        zIndex: 65,
        pointerEvents: activeTool === 'eraser' ? 'auto' : 'none',
      }}
      onClick={handleClick}
    />
  );
};
