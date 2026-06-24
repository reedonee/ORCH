// ── ORCH Canvas Properties Panel ───────────────────────────────
// Single smart panel that adapts to the active canvas tool.
// Appears only for creation tools (pen / shape / text) with a
// smooth fade+scale animation. Solid dark theme, no glass UI.

import React, { useRef, useEffect, useState } from 'react';
import {
  Undo2, Redo2, PaintBucket, Frame, Circle, RectangleHorizontal,
} from 'lucide-react';
import { useCanvasStore, type CanvasTool, type ShapeType } from '../stores/useCanvasStore';
import { useThemeStore } from '../stores/useThemeStore';

// ── Sub-components ──────────────────────────────────────────────
const DIVIDER_COLOR = 'rgba(255,255,255,0.06)';

/** A tiny uppercase section label */
const SectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{
    fontSize: 8, fontWeight: 700, textTransform: 'uppercase',
    letterSpacing: 1, color: 'var(--text-muted)',
    marginBottom: 2,
  }}>
    {children}
  </div>
);

/** Thin horizontal rule */
const Divider: React.FC = () => (
  <div style={{ height: 1, background: DIVIDER_COLOR, margin: '2px 0' }} />
);

// ── Tool config ─────────────────────────────────────────────────
const TOOL_LABELS: Record<CanvasTool, { label: string; icon: string }> = {
  select: { label: 'Navigate', icon: '⇱' },
  pen:    { label: 'Draw',     icon: '✎' },
  shape:  { label: 'Shape',    icon: '◇' },
  text:   { label: 'Text',     icon: 'T' },
  eraser: { label: 'Eraser',   icon: '✕' },
};

const isCreation = (t: CanvasTool) => t === 'pen' || t === 'shape' || t === 'text';

