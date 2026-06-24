import React from 'react';

interface GlassPanelProps {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  accent?: boolean;
  onClick?: () => void;
  onMouseDown?: (e: React.MouseEvent) => void;
}

export const GlassPanel: React.FC<GlassPanelProps> = ({
  children,
  className = '',
  style,
  accent = false,
  onClick,
  onMouseDown,
}) => {
  const baseClass = accent ? 'glass-accent' : 'glass';
  return (
    <div
      className={`${baseClass} ${className}`}
      style={style}
      onClick={onClick}
      onMouseDown={onMouseDown}
    >
      {children}
    </div>
  );
};
