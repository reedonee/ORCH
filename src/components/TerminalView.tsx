import React, { useEffect, useMemo, useRef } from 'react';
import { useThemeStore } from '../stores/useThemeStore';
import { useTerminalStore } from '../stores/useTerminalStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { listen } from '../lib/electron-api';

interface TerminalViewProps {
  sessionId: string;
}

export const TerminalView: React.FC<TerminalViewProps> = ({ sessionId }) => {
  const { theme } = useThemeStore();
  const { terminalFontSize } = useSettingsStore();
  const { buffers, appendToBuffer } = useTerminalStore();
  const outputRef = useRef<HTMLDivElement>(null);

  const lines = buffers[sessionId] || [];
  const text = useMemo(() => lines.join('\n'), [lines]);

  useEffect(() => {
    if (!sessionId) return;
    let mounted = true;

    // Listen for live push events from Electron main process
    const unlistenPromise = listen<string>(`term_out_${sessionId}`, (data) => {
      if (!mounted) return;
      appendToBuffer(sessionId, data);
    });

    return () => {
      mounted = false;
      unlistenPromise.then(fn => fn()).catch(() => {});
    };
  }, [sessionId, appendToBuffer]);

  useEffect(() => {
    if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [text]);

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', width: '100%', height: '100%',
      background: 'rgba(30, 58, 58, 0.12)', borderRadius: 'var(--radius-md)', overflow: 'hidden',
    }}>
      <div ref={outputRef} style={{
        flex: 1, overflow: 'auto', padding: '12px 14px', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        fontFamily: "'JetBrains Mono', 'Cascadia Code', monospace", fontSize: terminalFontSize,
        lineHeight: 1.55, color: theme.terminal.fg, cursor: 'text',
      }}>
        {text || 'Session ready.'}
      </div>
    </div>
  );
};
