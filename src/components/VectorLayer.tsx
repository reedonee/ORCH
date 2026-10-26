// ── ORCH Vector Layer ──────────────────────────────────────────
// SVG layer for geometric shapes: rectangles, ellipses, diamonds,
// frames, lines and arrows.
//
// This component owns rendering and shape *creation*. Selecting,
// moving, resizing and rotating live in CanvasSelectionLayer, so one
// overlay serves shapes and freehand strokes alike.
//
// The in-progress shape is local state. It used to be inserted into the
// store on mousedown and patched on every mousemove, which pushed a few
// hundred undo entries per drag; and because the gesture ended on the
// SVG's own mouseup, releasing outside the window left the placeholder
// behind and the drag lock stuck, which blocked panning until reload.

import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  useCanvasStore, DIRECTIONAL_SHAPES,
  makeElementId, type CanvasElement, type CanvasPoint, type ShapeType,
} from '../stores/useCanvasStore';
import {
  arrowHeadPoints, dragRect, lineEndpoints, normalizeRect,
  rectCenter, sortByPaintOrder, type Rect,
} from '../lib/canvas-geometry';
import { withAlpha } from '../lib/color';
import { useLatestRef } from '../lib/use-latest-ref';

interface VectorLayerProps {
  pan: { x: number; y: number };
  zoom: number;
}

/** Below this, a drag reads as a click and creates nothing. */
const MIN_DRAG = 4;

function dashArrayFor(dash: string | undefined, w: number): string | undefined {
  if (dash === 'dashed') return `${w * 3} ${w * 2}`;
  if (dash === 'dotted') return `0.01 ${w * 2.4}`;
  return undefined;
}

/**
 * Render one shape as SVG.
 *
 * Exported because the selection overlay draws the same geometry for
 * its hover preview, and two renderers would drift apart.
 */
export function ShapeGraphic({ el }: { el: CanvasElement }): React.ReactElement | null {
  const raw = { x: el.x ?? 0, y: el.y ?? 0, w: el.width ?? 0, h: el.height ?? 0 };
  const r: Rect = normalizeRect(raw.x, raw.y, raw.w, raw.h);
  const sw = el.strokeWidth || 2;
  const fill = el.fillColor && el.fillColor !== 'transparent' ? el.fillColor : 'none';
  const dash = dashArrayFor(el.dash, sw);

  const common = {
    stroke: el.strokeColor,
    strokeWidth: sw,
    strokeDasharray: dash,
    fill,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };

  const body = (() => {
    switch (el.shapeType) {
      case 'frame':
        return (
          <rect
            x={r.x} y={r.y} width={r.width} height={r.height} rx={6} ry={6}
            {...common}
            strokeDasharray={dash ?? '6 4'}
            fill={fill === 'none' ? 'none' : fill}
          />
        );
      case 'ellipse':
        return (
          <ellipse
            cx={r.x + r.width / 2} cy={r.y + r.height / 2}
            rx={r.width / 2} ry={r.height / 2}
            {...common}
          />
        );
      case 'diamond': {
        const cx = r.x + r.width / 2;
        const cy = r.y + r.height / 2;
        const pts = `${cx},${r.y} ${r.x + r.width},${cy} ${cx},${r.y + r.height} ${r.x},${cy}`;
        return <polygon points={pts} {...common} />;
      }
      case 'line': {
        const { from, to } = lineEndpoints(el);
        return <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} {...common} fill="none" />;
      }
      case 'arrow': {
        // The arrowhead scales with the nib so a hairline arrow does not
        // get a dinner-plate head.
        const { from, to } = lineEndpoints(el);
        const head = Math.max(8, sw * 4);
        const tri = arrowHeadPoints(from, to, head);
        const len = Math.hypot(to.x - from.x, to.y - from.y);
        // Stop the shaft short so it does not poke through the head.
        const back = len > head ? (len - head * 0.85) / len : 0;
        return (
          <g>
            <line
              x1={from.x} y1={from.y}
              x2={from.x + (to.x - from.x) * back}
              y2={from.y + (to.y - from.y) * back}
              {...common} fill="none"
            />
            <polygon
              points={tri.map((p) => `${p.x},${p.y}`).join(' ')}
              fill={el.strokeColor} stroke="none"
            />
          </g>
        );
      }
      default:
        return <rect x={r.x} y={r.y} width={r.width} height={r.height} rx={2} {...common} />;
    }
  })();

  const rot = el.rotation ?? 0;
  const opacity = el.opacity ?? 1;
  if (!rot && opacity === 1) return body;

  const c = rectCenter(r);
  return (
    <g
      transform={rot ? `rotate(${rot} ${c.x} ${c.y})` : undefined}
      opacity={opacity === 1 ? undefined : opacity}
    >
      {body}
    </g>
  );
}

