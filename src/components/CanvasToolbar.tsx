// ── ORCH Canvas Toolbar (left) ────────────────────────────────
// Minimal tool palette — just Select, Pen, Shape, Text.
// All property controls moved to the right properties panel.

import React from 'react';
import { MousePointer, Pen, Square, Type, Eraser } from 'lucide-react';
import { useCanvasStore, type CanvasTool } from '../stores/useCanvasStore';
import { Z_BASE_LAYERS } from '../lib/z-stack-manager';
import { useThemeStore } from '../stores/useThemeStore';

interface ToolBtnProps {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
  brand: string;
  size?: 'sm' | 'md';
}

const ToolBtn: React.FC<ToolBtnProps> = ({ icon, label, active, onClick, brand, size = 'md' }) => (
  <button
    className="glass-btn"
    onClick={onClick}
    title={label}
    style={{
      width: size === 'md' ? 34 : 32,
      height: size === 'md' ? 30 : 24,
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
  </button>
);

const TOOLS: { id: CanvasTool; label: string; icon: React.ReactNode }[] = [
  { id: 'select', label: 'Select (navigate)', icon: <MousePointer size={15} /> },
  { id: 'pen',    label: 'Pen',    icon: <Pen size={15} /> },
  { id: 'shape',  label: 'Shape',  icon: <Square size={15} /> },
  { id: 'text',   label: 'Text',   icon: <Type size={15} /> },
  { id: 'eraser', label: 'Eraser', icon: <Eraser size={15} /> },
];

export const CanvasToolbar: React.FC = () => {
  const { activeTool, setActiveTool } = useCanvasStore();
  const brand = useThemeStore((s) => s.theme.colors.brand);

  return (
    <div
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
      {TOOLS.map((t) => (
        <ToolBtn key={t.id} icon={t.icon} label={t.label} active={activeTool === t.id} onClick={() => setActiveTool(t.id)} brand={brand} />
      ))}
    </div>
  );
};
