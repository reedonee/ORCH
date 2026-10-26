// ── ORCH Canvas Properties Panel ───────────────────────────────
// One panel that adapts to what you are doing.
//
// It used to appear only while a creation tool was held, which meant
// the styling controls were unreachable for anything already on the
// canvas: you could pick a colour before drawing a shape and never
// after. It now also opens on a selection, and every control writes
// through to the selected elements as well as to the tool defaults.

import React, { useRef, useEffect, useMemo, useState } from 'react';
import {
  Undo2, Redo2, PaintBucket, Frame, Circle, RectangleHorizontal,
  Diamond, ArrowUpRight, Minus, Copy, Trash2, Lock, Unlock,
  BringToFront, SendToBack,
} from 'lucide-react';
import { useCanvasStore, type CanvasTool, type ShapeType } from '../stores/useCanvasStore';
import { Z_BASE_LAYERS } from '../lib/z-stack-manager';
import { useThemeStore } from '../stores/useThemeStore';
import { withAlpha } from '../lib/color';

// ── Sub-components ──────────────────────────────────────────────
const DIVIDER_COLOR = 'rgba(255,255,255,0.07)';
const MUTED = 'rgba(234,244,244,0.55)';

const SectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{
    fontSize: 9, fontWeight: 700, textTransform: 'uppercase',
    letterSpacing: 0.9, color: 'var(--text-muted)',
    marginBottom: 3,
  }}>
    {children}
  </div>
);

const Divider: React.FC = () => (
  <div style={{ height: 1, background: DIVIDER_COLOR, margin: '5px 0' }} />
);

const Value: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span style={{ color: MUTED, fontFamily: "'JetBrains Mono', monospace", fontSize: 9.5 }}>
    {children}
  </span>
);

interface IconBtnProps {
  icon: React.ReactNode;
  title: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  danger?: boolean;
  brand: string;
}

