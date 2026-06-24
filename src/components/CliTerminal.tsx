import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { invoke, listen } from '../lib/electron-api';
import { useThemeStore } from '../stores/useThemeStore';
import '@xterm/xterm/css/xterm.css';

interface CliTerminalProps {
  sessionId: string;
}

type Status = 'connecting' | 'connected' | 'error';

// ── Quick-action slash commands ─────────────────────────────────
const SLASH_COMMANDS = [
  { key: '/compact', label: 'Compact', desc: 'Compress context to save tokens' },
  { key: '/cost', label: 'Cost', desc: 'View token usage & spend' },
  { key: '/model sonnet', label: 'Sonnet', desc: 'Switch to Sonnet model' },
  { key: '/model opus', label: 'Opus', desc: 'Switch to Opus model' },
  { key: '/clear', label: 'Clear', desc: 'Wipe conversation history' },
] as const;

export const CliTerminal: React.FC<CliTerminalProps> = ({ sessionId }) => {
  const theme = useThemeStore((s) => s.theme);
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [status, _setStatus] = useState<Status>('connecting');
  const [showToolbar, setShowToolbar] = useState(false);
  const [terminalReady, setTerminalReady] = useState(false);
  const bytesRef = useRef(0);
  const statusRef = useRef(status);
  statusRef.current = status;

  // ── Wait for container to have layout before mounting terminal ──
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width >= 10 && rect.height >= 10) {
      setTerminalReady(true);
      return;
    }
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      if (r.width >= 10 && r.height >= 10) {
        setTerminalReady(true);
        ro.disconnect();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const sendToPty = useCallback((text: string) => {
    invoke('write_terminal', { sessionId, data: text }).catch(() => {});
  }, [sessionId]);

  const sendCommand = useCallback((cmd: string) => {
    sendToPty(cmd + '\r');
  }, [sendToPty]);

  // ── Mount xterm.js only when ready ─────────────────────────
  useEffect(() => {
    if (!terminalReady || !sessionId || !containerRef.current) return;
    let mounted = true;
    let unlistenTerm: (() => void) | null = null;

    const bg = theme.terminal.bg || '#050304';
    const fg = theme.terminal.fg || '#EAF4F4';
    const cursor = theme.terminal.cursor || '#F4A261';
    const selection = theme.terminal.selection || 'rgba(244, 162, 97, 0.3)';

    // ── Theme-responsive ANSI palette ───────────────────────────
    // Each theme defines its own terminal colors in theme.ts;
    // fall back to the brand-harmonized defaults if any slot is missing.
    const t = theme.terminal;
    const ansi = {
      black:   t.black || '#050304',  red:     t.red || '#E62E43',  green:   t.green || '#7EC8A0',
      yellow:  t.yellow || '#F4A261',  blue:    t.blue || '#6B9AC4',  magenta: t.magenta || '#C89EC4',
      cyan:    t.cyan || '#7EC8C8',  white:   t.white || '#C8D6D6',
      brightBlack:   t.brightBlack || '#1A1A1A', brightRed:     t.brightRed || '#E76F51',
      brightGreen:  t.brightGreen || '#A8E6CF', brightYellow: t.brightYellow || '#F4C27A',
      brightBlue:   t.brightBlue || '#8BB8E0', brightMagenta: t.brightMagenta || '#D8B8D4',
      brightCyan:   t.brightCyan || '#A8E0E0', brightWhite:  t.brightWhite || '#F5E6ED',
    };

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', monospace",
      cols: 140,
      rows: 40,
      convertEol: true,
      scrollback: 5000,
      allowProposedApi: true,
      theme: {
        background: bg,
        foreground: fg,
        cursor,
        selectionBackground: selection,
        ...ansi,
      },
    });

    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && e.ctrlKey && e.shiftKey && e.key === 'C') {
        const sel = term.getSelection();
        if (sel) navigator.clipboard.writeText(sel).catch(() => {});
        return false;
      }
      // Paste: Ctrl+Shift+V
      if (e.type === 'keydown' && e.ctrlKey && e.shiftKey && e.key === 'V') {
        navigator.clipboard.readText().then((text) => {
          if (text) sendToPty(text);
        }).catch(() => {});
        return false;
      }
      if (e.type === 'keydown' && e.ctrlKey && e.key === 'o') {
        setShowToolbar((prev) => !prev);
        return false;
      }
      return true;
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    fitAddonRef.current = fitAddon;
    terminalRef.current = term;

    term.open(containerRef.current);

    try {
      term.loadAddon(new WebglAddon());
    } catch {
      // WebGL unavailable
    }

    try {
      term.loadAddon(new WebLinksAddon());
    } catch {
      // fine
    }

    const safeFit = () => {
      if (!containerRef.current || !fitAddonRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 10) return;
      try { fitAddonRef.current.fit(); } catch { /* not laid out */ }
    };

    requestAnimationFrame(() => requestAnimationFrame(() => safeFit()));

    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(safeFit, 80);
    });
    ro.observe(containerRef.current);

    // ── Mouse wheel → page keys in alternate buffer (OpenCode TUI) ──
    const wheelHandler = (e: WheelEvent) => {
      if (term.buffer.active.type !== 'alternate') return;
      e.preventDefault();
      e.stopPropagation();
      const key = e.deltaY < 0 ? '\x1b[5~' : '\x1b[6~';
      sendToPty(key);
    };
    term.element?.addEventListener('wheel', wheelHandler, { capture: true, passive: false });

    // Replay existing buffer
    (async () => {
      try {
        const lines = await invoke<string[]>('read_terminal', { sessionId });
        if (mounted && lines.length > 0) {
          term.write(lines.join('\n'));
          if (!lines[lines.length - 1]?.endsWith('\n')) {
            term.write('\n');
          }
        }
      } catch {
        // first mount
      }
    })();

    const startListening = async () => {
      unlistenTerm = await listen<string>(`term_out_${sessionId}`, (data) => {
        if (!mounted) return;
        bytesRef.current += data.length;
        term.write(data);
      });
    };
    startListening();

    term.onData((data: string) => {
      sendToPty(data);
    });

    term.onResize(({ cols, rows }) => {
      invoke('resize_terminal', { sessionId, cols, rows }).catch(() => {});
    });

    setTimeout(() => term.focus(), 150);

    // ── Paste support (Ctrl+V / right-click paste) ──
    const handlePaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData('text/plain');
      if (text) {
        e.preventDefault();
        sendToPty(text);
      }
    };
    containerRef.current?.addEventListener('paste', handlePaste);

    return () => {
      mounted = false;
      if (unlistenTerm) unlistenTerm();
      ro.disconnect();
      if (resizeTimer) clearTimeout(resizeTimer);
      containerRef.current?.removeEventListener('paste', handlePaste);
      if (terminalRef.current?.element) terminalRef.current.element.removeEventListener('wheel', wheelHandler, { capture: true } as EventListenerOptions);
      try { term.dispose(); } catch { /* context already lost */ }
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalReady, sessionId]);

  // ── Re-theme when global theme changes ─────────────────────
  useEffect(() => {
    const term = terminalRef.current;
    if (!term) return;
    const t = theme.terminal;
    const ansi = {
      black:   t.black || '#050304',  red:     t.red || '#E62E43',  green:   t.green || '#7EC8A0',
      yellow:  t.yellow || '#F4A261',  blue:    t.blue || '#6B9AC4',  magenta: t.magenta || '#C89EC4',
      cyan:    t.cyan || '#7EC8C8',  white:   t.white || '#C8D6D6',
      brightBlack:   t.brightBlack || '#1A1A1A', brightRed:     t.brightRed || '#E76F51',
      brightGreen:  t.brightGreen || '#A8E6CF', brightYellow: t.brightYellow || '#F4C27A',
      brightBlue:   t.brightBlue || '#8BB8E0', brightMagenta: t.brightMagenta || '#D8B8D4',
      brightCyan:   t.brightCyan || '#A8E0E0', brightWhite:  t.brightWhite || '#F5E6ED',
    };
    term.options.theme = {
      background: theme.terminal.bg || '#050304',
      foreground: theme.terminal.fg || '#EAF4F4',
      cursor: theme.terminal.cursor || '#F4A261',
      selectionBackground: theme.terminal.selection || 'rgba(244,162,97,0.3)',
      ...ansi,
    };
  }, [theme]);

  const bg = theme.terminal.bg || '#0E1A14';
  const fg = theme.terminal.fg || '#EAF4F4';

  return (
    <div style={{
      width: '100%', height: '100%',
      display: 'flex', flexDirection: 'column',
      borderRadius: 'var(--radius-md)',
    }}>
      {showToolbar && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 4,
          padding: '4px 8px', fontSize: 11,
          fontFamily: "'JetBrains Mono', monospace",
          background: bg, borderBottom: `1px solid ${fg}15`,
          flexWrap: 'wrap', userSelect: 'none',
        }}>
          {SLASH_COMMANDS.map((cmd) => (
            <button
              key={cmd.key}
              onClick={() => sendCommand(cmd.key)}
              title={cmd.desc}
              style={{
                padding: '2px 8px', borderRadius: 4, border: `1px solid ${fg}20`,
                background: `${fg}08`, color: fg, cursor: 'pointer',
                fontSize: 10, fontFamily: 'inherit',
              }}
            >
              {cmd.label}
            </button>
          ))}
          <span style={{ flex: 1 }} />
          <span style={{ opacity: 0.3, fontSize: 9 }}>Ctrl+O hide</span>
        </div>
      )}

      <div
        ref={containerRef}
        style={{
          flex: 1, minHeight: 0,
          background: bg,
        }}
      />
    </div>
  );
};
