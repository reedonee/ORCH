// ── ORCH Canvas Selection Layer ────────────────────────────────
// Select, move, resize and rotate — for every kind of canvas element.
//
// Shapes and freehand strokes previously had no transform affordances
// at all: a shape could be dragged and nothing else, and a stroke was
// immutable the moment you lifted the pen. Text and media nodes each
// grew their own drag code, and each got the zoom conversion or the
// undo grouping wrong in its own way.
//
// This layer owns all of it:
//   - a hit surface underneath the interactive nodes, so a click that
//     no card or note consumed lands here and is hit-tested against
//     canvas geometry;
//   - one selection frame with eight resize handles and a rotate grip;
//   - one gesture model, where a whole drag is a single undo step.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCanvasStore, type CanvasElement, type CanvasPoint } from '../stores/useCanvasStore';
import {
  boundsTransformPatch, elementBounds, elementsBounds, handlePositions,
  HANDLE_CURSOR, normalizeRect, rectCenter, resizeRect, rotatePoint,
  topmostAt, type Handle, type Rect,
} from '../lib/canvas-geometry';
import { withAlpha } from '../lib/color';
import { useLatestRef } from '../lib/use-latest-ref';

interface Props {
  pan: { x: number; y: number };
  zoom: number;
  /** Called when the click did not land on any canvas element. */
  onBackgroundMouseDown: (e: React.MouseEvent) => void;
  // The hit surface covers the canvas in select mode, so touch panning
  // has to be forwarded through it or it never reaches the background.
  onTouchStart?: (e: React.TouchEvent) => void;
  onTouchMove?: (e: React.TouchEvent) => void;
}

const ACCENT = '#F4A261';
/** Handle box and rotate-grip radius, in screen pixels at any zoom. */
const HANDLE_PX = 8;
const ROTATE_OFFSET_PX = 22;
/** Click slop for grabbing a thin outline, in screen pixels. */
const HIT_SLOP_PX = 7;

type Mode =
  | { kind: 'move'; from: CanvasPoint; ids: string[]; origin: Map<string, CanvasElement> }
  | { kind: 'resize'; handle: Handle; from: CanvasPoint; start: Rect; origin: Map<string, CanvasElement> }
  | { kind: 'rotate'; centre: CanvasPoint; startAngle: number; origin: Map<string, CanvasElement> };

/** Angle in degrees from `centre` to `p`, measured like CSS rotate(). */
function angleOf(centre: CanvasPoint, p: CanvasPoint): number {
  return (Math.atan2(p.y - centre.y, p.x - centre.x) * 180) / Math.PI;
}

