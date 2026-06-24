import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { vpsClient } from '../lib/vps-client';
import { useThemeStore } from '../stores/useThemeStore';
import '@xterm/xterm/css/xterm.css';

interface VpsTerminalProps {
  agentId: string;
  onSessionEnded?: () => void;
}

export const VpsTerminal: React.FC<VpsTerminalProps> = ({ agentId, onSessionEnded }) => {
  const theme = useThemeStore((s) => s.theme);
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'error' | 'ended'>('connecting');
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionEndedRef = useRef(false);
  const isFirstSnapshot = useRef(true);
  const userScrolledUp = useRef(false);

  // ── Wait for layout ──
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (el.getBoundingClientRect().width >= 10 && el.getBoundingClientRect().height >= 10) {
      setReady(true);
      return;
    }
    const ro = new ResizeObserver(() => {
      if (el.getBoundingClientRect().width >= 10 && el.getBoundingClientRect().height >= 10) {
        setReady(true);
        ro.disconnect();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── Mount xterm.js ──
  useEffect(() => {
    if (!ready || !containerRef.current) return;
    let mounted = true;
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
        background: bg, foreground: fg, cursor,
        selectionBackground: selection,
        ...ansi,
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    fitAddonRef.current = fitAddon;
    terminalRef.current = term;
    term.open(containerRef.current);

    try { term.loadAddon(new WebglAddon()); } catch { /* ok */ }
    try { term.loadAddon(new WebLinksAddon()); } catch { /* ok */ }

    // ── Copy: Ctrl+Shift+C ──────────────────────────────────
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && e.ctrlKey && e.shiftKey && e.key === 'C') {
        const sel = term.getSelection();
        if (sel) navigator.clipboard.writeText(sel).catch(() => {});
        return false;
      }
      // Paste: Ctrl+Shift+V (explicit terminal paste shortcut)
      if (e.type === 'keydown' && e.ctrlKey && e.shiftKey && e.key === 'V') {
        navigator.clipboard.readText().then((text) => {
          if (text) {
            const trimmed = text.trim();
            const ws = socketRef.current;
            if (ws?.readyState === WebSocket.OPEN)
              ws.send(JSON.stringify({ event: 'input', data: trimmed }));
          }
        }).catch(() => {});
        return false;
      }
      // Block raw Ctrl+V from sending \x16 to terminal — paste is handled
      // by the DOM paste event listener on the container div
      if (e.type === 'keydown' && e.ctrlKey && !e.shiftKey && e.key === 'v') {
        return false;
      }
      return true;
    });

    // ── Track scroll: pause auto-scroll when user scrolls up ──
    term.onScroll((delta) => {
      const buffer = term.buffer.active;
      userScrolledUp.current = buffer.baseY > 0;
    });

    // ── Mouse wheel → page keys in alternate buffer (OpenCode TUI) ──
    const wheelHandler = (e: WheelEvent) => {
      if (term.buffer.active.type !== 'alternate') return;
      e.preventDefault();
      e.stopPropagation();
      const ws = socketRef.current;
      if (ws?.readyState !== WebSocket.OPEN) return;
      // Page Up/Down — scrolls within TUI apps like OpenCode
      const key = e.deltaY < 0 ? '\x1b[5~' : '\x1b[6~';
      ws.send(JSON.stringify({ event: 'input', data: key }));
    };
    // Attach with capture so we intercept BEFORE xterm's own scroll handling
    term.element?.addEventListener('wheel', wheelHandler, { capture: true, passive: false });

    const safeFit = () => {
      if (!containerRef.current || !fitAddonRef.current) return;
      try { fitAddonRef.current.fit(); } catch { /* not laid out */ }
    };
    requestAnimationFrame(() => requestAnimationFrame(() => safeFit()));

    const ro = new ResizeObserver(() => {
      setTimeout(() => {
        safeFit();
        const termInstance = terminalRef.current;
        const ws = socketRef.current;
        if (termInstance && ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ event: 'resize', cols: termInstance.cols, rows: termInstance.rows }));
        }
      }, 80);
    });
    ro.observe(containerRef.current);

    const { ws } = vpsClient.urls();
    const wsUrl = `${ws}/ws/terminal/${encodeURIComponent(agentId)}`;
    let disposed = false;

    const connectTerminal = () => {
      if (disposed) return;
      setStatus('connecting');
      const socket = new WebSocket(wsUrl);
      socketRef.current = socket;

      socket.onopen = () => {
        if (!mounted || disposed) return;
        setStatus('connected');
        const termInstance = terminalRef.current;
        if (termInstance) {
          socket.send(JSON.stringify({ event: 'resize', cols: termInstance.cols, rows: termInstance.rows }));
        }
      };

      socket.onmessage = (event) => {
        if (!mounted || disposed) return;
        try {
          const message = JSON.parse(event.data as string) as { event?: string; data?: string };
          if (message.event === 'snapshot') {
            if (isFirstSnapshot.current) {
              term.reset();
              isFirstSnapshot.current = false;
            } else {
              term.clear();
            }
            if (message.data) {
              term.write(message.data);
              if (!userScrolledUp.current) term.scrollToBottom();
            }
          } else if (message.event === 'output') {
            if (message.data) term.write(message.data);
          } else if (message.event === 'exit') {
            term.write('\r\n[tmux session ended]\r\n');
            sessionEndedRef.current = true;
            setStatus('ended');
            // Auto-close the agent card
            onSessionEnded?.();
          }
        } catch {
          term.write(String(event.data ?? ''));
        }
      };

      socket.onerror = () => {
        if (!mounted || disposed) return;
        setStatus('error');
      };

      socket.onclose = () => {
        if (!mounted || disposed) return;
        socketRef.current = null;
        if (sessionEndedRef.current) {
          setStatus('ended');
          return;  // don't reconnect — session was intentionally closed
        }
        setStatus('connecting');
        if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = setTimeout(() => connectTerminal(), 1000);
      };
    };

    connectTerminal();

    // ── User input → VPS ──
    term.onData((data: string) => {
      const wsConn = socketRef.current;
      if (wsConn?.readyState === WebSocket.OPEN) {
        wsConn.send(JSON.stringify({ event: 'input', data }));
      }
    });

    setTimeout(() => term.focus(), 150);

    // ── Paste support (Ctrl+V / right-click paste) ──
    const handlePaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData('text/plain');
      if (text) {
        e.preventDefault();
        const trimmed = text.trim();
        const ws = socketRef.current;
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ event: 'input', data: trimmed }));
        }
      }
    };
    containerRef.current?.addEventListener('paste', handlePaste);

    return () => {
      mounted = false;
      disposed = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (socketRef.current) {
        try { socketRef.current.close(); } catch { /* ignore */ }
        socketRef.current = null;
      }
      ro.disconnect();
      containerRef.current?.removeEventListener('paste', handlePaste);
      if (terminalRef.current?.element) terminalRef.current.element.removeEventListener('wheel', wheelHandler, { capture: true } as EventListenerOptions);
      try { term.dispose(); } catch { /* gone */ }
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, agentId]);

  // ── Re-theme ──
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
      width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
      borderRadius: 'var(--radius-md)', position: 'relative',
    }}>
      {/* Status indicator */}
      <div style={{
        position: 'absolute', top: 4, right: 8, fontSize: 9, opacity: 0.5,
        fontFamily: "'JetBrains Mono', monospace", color: status === 'connected' ? '#22c55e' : fg,
      }}>
        {status === 'connecting' ? '⌛ VPS...' : status === 'ended' ? '■ Ended' : status === 'error' ? '⚠️ VPS err' : '🟢 VPS'}
      </div>
      <div ref={containerRef} style={{
        flex: 1, overflow: 'hidden', borderRadius: 'var(--radius-md)',
        background: bg, color: fg,
      }} />
    </div>
  );
};
