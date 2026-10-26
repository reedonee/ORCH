import React from 'react';

interface GlassPanelProps {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  accent?: boolean;
  onClick?: () => void;
  onMouseDown?: (e: React.MouseEvent) => void;
  /** Capture-phase mousedown. Needed because xterm stops propagation on
   *  its own container, so a bubbling handler never sees clicks that land
   *  inside a terminal. */
  onMouseDownCapture?: (e: React.MouseEvent) => void;
  role?: string;
  'aria-label'?: string;
}

export const GlassPanel: React.FC<GlassPanelProps> = ({
  children,
  className = '',
  style,
  accent = false,
  onClick,
  onMouseDown,
  onMouseDownCapture,
  role,
  'aria-label': ariaLabel,
}) => {
  const baseClass = accent ? 'glass-accent' : 'glass';
  return (
    <div
      className={`${baseClass} ${className}`}
      style={style}
      onClick={onClick}
      onMouseDown={onMouseDown}
      onMouseDownCapture={onMouseDownCapture}
      role={role}
      aria-label={ariaLabel}
    >
      {children}
    </div>
  );
};