export const CanvasSelectionLayer: React.FC<Props> = ({
  pan, zoom, onBackgroundMouseDown, onTouchStart, onTouchMove,
}) => {
  const elements = useCanvasStore((s) => s.elements);
  const activeTool = useCanvasStore((s) => s.activeTool);
  const selectedIds = useCanvasStore((s) => s.selectedElementIds);
  const snapToGrid = useCanvasStore((s) => s.snapToGrid);
  const gridSize = useCanvasStore((s) => s.gridSize);

  const isSelect = activeTool === 'select';
  const surfaceRef = useRef<HTMLDivElement>(null);
  const modeRef = useRef<Mode | null>(null);
  const [gesture, setGesture] = useState<Mode['kind'] | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);

  const viewRef = useLatestRef({ pan, zoom, snapToGrid, gridSize });

  const toCanvas = useCallback((clientX: number, clientY: number): CanvasPoint => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    const { pan: p, zoom: z } = viewRef.current;
    if (!rect) return { x: clientX, y: clientY };
    return { x: (clientX - rect.left - p.x) / z, y: (clientY - rect.top - p.y) / z };
  }, [viewRef]);

  const selected = useMemo(
    () => elements.filter((el) => selectedIds.includes(el.id)),
    [elements, selectedIds],
  );

  // Only geometry this layer is responsible for transforming. Text and
  // media nodes are real DOM elements that own their own drag; framing
  // them here too would fight those handlers.
  const transformable = useMemo(
    () => selected.filter((el) => el.type === 'shape' || el.type === 'drawing'),
    [selected],
  );

  const frame = useMemo(() => elementsBounds(transformable), [transformable]);
  const hovered = useMemo(
    () => (hoverId ? elements.find((el) => el.id === hoverId) ?? null : null),
    [hoverId, elements],
  );
  const hoverBounds = useMemo(() => (hovered ? elementBounds(hovered) : null), [hovered]);

  // ── Gesture tracking ────────────────────────────────────────
  useEffect(() => {
    if (!gesture) return;
    const store = useCanvasStore.getState();

    const onMove = (e: MouseEvent) => {
      const m = modeRef.current;
      if (!m) return;
      const cur = toCanvas(e.clientX, e.clientY);
      const { snapToGrid: snap, gridSize: grid } = viewRef.current;

      if (m.kind === 'move') {
        let dx = cur.x - m.from.x;
        let dy = cur.y - m.from.y;
        // Shift locks to the dominant axis — the standard escape hatch
        // when you want to move something strictly sideways.
        if (e.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0;
        }
        if (snap && grid > 0) {
          dx = Math.round(dx / grid) * grid;
          dy = Math.round(dy / grid) * grid;
        }
        store.updateElements(
          m.ids.map((id) => {
            const o = m.origin.get(id);
            if (!o) return { id, patch: {} };
            if (o.type === 'drawing' && o.points) {
              return { id, patch: { points: o.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) } };
            }
            return { id, patch: { x: (o.x ?? 0) + dx, y: (o.y ?? 0) + dy } };
          }),
        );
        return;
      }

      if (m.kind === 'resize') {
        const dx = cur.x - m.from.x;
        const dy = cur.y - m.from.y;
        const next = resizeRect(m.start, m.handle, dx, dy, {
          aspect: e.shiftKey,
          fromCenter: e.altKey,
          minWidth: 2,
          minHeight: 2,
        });
        store.updateElements(
          [...m.origin.values()].map((o) => ({
            id: o.id,
            patch: boundsTransformPatch(o, m.start, next),
          })),
        );
        return;
      }

      // Rotate. Shift snaps to 15-degree steps.
      let deg = angleOf(m.centre, cur) - m.startAngle;
      if (e.shiftKey) deg = Math.round(deg / 15) * 15;
      store.updateElements(
        [...m.origin.values()].map((o) => {
          if (o.type === 'drawing' && o.points) {
            // A stroke has no angle field, so rotation has to be baked
            // into its points.
            return {
              id: o.id,
              patch: { points: o.points.map((p) => rotatePoint(p, m.centre, deg)) },
            };
          }
          return { id: o.id, patch: { rotation: ((o.rotation ?? 0) + deg) % 360 } };
        }),
      );
    };

    const finish = (cancel: boolean) => {
      modeRef.current = null;
      setGesture(null);
      // Escape rolls the whole gesture back and drops its history entry,
      // so a cancelled drag leaves no trace to undo past.
      if (cancel) store.abortInteraction(); else store.endInteraction();
      store.setDragTarget(null);
    };

    const onUp = () => finish(false);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') finish(true); };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('keydown', onKey);
    };
  }, [gesture, toCanvas, viewRef]);

  const snapshot = useCallback((ids: string[]): Map<string, CanvasElement> => {
    const all = useCanvasStore.getState().elements;
    return new Map(all.filter((el) => ids.includes(el.id)).map((el) => [el.id, el]));
  }, []);

  // ── Click on the canvas ─────────────────────────────────────
  const onSurfaceMouseDown = useCallback((e: React.MouseEvent) => {
    if (!isSelect || e.button !== 0) { onBackgroundMouseDown(e); return; }

    const store = useCanvasStore.getState();
    const pt = toCanvas(e.clientX, e.clientY);
    // Tolerance is a screen distance: grabbing a 1px outline must be no
    // harder when zoomed out than when zoomed in.
    const tol = HIT_SLOP_PX / viewRef.current.zoom;

    const candidates = store.elements.filter(
      (el) => !el.locked && (el.type === 'shape' || el.type === 'drawing'),
    );
    const hit = topmostAt(pt, candidates, tol);

    if (!hit) {
      if (!e.shiftKey) store.clearSelection();
      onBackgroundMouseDown(e);
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    let ids: string[];
    if (additive) {
      store.toggleSelection(hit.id, true);
      ids = useCanvasStore.getState().selectedElementIds;
    } else if (store.selectedElementIds.includes(hit.id)) {
      // Clicking inside an existing multi-selection drags the whole set.
      ids = store.selectedElementIds;
    } else {
      store.setSelectedElementIds([hit.id]);
      ids = [hit.id];
    }

    const movable = ids.filter((id) => {
      const el = store.elements.find((x) => x.id === id);
      return el && !el.locked && (el.type === 'shape' || el.type === 'drawing');
    });
    if (movable.length === 0) return;

    store.beginInteraction();
    store.setDragTarget(`canvas:${hit.id}`);
    modeRef.current = { kind: 'move', from: pt, ids: movable, origin: snapshot(movable) };
    setGesture('move');
  }, [isSelect, toCanvas, onBackgroundMouseDown, snapshot, viewRef]);

  const onSurfaceMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isSelect || modeRef.current) return;
    const store = useCanvasStore.getState();
    const pt = toCanvas(e.clientX, e.clientY);
    const tol = HIT_SLOP_PX / viewRef.current.zoom;
    const hit = topmostAt(
      pt,
      store.elements.filter((el) => !el.locked && (el.type === 'shape' || el.type === 'drawing')),
      tol,
    );
    setHoverId(hit?.id ?? null);
  }, [isSelect, toCanvas, viewRef]);

  // ── Handle drags ────────────────────────────────────────────
  const startResize = useCallback((e: React.MouseEvent, handle: Handle) => {
    if (!frame) return;
    e.preventDefault();
    e.stopPropagation();
    const store = useCanvasStore.getState();
    const ids = transformable.map((el) => el.id);
    store.beginInteraction();
    store.setDragTarget('canvas:resize');
    modeRef.current = {
      kind: 'resize',
      handle,
      from: toCanvas(e.clientX, e.clientY),
      start: normalizeRect(frame.x, frame.y, frame.width, frame.height),
      origin: snapshot(ids),
    };
    setGesture('resize');
  }, [frame, transformable, toCanvas, snapshot]);

  const startRotate = useCallback((e: React.MouseEvent) => {
    if (!frame) return;
    e.preventDefault();
    e.stopPropagation();
    const store = useCanvasStore.getState();
    const ids = transformable.map((el) => el.id);
    const centre = rectCenter(frame);
    store.beginInteraction();
    store.setDragTarget('canvas:rotate');
    modeRef.current = {
      kind: 'rotate',
      centre,
      startAngle: angleOf(centre, toCanvas(e.clientX, e.clientY)),
      origin: snapshot(ids),
    };
    setGesture('rotate');
  }, [frame, transformable, toCanvas, snapshot]);

  // Handles must stay a constant size on screen, so their canvas-space
  // dimensions are divided by the zoom.
  const z = zoom || 1;
  const hs = HANDLE_PX / z;
  const stroke = 1.25 / z;

  const showFrame = isSelect && frame !== null;
  const showHover =
    isSelect && !gesture && hoverBounds !== null && hovered !== null &&
    !selectedIds.includes(hovered.id);

  return (
    <>
      {/* Hit surface. Sits below agent cards, notes and media so those
          take their own clicks first; everything they ignore lands here
          and is tested against canvas geometry. */}
      <div
        ref={surfaceRef}
        data-canvas-hit-surface="true"
        style={{
          position: 'absolute', inset: 0,
          zIndex: 6,
          pointerEvents: isSelect ? 'auto' : 'none',
          cursor: gesture === 'move' ? 'grabbing' : hoverId ? 'move' : 'default',
        }}
        onMouseDown={onSurfaceMouseDown}
        onMouseMove={onSurfaceMouseMove}
        onMouseLeave={() => setHoverId(null)}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
      />

      {/* Selection chrome, drawn in canvas space above the elements. */}
      <svg
        style={{
          position: 'absolute', inset: 0,
          width: '100%', height: '100%',
          overflow: 'visible',
          pointerEvents: 'none',
          zIndex: 62,
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          transformOrigin: '0 0',
        }}
      >
        {showHover && hoverBounds && (
          <rect
            x={hoverBounds.x} y={hoverBounds.y}
            width={hoverBounds.width} height={hoverBounds.height}
            fill="none"
            stroke={withAlpha(ACCENT, 0.5)}
            strokeWidth={stroke}
            strokeDasharray={`${4 / z} ${3 / z}`}
          />
        )}

        {showFrame && frame && (
          <g>
            <rect
              x={frame.x} y={frame.y} width={frame.width} height={frame.height}
              fill="none" stroke={ACCENT} strokeWidth={stroke}
              strokeDasharray={transformable.length > 1 ? `${5 / z} ${3 / z}` : undefined}
            />

            {/* Rotate grip, above the top edge. */}
            <line
              x1={frame.x + frame.width / 2} y1={frame.y}
              x2={frame.x + frame.width / 2} y2={frame.y - ROTATE_OFFSET_PX / z}
              stroke={ACCENT} strokeWidth={stroke}
            />
            <circle
              cx={frame.x + frame.width / 2}
              cy={frame.y - ROTATE_OFFSET_PX / z}
              r={hs * 0.62}
              fill="var(--bg, #0E1A14)" stroke={ACCENT} strokeWidth={stroke}
              style={{ pointerEvents: 'auto', cursor: 'grab' }}
              onMouseDown={startRotate}
            />

            {(Object.entries(handlePositions(frame)) as Array<[Handle, CanvasPoint]>).map(
              ([h, p]) => (
                <rect
                  key={h}
                  x={p.x - hs / 2} y={p.y - hs / 2}
                  width={hs} height={hs}
                  fill="var(--bg, #0E1A14)" stroke={ACCENT} strokeWidth={stroke}
                  style={{ pointerEvents: 'auto', cursor: HANDLE_CURSOR[h] }}
                  onMouseDown={(e) => startResize(e, h)}
                />
              ),
            )}
          </g>
        )}
      </svg>
    </>
  );
};
