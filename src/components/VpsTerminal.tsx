import React from 'react';
import { useThemeStore } from '../stores/useThemeStore';

interface VpsTerminalProps {
  agentId: string;
  onSessionEnded?: () => void;
}

export const VpsTerminal: React.FC<VpsTerminalProps> = ({ onSessionEnded }) => {
  const theme = useThemeStore((s) => s.theme);
  const bg = theme.terminal.bg || '#050304';
  const fg = theme.terminal.fg || '#EAF4F4';

  return (
    <div style={{
      width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
      borderRadius: 'var(--radius-md)', position: 'relative',
    }}>
      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', gap: 12, padding: 24,
        background: bg, color: fg, borderRadius: 'var(--radius-md)',
        textAlign: 'center',
      }}>
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.4 }}>
          <path d="M4 7V4h16v3" />
          <path d="M9 20h6" />
          <path d="M12 4v16" />
          <rect x="2" y="7" width="20" height="13" rx="2" />
        </svg>
        <div style={{ fontSize: 13, fontWeight: 600, opacity: 0.7 }}>VPS Decommissioned</div>
        <div style={{ fontSize: 11, opacity: 0.4, maxWidth: 200 }}>
          Remote cloud terminals have been removed. All agents now run locally.
        </div>
        <button
          onClick={() => onSessionEnded?.()}
          style={{
            marginTop: 8, padding: '4px 14px', borderRadius: 6,
            border: `1px solid ${fg}20`, background: `${fg}08`,
            color: fg, cursor: 'pointer', fontSize: 11,
            fontFamily: 'inherit',
          }}
        >
          Close card
        </button>
      </div>
    </div>
  );
};