const IconBtn: React.FC<IconBtnProps> = ({ icon, title, onClick, active, disabled, danger, brand }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    title={title}
    aria-label={title}
    aria-pressed={active}
    style={{
      flex: 1, padding: '5px 0',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      borderRadius: 5, border: 'none',
      background: active ? withAlpha(brand, 0.14) : 'transparent',
      color: disabled ? 'rgba(255,255,255,0.15)'
        : danger ? '#E76F51'
        : active ? brand : MUTED,
      cursor: disabled ? 'default' : 'pointer',
      transition: 'all 0.1s ease',
    }}
    onMouseEnter={(e) => { if (!disabled && !active) e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
    onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
  >
    {icon}
  </button>
);

// ── Tool config ─────────────────────────────────────────────────
const TOOL_LABELS: Record<CanvasTool, { label: string; icon: string }> = {
  select: { label: 'Select', icon: '⇱' },
  hand:   { label: 'Pan',    icon: '✋' },
  pen:    { label: 'Draw',   icon: '✎' },
  shape:  { label: 'Shape',  icon: '◇' },
  text:   { label: 'Text',   icon: 'T' },
  eraser: { label: 'Eraser', icon: '✕' },
};

const SHAPE_ICONS: Array<[ShapeType, React.ReactNode]> = [
  ['rect', <RectangleHorizontal size={12} />],
  ['ellipse', <Circle size={12} />],
  ['diamond', <Diamond size={12} />],
  ['arrow', <ArrowUpRight size={12} />],
  ['line', <Minus size={12} />],
  ['frame', <Frame size={12} />],
];

const DASHES: Array<['solid' | 'dashed' | 'dotted', string]> = [
  ['solid', '——'],
  ['dashed', '– –'],
  ['dotted', '· ·'],
];

const isCreation = (t: CanvasTool) => t === 'pen' || t === 'shape' || t === 'text';

// ── Main component ──────────────────────────────────────────────
export const CanvasPropertiesPanel: React.FC = () => {
  const theme = useThemeStore((s) => s.theme);

  const activeTool = useCanvasStore((s) => s.activeTool);
  const activeShapeType = useCanvasStore((s) => s.activeShapeType);
  const strokeColor = useCanvasStore((s) => s.strokeColor);
  const strokeWidth = useCanvasStore((s) => s.strokeWidth);
  const fillEnabled = useCanvasStore((s) => s.fillEnabled);
  const fillOpacity = useCanvasStore((s) => s.fillOpacity);
  const fontSize = useCanvasStore((s) => s.fontSize);
  const dashStyle = useCanvasStore((s) => s.dashStyle);
  const snapToGrid = useCanvasStore((s) => s.snapToGrid);
  const elements = useCanvasStore((s) => s.elements);
  const selectedIds = useCanvasStore((s) => s.selectedElementIds);
  const undoDepth = useCanvasStore((s) => s.undoStack.length);
  const redoDepth = useCanvasStore((s) => s.redoStack.length);

  const selection = useMemo(
    () => elements.filter((el) => selectedIds.includes(el.id)),
    [elements, selectedIds],
  );
  const hasSelection = selection.length > 0;

  // The panel is useful whenever there is something to configure:
  // a tool that is about to create something, or something selected.
  const show = isCreation(activeTool) || hasSelection;
  const [mounted, setMounted] = useState(show);
  const prevShow = useRef(show);

  useEffect(() => {
    if (show) {
      setMounted(true);
    } else if (prevShow.current) {
      const timer = setTimeout(() => setMounted(false), 200);
      return () => clearTimeout(timer);
    }
    prevShow.current = show;
  }, [show]);

  if (!mounted) return null;

  const store = useCanvasStore.getState;
  const tc = theme.colors;
  const brand = tc.brand;
  const swatches = [tc.brand, '#E62E43', '#9333EA', '#06B6D4', '#6BBF8A', '#F4A261', '#FFFFFF', '#888888'];

  /**
   * Write a style change to the selection and to the tool defaults.
   *
   * Both, deliberately: adjusting a control with something selected
   * should change it, and should also become what the next thing you
   * draw inherits.
   */
  const applyToSelection = (patch: Record<string, unknown>) => {
    if (!hasSelection) return;
    store().updateElements(selection.map((el) => ({ id: el.id, patch })));
  };

  const setColor = (c: string) => {
    store().setStrokeColor(c);
    if (hasSelection) {
      store().updateElements(selection.map((el) => ({
        id: el.id,
        patch: el.fillColor && el.fillColor !== 'transparent'
          ? { strokeColor: c, fillColor: withAlpha(c, fillOpacity / 100) }
          : { strokeColor: c },
      })));
    }
  };

  const setWidth = (w: number) => { store().setStrokeWidth(w); applyToSelection({ strokeWidth: w }); };
  const setDash = (d: 'solid' | 'dashed' | 'dotted') => { store().setDashStyle(d); applyToSelection({ dash: d }); };
  const setFont = (v: number) => { store().setFontSize(v); applyToSelection({ fontSize: v }); };

  const setShape = (t: ShapeType) => {
    store().setActiveShapeType(t);
    // Retyping a selected shape in place beats deleting and redrawing.
    const shapes = selection.filter((el) => el.type === 'shape');
    if (shapes.length > 0) {
      store().updateElements(shapes.map((el) => ({ id: el.id, patch: { shapeType: t } })));
    }
  };

  const toggleFill = () => {
    const next = !fillEnabled;
    store().setFillEnabled(next);
    applyToSelection({
      fillColor: next ? withAlpha(strokeColor, fillOpacity / 100) : 'transparent',
    });
  };

  const setFillA = (v: number) => {
    store().setFillOpacity(v);
    if (fillEnabled) applyToSelection({ fillColor: withAlpha(strokeColor, v / 100) });
  };

  // Which controls make sense right now.
  const selTypes = new Set(selection.map((el) => el.type));
  const showStroke = activeTool === 'pen' || activeTool === 'shape'
    || selTypes.has('shape') || selTypes.has('drawing');
  const showFill = activeTool === 'shape' || selTypes.has('shape');
  const showFont = activeTool === 'text' || selTypes.has('text');
  const showShapeRow = activeTool === 'shape' || selTypes.has('shape');
  const allLocked = hasSelection && selection.every((el) => el.locked);

  const info = TOOL_LABELS[activeTool];
  const headerLabel = hasSelection
    ? `${selection.length} selected`
    : info.label;

  return (
    <div
      style={{
        position: 'absolute', right: 12, top: '50%',
        zIndex: Z_BASE_LAYERS.chromeToolbar,
        pointerEvents: show ? 'auto' : 'none',
      }}
    >
      <div
        style={{
          transform: `translateY(-50%) ${show ? 'scale(1)' : 'scale(0.92)'}`,
          transformOrigin: 'right center',
          opacity: show ? 1 : 0,
          transition: 'opacity 180ms ease, transform 180ms ease',
          display: 'flex', flexDirection: 'column',
          width: 152,
          padding: 8,
          borderRadius: 10,
          background: 'rgba(14,26,20,0.90)',
          border: '1px solid rgba(234,244,244,0.09)',
          backdropFilter: 'blur(14px)',
          boxShadow: '0 12px 34px rgba(0,0,0,0.42)',
          userSelect: 'none',
        }}
      >
        {/* ── Header ────────────────────────────────────────────── */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 5,
          paddingBottom: 5,
          borderBottom: `1px solid ${DIVIDER_COLOR}`,
          marginBottom: 5,
          fontSize: 10.5, fontWeight: 600,
          color: brand,
        }}>
          <span style={{ fontSize: 12, lineHeight: 1 }}>{hasSelection ? '◆' : info.icon}</span>
          <span style={{ flex: 1 }}>{headerLabel}</span>
          {elements.length > 0 && !hasSelection && (
            <span style={{
              fontSize: 9, fontWeight: 600, color: 'rgba(234,244,244,0.45)',
              background: 'rgba(255,255,255,0.06)', borderRadius: 3,
              padding: '0 5px', lineHeight: '15px',
            }}>
              {elements.length}
            </span>
          )}
        </div>

        {/* ── Colour ────────────────────────────────────────────── */}
        <SectionLabel>Colour</SectionLabel>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 3 }}>
          {swatches.map((c) => (
            <button
              key={c}
              onClick={() => setColor(c)}
              title={c}
              aria-label={`Colour ${c}`}
              style={{
                width: '100%', aspectRatio: '1.35/1', padding: 0,
                borderRadius: 4, border: 'none',
                outline: strokeColor === c
                  ? '1.5px solid rgba(255,255,255,0.75)'
                  : '1px solid rgba(255,255,255,0.08)',
                outlineOffset: -1,
                background: c,
                cursor: 'pointer',
                transition: 'outline 0.1s ease',
                boxShadow: strokeColor === c ? `0 0 7px ${withAlpha(c, 0.45)}` : 'none',
              }}
            />
          ))}
        </div>

        <div
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const hue = ((e.clientX - rect.left) / rect.width) * 360;
            // HSV → RGB at full saturation, 85% value.
            const h = hue / 60;
            const c = 0.85;
            const x2 = c * (1 - Math.abs((h % 2) - 1));
            let r = 0, g = 0, b = 0;
            if (h < 1) { r = c; g = x2; }
            else if (h < 2) { r = x2; g = c; }
            else if (h < 3) { g = c; b = x2; }
            else if (h < 4) { g = x2; b = c; }
            else if (h < 5) { r = x2; b = c; }
            else { r = c; b = x2; }
            const toHex = (n: number) => Math.round(n * 255).toString(16).padStart(2, '0');
            setColor(`#${toHex(r)}${toHex(g)}${toHex(b)}`);
          }}
          style={{
            width: '100%', height: 11, marginTop: 5,
            borderRadius: 4, cursor: 'crosshair',
            background: 'linear-gradient(to right, #ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000)',
            border: '1px solid rgba(255,255,255,0.08)',
          }}
          title="Click to pick a custom colour"
        />

        {/* ── Shape type ────────────────────────────────────────── */}
        {showShapeRow && (
          <>
            <Divider />
            <SectionLabel>Shape</SectionLabel>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 1 }}>
              {SHAPE_ICONS.map(([id, icon]) => (
                <IconBtn
                  key={id}
                  icon={icon}
                  title={id}
                  brand={brand}
                  active={activeShapeType === id}
                  onClick={() => setShape(id)}
                />
              ))}
            </div>
          </>
        )}

        {/* ── Stroke ────────────────────────────────────────────── */}
        {showStroke && (
          <>
            <Divider />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <SectionLabel>Stroke</SectionLabel>
              <Value>{strokeWidth}px</Value>
            </div>
            <input
              type="range" min={1} max={24} step={0.5}
              value={strokeWidth}
              onChange={(e) => setWidth(Number(e.target.value))}
              aria-label="Stroke width"
              style={{ width: '100%', height: 2, accentColor: brand, cursor: 'pointer', margin: '2px 0 5px' }}
            />
            <div style={{ display: 'flex', gap: 1 }}>
              {DASHES.map(([id, glyph]) => (
                <IconBtn
                  key={id}
                  icon={<span style={{ fontSize: 11, letterSpacing: -1 }}>{glyph}</span>}
                  title={id}
                  brand={brand}
                  active={dashStyle === id}
                  onClick={() => setDash(id)}
                />
              ))}
            </div>
          </>
        )}

        {/* ── Fill ──────────────────────────────────────────────── */}
        {showFill && (
          <>
            <Divider />
            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <button
                onClick={toggleFill}
                title="Toggle fill"
                aria-pressed={fillEnabled}
                style={{
                  width: 18, height: 18, padding: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  borderRadius: 4,
                  border: '1px solid rgba(255,255,255,0.15)',
                  background: fillEnabled ? withAlpha(strokeColor, 0.22) : 'transparent',
                  cursor: 'pointer',
                  color: fillEnabled ? strokeColor : 'rgba(234,244,244,0.4)',
                }}
              >
                <PaintBucket size={10} />
              </button>
              <span style={{ fontSize: 10.5, color: MUTED, flex: 1, fontWeight: 500 }}>Fill</span>
              <Value>{fillEnabled ? `${fillOpacity}%` : 'off'}</Value>
            </div>
            {fillEnabled && (
              <input
                type="range" min={5} max={100}
                value={fillOpacity}
                onChange={(e) => setFillA(Number(e.target.value))}
                aria-label="Fill opacity"
                style={{ width: '100%', height: 2, accentColor: brand, cursor: 'pointer', marginTop: 5 }}
              />
            )}
          </>
        )}

        {/* ── Font size ─────────────────────────────────────────── */}
        {showFont && (
          <>
            <Divider />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <SectionLabel>Size</SectionLabel>
              <Value>{fontSize}px</Value>
            </div>
            <input
              type="range" min={10} max={72}
              value={fontSize}
              onChange={(e) => setFont(Number(e.target.value))}
              aria-label="Font size"
              style={{ width: '100%', height: 2, accentColor: brand, cursor: 'pointer', marginTop: 2 }}
            />
          </>
        )}

        {/* ── Selection actions ─────────────────────────────────── */}
        {hasSelection && (
          <>
            <Divider />
            <SectionLabel>Arrange</SectionLabel>
            <div style={{ display: 'flex', gap: 1 }}>
              <IconBtn icon={<BringToFront size={12} />} title="Bring to front  (])" brand={brand}
                onClick={() => store().bringToFront(selectedIds)} />
              <IconBtn icon={<SendToBack size={12} />} title="Send to back  ([)" brand={brand}
                onClick={() => store().sendToBack(selectedIds)} />
              <IconBtn icon={<Copy size={12} />} title="Duplicate  (Ctrl+D)" brand={brand}
                onClick={() => store().duplicateElements(selectedIds)} />
              <IconBtn
                icon={allLocked ? <Lock size={12} /> : <Unlock size={12} />}
                title={allLocked ? 'Unlock' : 'Lock'}
                brand={brand}
                active={allLocked}
                onClick={() => store().setLocked(selectedIds, !allLocked)}
              />
              <IconBtn icon={<Trash2 size={12} />} title="Delete  (Del)" brand={brand} danger
                onClick={() => store().removeElements(selectedIds)} />
            </div>
          </>
        )}

        {/* ── Snap ──────────────────────────────────────────────── */}
        <Divider />
        <label style={{
          display: 'flex', alignItems: 'center', gap: 6,
          fontSize: 10.5, color: MUTED, cursor: 'pointer',
        }}>
          <input
            type="checkbox"
            checked={snapToGrid}
            onChange={(e) => store().setSnapToGrid(e.target.checked)}
            style={{ accentColor: brand, margin: 0, cursor: 'pointer' }}
          />
          Snap to grid
        </label>

        {/* ── Undo / Redo ───────────────────────────────────────── */}
        <Divider />
        <div style={{ display: 'flex', gap: 2 }}>
          <IconBtn
            icon={<span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, fontWeight: 600 }}>
              <Undo2 size={11} /> Undo
            </span>}
            title="Undo  (Ctrl+Z)"
            brand={brand}
            disabled={undoDepth === 0}
            onClick={() => store().undo()}
          />
          <IconBtn
            icon={<span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, fontWeight: 600 }}>
              <Redo2 size={11} /> Redo
            </span>}
            title="Redo  (Ctrl+Shift+Z)"
            brand={brand}
            disabled={redoDepth === 0}
            onClick={() => store().redo()}
          />
        </div>
      </div>
    </div>
  );
};
