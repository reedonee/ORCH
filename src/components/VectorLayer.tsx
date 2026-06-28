// ── ORCH Vector Layer ──────────────────────────────────────────
// SVG layer for vector geometric shapes: frames, arrows, borders.
// Supports:
//   - Click-and-drag to create new shapes (shape tool)
//   - Click-and-drag to move existing shapes (select tool)
//   - Hover highlighting in select mode

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useCanvasStore, type CanvasElement } from '../stores/useCanvasStore';

interface VectorLayerProps {
  pan: { x: number; y: number };
  zoom: number;
}

export const VectorLayer: React.FC<VectorLayerProps> = ({ pan, zoom }) => {
  const {
    elements, activeTool, activeShapeType, strokeColor, strokeWidth,
    fillEnabled, fillOpacity,
    addElement, updateElement,
    dragTarget, setDragTarget,
  } = useCanvasStore();

  const isShape = activeTool === 'shape';
  const isSelect = activeTool === 'select';
  const shapeFill = fillEnabled
    ? strokeColor + Math.round(fillOpacity * 2.55).toString(16).padStart(2, '0')
    : 'transparent';

  // Shape creation drag state
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [dragCurrent, setDragCurrent] = useState<{ x: number; y: number } | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);

  // Element move drag state
  const [moveElId, setMoveElId] = useState<string | null>(null);
  const moveStartRef = useRef({ elX: 0, elY: 0, mouseX: 0, mouseY: 0 });

  // Hover highlight
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const screenToCanvas = useCallback((clientX: number, clientY: number, rect: DOMRect) => {
    return {
      x: (clientX - rect.left) / zoom,
      y: (clientY - rect.top) / zoom,
    };
  }, [zoom]);

  // ── Window-level mousemove/mouseup for element dragging ──
  useEffect(() => {
    if (!moveElId) return;
    const onMove = (e: MouseEvent) => {
      const dx = e.clientX - moveStartRef.current.mouseX;
      const dy = e.clientY - moveStartRef.current.mouseY;
      updateElement(moveElId, {
        x: moveStartRef.current.elX + dx / zoom,
        y: moveStartRef.current.elY + dy / zoom,
      });
    };
    const onUp = () => {
      setMoveElId(null);
      setDragTarget(null);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [moveElId, updateElement, zoom, setDragTarget]);

  const shapes = elements.filter((el) => el.type === 'shape');
  const isDragging = dragTarget?.startsWith('shape:');
  const canDragShape = isSelect && !isDragging;

  const renderShape = (el: CanvasElement, isPreview: boolean = false) => {
    let x = el.x ?? 0;
    let y = el.y ?? 0;
    let w = el.width ?? 80;
    let h = el.height ?? 80;

    if (w < 0) { x += w; w = Math.abs(w); }
    if (h < 0) { y += h; h = Math.abs(h); }

    const isHovered = hoveredId === el.id && !isPreview;

    const common = {
      stroke: el.strokeColor,
      strokeWidth: isHovered ? (el.strokeWidth || 2) + 1 : el.strokeWidth,
      fill: isHovered ? (el.fillColor || 'transparent').replace(')', ', 0.12)').replace('rgba', 'rgba') : (el.fillColor || 'transparent'),
      style: {
        pointerEvents: (canDragShape && !isPreview ? 'auto' : 'none') as any,
        cursor: (canDragShape && !isPreview ? 'move' : 'default') as any,
        opacity: isPreview ? 0.5 : 1,
        transition: 'stroke-width 120ms ease',
      } as React.CSSProperties,
    };

    // For hover fill glow, use a semi-transparent version of stroke color
    if (isHovered && !isPreview) {
      common.fill = el.strokeColor + '18'; // 10% opacity tint
    }

    const shape = (() => {
      switch (el.shapeType) {
        case 'frame': return <rect x={x} y={y} width={w} height={h} rx={6} ry={6} strokeDasharray="6 3" />;
        case 'rect':  return <rect x={x} y={y} width={w} height={h} rx={2} />;
        case 'ellipse': return <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} />;
        default: return null;
      }
    })();
    if (!shape) return null;

    return React.cloneElement(shape, {
      key: el.id,
      ...common,
      onMouseEnter: () => { if (canDragShape) setHoveredId(el.id); },
      onMouseLeave: () => { if (hoveredId === el.id) setHoveredId(null); },
      onMouseDown: canDragShape ? (e: React.MouseEvent) => {
        e.stopPropagation();
        // Also select the shape in select mode
        useCanvasStore.getState().setSelectedElementIds([el.id]);
        // Claim drag target
        const targetId = `shape:${el.id}`;
        setDragTarget(targetId);
        setMoveElId(el.id);
        moveStartRef.current = { elX: el.x ?? 0, elY: el.y ?? 0, mouseX: e.clientX, mouseY: e.clientY };
      } : undefined,
    });
  };

  return (
    <svg
      style={{
        position: 'absolute', inset: 0,
        width: '100%', height: '100%',
        pointerEvents: isShape ? 'auto' : 'none',
        cursor: isShape ? 'crosshair' : 'default',
        overflow: 'visible',
        transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
        transformOrigin: '0 0',
      }}
      onMouseDown={(e) => {
        if (!isShape) return;
        // Don't start shape creation if already dragging something
        if (dragTarget) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const pt = screenToCanvas(e.clientX, e.clientY, rect);
        setDragStart(pt);
        setDragCurrent(pt);
        const id = `shape_preview_${Date.now()}`;
        setPreviewId(id);
        setDragTarget(`shape:preview`);
        addElement({
          id,
          type: 'shape',
          shapeType: activeShapeType,
          x: pt.x, y: pt.y, width: 0, height: 0,
          strokeColor,
          strokeWidth,
          fillColor: shapeFill,
          zIndex: elements.length,
          createdAt: Date.now(),
        });
      }}
      onMouseMove={(e) => {
        if (!dragStart || !previewId) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const pt = screenToCanvas(e.clientX, e.clientY, rect);
        setDragCurrent(pt);
        updateElement(previewId, {
          x: dragStart.x, y: dragStart.y,
          width: pt.x - dragStart.x, height: pt.y - dragStart.y,
        });
      }}
      onMouseUp={() => {
        if (!dragStart || !dragCurrent || !previewId) return;
        const dx = Math.abs(dragCurrent.x - dragStart.x);
        const dy = Math.abs(dragCurrent.y - dragStart.y);
        if (dx < 5 && dy < 5) {
          useCanvasStore.getState().removeElement(previewId);
        } else {
          // Auto-return to select after shape creation
          useCanvasStore.getState().setActiveTool('select');
        }
        setDragStart(null);
        setDragCurrent(null);
        setPreviewId(null);
        setDragTarget(null);
      }}
    >
      {shapes.map((el) => renderShape(el, el.id === previewId))}
    </svg>
  );
};
