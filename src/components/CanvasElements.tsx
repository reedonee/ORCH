// ── ORCH Canvas Elements ───────────────────────────────────────
// Isolated sub-components for text notes and dropped images.
// Prevents InfiniteCanvas re-renders on every drawing stroke.
// Supports inline editing + drag-to-move in select mode.
// Uses shared drag target from canvas store to prevent conflicts.

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useCanvasStore } from '../stores/useCanvasStore';

export const CanvasTextNotes: React.FC = () => {
  const elements = useCanvasStore((s) => s.elements);
  const activeTool = useCanvasStore((s) => s.activeTool);
  const updateElement = useCanvasStore((s) => s.updateElement);
  const dragTarget = useCanvasStore((s) => s.dragTarget);
  const setDragTarget = useCanvasStore((s) => s.setDragTarget);
  const selectedElementIds = useCanvasStore((s) => s.selectedElementIds);
  const setSelectedElementIds = useCanvasStore((s) => s.setSelectedElementIds);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [dragId, setDragId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [resizeTextId, setResizeTextId] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const dragRef = useRef({ elX: 0, elY: 0, mx: 0, my: 0 });
  const resizeStartRef = useRef({ startY: 0, startSize: 0 });

  const textElements = elements.filter((el) => el.type === 'text');
  const isSelect = activeTool === 'select';
  // isDraggingOther — reserved for future drag-other logic

  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingId]);

  // Window-level drag move
  useEffect(() => {
    if (!dragId) return;
    const onMove = (e: MouseEvent) => {
      const dx = e.clientX - dragRef.current.mx;
      const dy = e.clientY - dragRef.current.my;
      updateElement(dragId, {
        x: dragRef.current.elX + dx,
        y: dragRef.current.elY + dy,
      });
    };
    const onUp = () => {
      setDragId(null);
      setDragTarget(null);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragId, updateElement, setDragTarget]);

  // Window-level resize for text font size
  useEffect(() => {
    if (!resizeTextId) return;
    const onMove = (e: MouseEvent) => {
      const deltaY = e.clientY - resizeStartRef.current.startY;
      const newSize = Math.max(8, Math.min(72, resizeStartRef.current.startSize + Math.round(deltaY / 10)));
      useCanvasStore.getState().updateElement(resizeTextId, { fontSize: newSize });
    };
    const onUp = () => setResizeTextId(null);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [resizeTextId]);

  const handleDragStart = useCallback((e: React.MouseEvent, el: { id: string; x?: number; y?: number }) => {
    if (!isSelect) return;
    // Don't start if another drag is in progress
    if (dragTarget && dragTarget !== 'text:') return;
    e.stopPropagation();
    // Select the text element on click
    setSelectedElementIds([el.id]);
    setDragTarget(`text:${el.id}`);
    dragRef.current = { elX: el.x ?? 0, elY: el.y ?? 0, mx: e.clientX, my: e.clientY };
    setDragId(el.id);
  }, [isSelect, dragTarget, setDragTarget, setSelectedElementIds]);

  return (
    <>
      {textElements.map((el) => {
        if (editingId === el.id) {
          return (
            <textarea
              key={el.id}
              ref={inputRef}
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              onBlur={() => {
                if (editText.trim()) updateElement(el.id, { text: editText });
                setEditingId(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setEditingId(null);
                else if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  if (editText.trim()) updateElement(el.id, { text: editText });
                  setEditingId(null);
                }
              }}
              style={{
                position: 'absolute',
                left: el.x ?? 0,
                top: el.y ?? 0,
                fontSize: el.fontSize || 14,
                color: el.strokeColor,
                background: 'rgba(14,26,20,0.9)',
                border: '1px solid rgba(255,120,31,0.3)',
                borderRadius: 4,
                padding: 4,
                minWidth: 200,
                minHeight: 40,
                outline: 'none',
                resize: 'both',
                fontFamily: "'JetBrains Mono', monospace",
                zIndex: 9999,
              }}
            />
          );
        }

        const isHovered = hoveredId === el.id;
        const isSelected = selectedElementIds.includes(el.id);
        const showResize = isHovered && isSelect && !editingId && el.id !== resizeTextId;

        return (
          <div
            key={el.id}
            onMouseDown={(e) => handleDragStart(e, el)}
            onDoubleClick={() => {
              if (isSelect) {
                setEditText(el.text || '');
                setEditingId(el.id);
              }
            }}
            onMouseEnter={() => { if (isSelect && !editingId) setHoveredId(el.id); }}
            onMouseLeave={() => { if (hoveredId === el.id) setHoveredId(null); }}
            style={{
              position: 'absolute',
              left: el.x ?? 0,
              top: el.y ?? 0,
              fontSize: el.fontSize || 14,
              color: isHovered ? el.strokeColor : el.strokeColor,
              pointerEvents: isSelect ? 'auto' : 'none',
              cursor: isSelect ? 'move' : 'default',
              whiteSpace: 'pre-wrap',
              maxWidth: 300,
              textShadow: isHovered
                ? `0 0 12px ${el.strokeColor}40, 0 1px 4px rgba(0,0,0,0.8)`
                : '0 1px 4px rgba(0,0,0,0.8)',
              userSelect: isSelect ? 'auto' : 'none',
              zIndex: el.zIndex,
              padding: isHovered ? '1px 2px' : 0,
              borderRadius: isHovered ? 2 : 0,
              outline: isSelected
                ? `1.5px solid #F4A261`
                : isHovered
                  ? `1px solid ${el.strokeColor}30`
                  : 'none',
              transition: 'text-shadow 120ms ease, outline 120ms ease, padding 120ms ease',
            }}
          >
            {el.text}
            {/* Resize handle at bottom-right */}
            {showResize && (
              <div
                onMouseDown={(e) => {
                  e.stopPropagation();
                  setResizeTextId(el.id);
                  resizeStartRef.current = { startY: e.clientY, startSize: el.fontSize || 14 };
                }}
                style={{
                  position: 'absolute',
                  bottom: -6, right: -6,
                  width: 12, height: 12,
                  cursor: 'nwse-resize',
                  background: '#F4A261',
                  borderRadius: 2,
                  border: '1px solid rgba(0,0,0,0.5)',
                  zIndex: 10,
                }}
              />
            )}
          </div>
        );
      })}
    </>
  );
};

export const CanvasImages: React.FC = () => {
  const elements = useCanvasStore((s) => s.elements);
  const imageElements = elements.filter((el) => el.type === 'image');

  return (
    <>
      {imageElements.map((el) => (
        <img
          key={el.id}
          src={el.src}
          alt={el.alt || ''}
          style={{
            position: 'absolute',
            left: el.x ?? 0,
            top: el.y ?? 0,
            width: el.width || 200,
            height: el.height || 'auto',
            borderRadius: 4,
            pointerEvents: 'none',
            zIndex: el.zIndex,
          }}
        />
      ))}
    </>
  );
};
