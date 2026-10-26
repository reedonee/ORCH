// ── ORCH Canvas Elements ───────────────────────────────────────
// Text notes and media nodes — the two element types that render as
// real DOM rather than into the canvas or SVG layers.
//
// Isolated from InfiniteCanvas so a drawing stroke does not re-render
// the whole canvas.

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useCanvasStore, type CanvasElement } from '../stores/useCanvasStore';
import { CanvasMediaNode } from './CanvasMediaNode';
import { sortByPaintOrder } from '../lib/canvas-geometry';
import { useLatestRef } from '../lib/use-latest-ref';

const ACCENT = '#F4A261';
const DEFAULT_TEXT_WIDTH = 260;
const MIN_TEXT_WIDTH = 60;

/**
 * The open editor for one note.
 *
 * A separate component so its draft is seeded by useState at mount
 * rather than by an effect that fires after the textarea has already
 * painted empty.
 */
const TextNoteEditor: React.FC<{ el: CanvasElement }> = ({ el }) => {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState(el.text || '');

  useEffect(() => {
    const t = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(t);
  }, []);

  const close = useCallback((keep: boolean) => {
    const store = useCanvasStore.getState();
    store.setEditingElement(null);
    const text = draft.trim();
    if (!keep) {
      // Cancelling a note that never had text leaves nothing worth
      // keeping — and an empty note is invisible, so it would be
      // clutter no one could select or erase.
      if (!(el.text || '').trim()) store.removeElement(el.id);
      return;
    }
    if (!text) { store.removeElement(el.id); return; }
    if (draft !== (el.text || '')) store.updateElement(el.id, { text: draft });
  }, [draft, el.id, el.text]);

  return (
    <textarea
      ref={inputRef}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => close(true)}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') { e.preventDefault(); close(false); }
        else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); close(true); }
      }}
      placeholder="Note…"
      style={{
        position: 'absolute',
        left: el.x ?? 0, top: el.y ?? 0,
        width: el.width || DEFAULT_TEXT_WIDTH,
        minHeight: (el.fontSize || 14) * 1.8,
        fontSize: el.fontSize || 14,
        lineHeight: 1.4,
        color: el.strokeColor,
        background: 'rgba(14,26,20,0.94)',
        border: `1px solid ${ACCENT}`,
        borderRadius: 4,
        padding: '4px 6px',
        outline: 'none',
        resize: 'none',
        overflow: 'hidden',
        fontFamily: "'JetBrains Mono', monospace",
        pointerEvents: 'auto',
        zIndex: 9999,
      }}
    />
  );
};

interface TextNoteProps {
  el: CanvasElement;
  zoom: number;
  isSelect: boolean;
  isSelected: boolean;
  isEditing: boolean;
}

/**
 * One text note.
 *
 * Split out per element so each owns its measurement observer — the
 * previous single component re-ran every note's effects whenever any
 * note changed.
 */
