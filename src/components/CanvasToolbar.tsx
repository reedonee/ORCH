// ── ORCH Canvas Toolbar (left) ────────────────────────────────
// Tool palette. Property controls live in the right-hand panel; the
// one exception is the shape picker, which belongs next to the shape
// tool because it decides what that tool draws.

import React, { useEffect, useRef, useState } from 'react';
import {
  MousePointer, Hand, Pen, Square, Circle, Diamond,
  Frame, ArrowUpRight, Minus, Type, Eraser, ChevronRight,
} from 'lucide-react';
import { useCanvasStore, type CanvasTool, type ShapeType } from '../stores/useCanvasStore';
import { Z_BASE_LAYERS } from '../lib/z-stack-manager';
import { useThemeStore } from '../stores/useThemeStore';

interface ToolBtnProps {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
  brand: string;
  badge?: boolean;
}

const ToolBtn: React.FC<ToolBtnProps> = ({ icon, label, active, onClick, brand, badge }) => (
  <button
    className="glass-btn"
    onClick={onClick}
    title={label}
    aria-label={label}
    aria-pressed={active}
    style={{
      position: 'relative',
      width: 34, height: 30,
      padding: 0,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      borderRadius: 5, border: 'none',
      background: active ? `${brand}1e` : 'transparent',
      color: active ? brand : 'var(--text-secondary)',
      cursor: 'pointer',
      transition: 'all 0.12s ease',
    }}
  >
    {icon}
    {badge && (
      <ChevronRight
        size={8}
        style={{ position: 'absolute', right: 2, bottom: 2, opacity: 0.55 }}
      />
    )}
  </button>
);

const TOOLS: { id: CanvasTool; label: string; icon: React.ReactNode }[] = [
  { id: 'select', label: 'Select  (V)', icon: <MousePointer size={15} /> },
  { id: 'hand',   label: 'Pan  (H, or hold Space)', icon: <Hand size={15} /> },
  { id: 'pen',    label: 'Pen  (P)', icon: <Pen size={15} /> },
  { id: 'text',   label: 'Text  (T)', icon: <Type size={15} /> },
  { id: 'eraser', label: 'Eraser  (E)', icon: <Eraser size={15} /> },
];

const SHAPES: { id: ShapeType; label: string; icon: React.ReactNode }[] = [
  { id: 'rect',    label: 'Rectangle  (R)', icon: <Square size={15} /> },
  { id: 'ellipse', label: 'Ellipse  (O)', icon: <Circle size={15} /> },
  { id: 'diamond', label: 'Diamond', icon: <Diamond size={15} /> },
  { id: 'arrow',   label: 'Arrow', icon: <ArrowUpRight size={15} /> },
  { id: 'line',    label: 'Line', icon: <Minus size={15} /> },
  { id: 'frame',   label: 'Frame', icon: <Frame size={15} /> },
];

export const CanvasToolbar: React.FC = () => {
  const activeTool = useCanvasStore((s) => s.activeTool);
  const activeShapeType = useCanvasStore((s) => s.activeShapeType);
  const setActiveTool = useCanvasStore((s) => s.setActiveTool);
  const setActiveShapeType = useCanvasStore((s) => s.setActiveShapeType);
  const brand = useThemeStore((s) => s.theme.colors.brand);

  const [shapeMenu, setShapeMenu] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!shapeMenu) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setShapeMenu(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setShapeMenu(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [shapeMenu]);

  const current = SHAPES.find((sh) => sh.id === activeShapeType) ?? SHAPES[0];

  return (
    <div
      ref={rootRef}
      className="glass"
      style={{
        position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)',
        zIndex: Z_BASE_LAYERS.chromeToolbar,
        display: 'flex', flexDirection: 'column', gap: 1,
        padding: 6,
        borderRadius: 10,
        background: 'rgba(14,26,20,0.88)',
        border: '1px solid rgba(234,244,244,0.08)',
        backdropFilter: 'blur(12px)',
        userSelect: 'none',
      }}
    >
      {TOOLS.slice(0, 3).map((t) => (
        <ToolBtn
          key={t.id} icon={t.icon} label={t.label} brand={brand}
          active={activeTool === t.id}
          onClick={() => setActiveTool(t.id)}
        />
      ))}

      {/* Shape tool. The icon shows what it will draw; the chevron opens
          the picker. Six shape types behind one button beats six more
          buttons in a column that has to fit on a laptop screen. */}
      <div style={{ position: 'relative' }}>
        <ToolBtn
          icon={current.icon}
          label={`Shape — ${current.label}`}
          brand={brand}
          badge
          active={activeTool === 'shape'}
          onClick={() => {
            if (activeTool === 'shape') setShapeMenu((v) => !v);
            else { setActiveTool('shape'); setShapeMenu(true); }
          }}
        />
        {shapeMenu && (
          <div
            className="glass"
            role="menu"
            style={{
              position: 'absolute', left: 40, top: -4,
              display: 'flex', flexDirection: 'column', gap: 1,
              padding: 5, borderRadius: 9,
              background: 'rgba(14,26,20,0.96)',
              border: '1px solid rgba(234,244,244,0.10)',
              backdropFilter: 'blur(12px)',
              boxShadow: '0 10px 30px rgba(0,0,0,0.45)',
              zIndex: 1,
            }}
          >
            {SHAPES.map((sh) => (
              <button
                key={sh.id}
                role="menuitemradio"
                aria-checked={activeShapeType === sh.id}
                onClick={() => {
                  setActiveShapeType(sh.id);
                  setActiveTool('shape');
                  setShapeMenu(false);
                }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '5px 9px 5px 6px',
                  borderRadius: 5, border: 'none',
                  background: activeShapeType === sh.id ? `${brand}1e` : 'transparent',
                  color: activeShapeType === sh.id ? brand : 'var(--text-secondary)',
                  cursor: 'pointer', whiteSpace: 'nowrap',
                  fontSize: 11.5, fontFamily: 'var(--font-accent)',
                }}
                onMouseEnter={(e) => {
                  if (activeShapeType !== sh.id) {
                    e.currentTarget.style.background = 'rgba(255,255,255,0.05)';
                  }
                }}
                onMouseLeave={(e) => {
                  if (activeShapeType !== sh.id) e.currentTarget.style.background = 'transparent';
                }}
              >
                {sh.icon}
                {sh.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {TOOLS.slice(3).map((t) => (
        <ToolBtn
          key={t.id} icon={t.icon} label={t.label} brand={brand}
          active={activeTool === t.id}
          onClick={() => setActiveTool(t.id)}
        />
      ))}
    </div>
  );
};