export const VectorLayer: React.FC<VectorLayerProps> = ({ pan, zoom }) => {
  const elements = useCanvasStore((s) => s.elements);
  const activeTool = useCanvasStore((s) => s.activeTool);
  const activeShapeType = useCanvasStore((s) => s.activeShapeType);
  const strokeColor = useCanvasStore((s) => s.strokeColor);
  const strokeWidth = useCanvasStore((s) => s.strokeWidth);
  const fillEnabled = useCanvasStore((s) => s.fillEnabled);
  const fillOpacity = useCanvasStore((s) => s.fillOpacity);
  const dashStyle = useCanvasStore((s) => s.dashStyle);
  const snapToGrid = useCanvasStore((s) => s.snapToGrid);
  const gridSize = useCanvasStore((s) => s.gridSize);

  const isShape = activeTool === 'shape';

  const svgRef = useRef<SVGSVGElement>(null);
  // `creating` drives the listener effect; `preview` is render data and
  // `previewRef` is what commit reads. Keying the effect on the preview
  // object would rebind window listeners on every mousemove.
  const [creating, setCreating] = useState(false);
  const [preview, setPreview] = useState<CanvasElement | null>(null);
  const previewRef = useRef<CanvasElement | null>(null);
  const dragRef = useRef<{ start: CanvasPoint; moved: boolean } | null>(null);

  const showPreview = useCallback((el: CanvasElement | null) => {
    previewRef.current = el;
    setPreview(el);
  }, []);

  const viewRef = useLatestRef({ pan, zoom });

  // The SVG carries the pan/zoom transform, so its own client rect is
  // already translated — subtracting pan again would double-count it.
  const toCanvas = useCallback((clientX: number, clientY: number): CanvasPoint => {
    const rect = svgRef.current?.getBoundingClientRect();
    const { zoom: z } = viewRef.current;
    if (!rect) return { x: clientX, y: clientY };
    return { x: (clientX - rect.left) / z, y: (clientY - rect.top) / z };
  }, [viewRef]);

  const styleRef = useLatestRef({
    strokeColor, strokeWidth, fillEnabled, fillOpacity, dashStyle,
    activeShapeType, snapToGrid, gridSize,
  });

  const makeShape = useCallback((r: Rect, type: ShapeType): CanvasElement => {
    const st = styleRef.current;
    return {
      id: 'shape_preview',
      type: 'shape',
      shapeType: type,
      x: r.x, y: r.y, width: r.width, height: r.height,
      strokeColor: st.strokeColor,
      strokeWidth: st.strokeWidth,
      // withAlpha handles hex, rgb() and rgba() alike. Concatenating a
      // hex alpha suffix, as this did before, produced garbage for any
      // theme colour that was not a bare #rrggbb.
      fillColor: st.fillEnabled ? withAlpha(st.strokeColor, st.fillOpacity / 100) : 'transparent',
      dash: st.dashStyle,
      zIndex: 0,
      createdAt: Date.now(),
    };
  }, [styleRef]);

  // ── Creation gesture ────────────────────────────────────────
  // Tracked on the window so the shape still finishes if the pointer
  // leaves the canvas, the app loses focus, or the release lands on a
  // panel that stops propagation.
  useEffect(() => {
    if (!creating) return;

    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const st = styleRef.current;
      const cur = toCanvas(e.clientX, e.clientY);
      const r = dragRect(d.start, cur, {
        square: e.shiftKey,
        fromCenter: e.altKey,
        grid: st.snapToGrid ? st.gridSize : 0,
      });
      if (Math.abs(r.width) > MIN_DRAG || Math.abs(r.height) > MIN_DRAG) d.moved = true;
      showPreview(makeShape(r, st.activeShapeType));
    };

    // Commit runs its side effects directly rather than inside a state
    // updater — React may invoke an updater twice, which would add the
    // shape twice.
    const commit = (cancelled: boolean) => {
      const d = dragRef.current;
      const current = previewRef.current;
      dragRef.current = null;
      showPreview(null);
      setCreating(false);

      const store = useCanvasStore.getState();
      store.setDragTarget(null);
      if (cancelled || !d?.moved || !current) return;

      const type = current.shapeType ?? 'rect';
      // Lines and arrows encode direction in the sign of their extents;
      // normalising one would flip it end for end.
      const box = DIRECTIONAL_SHAPES.includes(type)
        ? { x: current.x ?? 0, y: current.y ?? 0, width: current.width ?? 0, height: current.height ?? 0 }
        : normalizeRect(current.x ?? 0, current.y ?? 0, current.width ?? 0, current.height ?? 0);

      const id = makeElementId('shape');
      store.addElement({ ...current, ...box, id, zIndex: store.nextZIndex() });
      store.setSelectedElementIds([id]);
      // Back to select: the shape you just drew is almost always the
      // thing you want to move or restyle next.
      store.setActiveTool('select');
    };

    const onUp = () => commit(false);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') commit(true); };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('keydown', onKey);
    };
  }, [creating, toCanvas, makeShape, showPreview, styleRef]);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (!isShape || e.button !== 0) return;
    const store = useCanvasStore.getState();
    if (store.dragTarget) return;
    e.preventDefault();
    e.stopPropagation();

    const st = styleRef.current;
    const start = toCanvas(e.clientX, e.clientY);
    dragRef.current = { start, moved: false };
    store.setDragTarget('shape:preview');
    showPreview(makeShape(
      dragRect(start, start, { grid: st.snapToGrid ? st.gridSize : 0 }),
      st.activeShapeType,
    ));
    setCreating(true);
  }, [isShape, toCanvas, makeShape, showPreview, styleRef]);

  const shapes = sortByPaintOrder(elements.filter((el) => el.type === 'shape'));

  return (
    <svg
      ref={svgRef}
      style={{
        position: 'absolute', inset: 0,
        width: '100%', height: '100%',
        pointerEvents: isShape ? 'auto' : 'none',
        cursor: isShape ? 'crosshair' : 'default',
        overflow: 'visible',
        transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
        transformOrigin: '0 0',
      }}
      onMouseDown={onMouseDown}
    >
      {shapes.map((el) => <ShapeGraphic key={el.id} el={el} />)}
      {preview && (
        <g opacity={0.75} pointerEvents="none">
          <ShapeGraphic el={preview} />
        </g>
      )}
    </svg>
  );
};