const TextNote: React.FC<TextNoteProps> = ({ el, zoom, isSelect, isSelected, isEditing }) => {
  const boxRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ mx: number; my: number; ox: number; oy: number } | null>(null);
  const resizeRef = useRef<{ mx: number; ow: number } | null>(null);

  const [hovered, setHovered] = useState(false);
  const [gesture, setGesture] = useState<null | 'move' | 'resize'>(null);

  const zoomRef = useLatestRef(zoom);

  const width = el.width || DEFAULT_TEXT_WIDTH;

  // ── Measure the painted box ─────────────────────────────────
  // Hit-testing, the lasso and the eraser all need to know how big a
  // note actually is. Estimating from character counts never matched
  // the rendered text, so the DOM reports it and the value is cached on
  // the element — quietly, since it is not a user edit.
  useEffect(() => {
    const node = boxRef.current;
    if (!node || isEditing || typeof ResizeObserver === 'undefined') return;
    // Height only. Width is authoritative — writing offsetWidth back
    // would feed the padding into it and grow the note by 6px on every
    // observation, forever.
    const ro = new ResizeObserver(() => {
      const h = node.offsetHeight;
      if (!h) return;
      const cur = useCanvasStore.getState().elements.find((x) => x.id === el.id);
      if (!cur || Math.abs((cur.height ?? 0) - h) <= 1) return;
      useCanvasStore.getState().updateElementQuiet(el.id, { height: h });
    });
    ro.observe(node);
    return () => ro.disconnect();
  }, [el.id, isEditing]);

  // ── Move / resize ───────────────────────────────────────────
  useEffect(() => {
    if (!gesture) return;
    const store = useCanvasStore.getState();

    const onMove = (e: MouseEvent) => {
      const z = zoomRef.current || 1;
      if (gesture === 'move' && dragRef.current) {
        const d = dragRef.current;
        // Pointer deltas are screen pixels. Applying them straight to
        // canvas coordinates, as this used to, made a note run away
        // from the cursor at any zoom other than 1.
        let dx = (e.clientX - d.mx) / z;
        let dy = (e.clientY - d.my) / z;
        if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
        store.updateElement(el.id, { x: d.ox + dx, y: d.oy + dy });
      } else if (gesture === 'resize' && resizeRef.current) {
        const r = resizeRef.current;
        const w = Math.max(MIN_TEXT_WIDTH, r.ow + (e.clientX - r.mx) / z);
        store.updateElement(el.id, { width: w });
      }
    };

    const onUp = () => {
      dragRef.current = null;
      resizeRef.current = null;
      setGesture(null);
      store.endInteraction();
      store.setDragTarget(null);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [gesture, el.id, zoomRef]);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (!isSelect || isEditing || e.button !== 0) return;
    const store = useCanvasStore.getState();
    if (store.dragTarget) return;
    e.stopPropagation();

    store.toggleSelection(el.id, e.shiftKey || e.metaKey || e.ctrlKey);
    // The whole drag is one undo step, not one per mousemove.
    store.beginInteraction();
    store.setDragTarget(`text:${el.id}`);
    dragRef.current = { mx: e.clientX, my: e.clientY, ox: el.x ?? 0, oy: el.y ?? 0 };
    setGesture('move');
  }, [isSelect, isEditing, el.id, el.x, el.y]);

  if (isEditing) {
    return <TextNoteEditor el={el} />;
  }

  const showHandle = isSelect && (hovered || isSelected);

  return (
    <div
      ref={boxRef}
      data-canvas-text={el.id}
      onMouseDown={onMouseDown}
      onDoubleClick={(e) => {
        if (!isSelect) return;
        e.stopPropagation();
        useCanvasStore.getState().setEditingElement(el.id);
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: 'absolute',
        left: el.x ?? 0, top: el.y ?? 0,
        width,
        fontSize: el.fontSize || 14,
        lineHeight: 1.4,
        color: el.strokeColor,
        opacity: el.opacity ?? 1,
        transform: el.rotation ? `rotate(${el.rotation}deg)` : undefined,
        transformOrigin: 'center center',
        pointerEvents: isSelect ? 'auto' : 'none',
        cursor: gesture === 'move' ? 'grabbing' : isSelect ? 'move' : 'default',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        padding: '2px 3px',
        borderRadius: 3,
        textShadow: '0 1px 4px rgba(0,0,0,0.8)',
        userSelect: 'none',
        outline: isSelected
          ? `1.5px solid ${ACCENT}`
          : hovered && isSelect
            ? `1px solid ${ACCENT}55`
            : 'none',
        outlineOffset: 1,
        transition: 'outline 120ms ease',
      }}
    >
      {el.text}

      {/* Width handle on the right edge. Height follows the text. */}
      {showHandle && (
        <div
          onMouseDown={(e) => {
            e.stopPropagation();
            e.preventDefault();
            const store = useCanvasStore.getState();
            store.beginInteraction();
            store.setDragTarget(`text:${el.id}`);
            resizeRef.current = { mx: e.clientX, ow: width };
            setGesture('resize');
          }}
          style={{
            position: 'absolute',
            right: -4, top: 0, bottom: 0, width: 8,
            cursor: 'ew-resize',
          }}
        />
      )}
    </div>
  );
};

export const CanvasTextNotes: React.FC<{ zoom?: number }> = ({ zoom = 1 }) => {
  const elements = useCanvasStore((s) => s.elements);
  const activeTool = useCanvasStore((s) => s.activeTool);
  const selectedElementIds = useCanvasStore((s) => s.selectedElementIds);
  const editingElementId = useCanvasStore((s) => s.editingElementId);

  const isSelect = activeTool === 'select';
  const textElements = sortByPaintOrder(elements.filter((el) => el.type === 'text'));

  return (
    <>
      {textElements.map((el) => (
        <TextNote
          key={el.id}
          el={el}
          zoom={zoom}
          isSelect={isSelect}
          isSelected={selectedElementIds.includes(el.id)}
          isEditing={editingElementId === el.id}
        />
      ))}
    </>
  );
};

/**
 * Media and file nodes — produced by agents, dropped, or pasted.
 *
 * Rendering lives in CanvasMediaNode so each node can own its own drag,
 * resize and drop-onto-agent behaviour. This component only selects and
 * positions them.
 */
export const CanvasImages: React.FC<{ zoom?: number }> = ({ zoom = 1 }) => {
  const elements = useCanvasStore((s) => s.elements);
  const mediaElements = sortByPaintOrder(elements.filter((el) => el.type === 'image'));

  if (mediaElements.length === 0) return null;

  return (
    <>
      {mediaElements.map((el) => (
        <CanvasMediaNode key={el.id} el={el} zoom={zoom} />
      ))}
    </>
  );
};