// ── Main component ──────────────────────────────────────────────
export const CanvasPropertiesPanel: React.FC = () => {
  const theme = useThemeStore((s) => s.theme);
  const {
    activeTool,
    activeShapeType,
    strokeColor, setStrokeColor,
    strokeWidth, setStrokeWidth,
    fillEnabled, setFillEnabled,
    fillOpacity, setFillOpacity,
    fontSize, setFontSize,
    elements,
    undo, redo,
    undoStack, redoStack,
  } = useCanvasStore();

  const show = isCreation(activeTool);
  const [mounted, setMounted] = useState(show);
  const prevShow = useRef(show);

  // Delay unmount until after exit animation
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

  const canUndo = undoStack.length > 0;
  const canRedo = redoStack.length > 0;
  const info = TOOL_LABELS[activeTool];
  const tc = theme.colors;
  const swatches = [tc.brand, '#E62E43', '#9333EA', '#06B6D4', '#6BBF8A', '#F4A261', '#FFFFFF', '#888888'];

  const showColor = true;
  const showStroke = activeTool === 'pen' || activeTool === 'shape';
  const showFill = activeTool === 'shape';
  const showFont = activeTool === 'text';

  return (
    <div
      style={{
        position: 'absolute', right: 12, top: '50%',
        zIndex: 200,
        pointerEvents: show ? 'auto' : 'none',
      }}
    >
      <div
        style={{
          transform: `translateY(-50%) ${show ? 'scale(1)' : 'scale(0.92)'}`,
          transformOrigin: 'right center',
          opacity: show ? 1 : 0,
          transition: 'opacity 180ms ease, transform 180ms ease',
          display: 'flex', flexDirection: 'column', gap: 1,
          padding: 6,
          borderRadius: 10,
          background: 'rgba(14,26,20,0.88)',
          border: '1px solid rgba(234,244,244,0.08)',
          backdropFilter: 'blur(12px)',
          userSelect: 'none',
        }}
      >
        {/* ── Tool header ───────────────────────────────────────── */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 4,
          padding: '2px 2px 3px',
          borderBottom: `1px solid ${DIVIDER_COLOR}`,
          marginBottom: 2,
          fontSize: 9, fontWeight: 600,
          color: tc.brand,
        }}>
          <span style={{ fontSize: 11, lineHeight: 1 }}>{info.icon}</span>
          <span style={{ flex: 1 }}>{info.label}</span>
          {elements.length > 0 && (
            <span style={{
              fontSize: 8, fontWeight: 600,
              color: 'rgba(234,244,244,0.4)',
              background: 'rgba(255,255,255,0.06)',
              borderRadius: 3,
              padding: '0 4px',
              lineHeight: '14px',
            }}>
              {elements.length}
            </span>
          )}
        </div>

        {/* ── Color section ─────────────────────────────────────── */}
        {showColor && (
          <>
            <SectionLabel>Color</SectionLabel>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gridTemplateRows: 'repeat(2, 1fr)', gap: 2 }}>
              {swatches.map((c) => (
                <button
                  key={c}
                  onClick={() => setStrokeColor(c)}
                  title={c}
                  style={{
                    width: '100%', aspectRatio: '1.3/1', padding: 0,
                    borderRadius: 4, border: 'none',
                    outline: strokeColor === c
                      ? '1.5px solid rgba(255,255,255,0.7)'
                      : '1px solid rgba(255,255,255,0.08)',
                    outlineOffset: -1,
                    background: c,
                    cursor: 'pointer',
                    transition: 'outline 0.1s ease',
                    boxShadow: strokeColor === c
                      ? `0 0 6px ${c}60`
                      : 'none',
                  }}
                />
              ))}
            </div>
            {/* ── Spectrum strip picker ────────────────────────── */}
            <div
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const x = (e.clientX - rect.left) / rect.width;
                const hue = Math.round(x * 360);
                // HSV → RGB with full saturation, 85% brightness
                const h = hue / 60;
                const c = 1 * 0.85;
                const x2 = c * (1 - Math.abs((h % 2) - 1));
                let r = 0, g = 0, b = 0;
                if (h < 1) { r = c; g = x2; }
                else if (h < 2) { r = x2; g = c; }
                else if (h < 3) { g = c; b = x2; }
                else if (h < 4) { g = x2; b = c; }
                else if (h < 5) { r = x2; b = c; }
                else { r = c; b = x2; }
                const toHex = (n: number) => Math.round(n * 255).toString(16).padStart(2, '0');
                setStrokeColor(`#${toHex(r)}${toHex(g)}${toHex(b)}`);
              }}
              style={{
                width: '100%', height: 10, marginTop: 4,
                borderRadius: 4, cursor: 'crosshair',
                background: 'linear-gradient(to right, #ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000)',
                border: '1px solid rgba(255,255,255,0.08)',
              }}
              title="Click to pick a custom color"
            />
          </>
        )}

        {/* ── Stroke width ──────────────────────────────────────── */}
        {showStroke && (
          <>
            <Divider />
            <div style={{ padding: '1px 0' }}>
              <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                fontSize: 8, color: 'rgba(234,244,244,0.4)', marginBottom: 1,
              }}>
                <SectionLabel>Stroke</SectionLabel>
                <span style={{
                  color: 'rgba(234,244,244,0.6)',
                  fontFamily: "'JetBrains Mono', monospace", fontSize: 8,
                }}>
                  {strokeWidth}px
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                <span style={{ fontSize: 7, color: 'rgba(234,244,244,0.35)', cursor: 'pointer' }}
                  onClick={() => setStrokeWidth(Math.max(1, strokeWidth - 1))}>−</span>
                <input
                  type="range" min={1} max={8} step={0.5}
                  value={strokeWidth}
                  onChange={(e) => setStrokeWidth(Number(e.target.value))}
                  style={{
                    flex: 1, height: 2, accentColor: tc.brand,
                    cursor: 'pointer', margin: 0,
                  }}
                />
                <span style={{ fontSize: 7, color: 'rgba(234,244,244,0.35)', cursor: 'pointer' }}
                  onClick={() => setStrokeWidth(Math.min(8, strokeWidth + 1))}>+</span>
              </div>
            </div>
          </>
        )}

        {/* ── Fill (shape only) ──────────────────────────────────── */}
        {showFill && (
          <>
            <Divider />

            {/* Shape subtype selector */}
            <div style={{ padding: '1px 0', marginBottom: 2 }}>
              <SectionLabel>Style</SectionLabel>
              <div style={{ display: 'flex', gap: 2 }}>
                {([['frame', <Frame size={11} />], ['rect', <RectangleHorizontal size={11} />], ['ellipse', <Circle size={11} />]] as const).map(([id, icon]) => (
                  <button
                    key={id}
                    onClick={() => useCanvasStore.getState().setActiveShapeType(id as ShapeType)}
                    title={id}
                    style={{
                      flex: 1, padding: '3px 0',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      borderRadius: 4, border: 'none',
                      background: activeShapeType === id ? 'rgba(255,255,255,0.08)' : 'transparent',
                      color: activeShapeType === id ? tc.brand : 'rgba(234,244,244,0.5)',
                      cursor: 'pointer',
                      transition: 'all 0.1s ease',
                    }}
                  >
                    {icon}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ padding: '1px 0' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 3, marginBottom: fillEnabled ? 2 : 0 }}>
                <button
                  onClick={() => setFillEnabled(!fillEnabled)}
                  style={{
                    width: 14, height: 14, padding: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    borderRadius: 3,
                    border: '1px solid rgba(255,255,255,0.15)',
                    background: fillEnabled ? strokeColor + '25' : 'transparent',
                    cursor: 'pointer',
                    color: fillEnabled ? strokeColor : 'rgba(234,244,244,0.4)',
                    transition: 'background 0.12s ease',
                  }}
                  title="Toggle fill"
                >
                  <PaintBucket size={8} />
                </button>
                <span style={{ fontSize: 8, color: 'rgba(234,244,244,0.6)', flex: 1, fontWeight: 500 }}>
                  Fill
                </span>
                <span style={{
                  fontSize: 7, fontWeight: 600,
                  color: fillEnabled ? '#6BBF8A' : 'rgba(234,244,244,0.35)',
                }}>
                  {fillEnabled ? 'on' : 'off'}
                </span>
              </div>
              {fillEnabled && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 3, marginTop: 2, paddingLeft: 17 }}>
                  <span style={{ fontSize: 7, color: 'rgba(234,244,244,0.35)' }}>α</span>
                  <input
                    type="range" min={5} max={80}
                    value={fillOpacity}
                    onChange={(e) => setFillOpacity(Number(e.target.value))}
                    style={{
                      flex: 1, height: 2, accentColor: tc.brand,
                      cursor: 'pointer', margin: 0,
                    }}
                  />
                  <span style={{
                    fontSize: 7, color: 'rgba(234,244,244,0.6)',
                    fontFamily: "'JetBrains Mono', monospace", minWidth: 18, textAlign: 'right',
                  }}>
                    {fillOpacity}%
                  </span>
                </div>
              )}
            </div>
          </>
        )}

        {/* ── Font size (text only) ──────────────────────────────── */}
        {showFont && (
          <>
            <Divider />
            <div style={{ padding: '1px 0' }}>
              <div style={{
                display: 'flex', justifyContent: 'space-between',
                fontSize: 8, color: 'rgba(234,244,244,0.4)', marginBottom: 1,
              }}>
                <SectionLabel>Size</SectionLabel>
                <span style={{
                  color: 'rgba(234,244,244,0.6)',
                  fontFamily: "'JetBrains Mono', monospace", fontSize: 8,
                }}>
                  {fontSize}px
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                <span style={{ fontSize: 7, color: 'rgba(234,244,244,0.35)', cursor: 'pointer' }}
                  onClick={() => setFontSize(Math.max(10, fontSize - 2))}>−</span>
                <input
                  type="range" min={10} max={48}
                  value={fontSize}
                  onChange={(e) => setFontSize(Number(e.target.value))}
                  style={{
                    flex: 1, height: 2, accentColor: tc.brand,
                    cursor: 'pointer', margin: 0,
                  }}
                />
                <span style={{ fontSize: 7, color: 'rgba(234,244,244,0.35)', cursor: 'pointer' }}
                  onClick={() => setFontSize(Math.min(48, fontSize + 2))}>+</span>
              </div>
            </div>
          </>
        )}

        {/* ── Undo / Redo ──────────────────────────────────────── */}
        <Divider />
        <div style={{ display: 'flex', gap: 2, paddingTop: 1 }}>
          <button
            onClick={undo}
            disabled={!canUndo}
            style={{
              flex: 1, padding: '3px 0',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3,
              borderRadius: 5, border: '1px solid transparent',
              background: 'transparent',
              color: canUndo ? 'rgba(234,244,244,0.6)' : 'rgba(255,255,255,0.08)',
              fontSize: 8, fontWeight: 600,
              cursor: canUndo ? 'pointer' : 'default',
              transition: 'color 0.12s ease, background 0.12s ease',
            }}
            onMouseEnter={(e) => { if (canUndo) { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; e.currentTarget.style.color = '#EAF4F4'; }}}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = canUndo ? 'rgba(234,244,244,0.6)' : 'rgba(255,255,255,0.08)'; }}
            title="Undo (Ctrl+Z)"
          >
            <Undo2 size={9} /> Undo
          </button>
          <button
            onClick={redo}
            disabled={!canRedo}
            style={{
              flex: 1, padding: '3px 0',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3,
              borderRadius: 5, border: '1px solid transparent',
              background: 'transparent',
              color: canRedo ? 'rgba(234,244,244,0.6)' : 'rgba(255,255,255,0.08)',
              fontSize: 8, fontWeight: 600,
              cursor: canRedo ? 'pointer' : 'default',
              transition: 'color 0.12s ease, background 0.12s ease',
            }}
            onMouseEnter={(e) => { if (canRedo) { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; e.currentTarget.style.color = '#EAF4F4'; }}}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = canRedo ? 'rgba(234,244,244,0.6)' : 'rgba(255,255,255,0.08)'; }}
            title="Redo (Ctrl+Shift+Z)"
          >
            <Redo2 size={9} /> Redo
          </button>
        </div>
      </div>
    </div>
  );
};
