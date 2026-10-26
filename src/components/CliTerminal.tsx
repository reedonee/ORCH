import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import {
  invoke, listen, readTerminal, transcriptExport, transcriptStats,
} from '../lib/electron-api';
import { useThemeStore } from '../stores/useThemeStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { withAlpha } from '../lib/color';
import {
  Search, X, ArrowUp, ArrowDown, Download, ChevronsDown, Type,
} from 'lucide-react';
import '@xterm/xterm/css/xterm.css';

interface CliTerminalProps {
  sessionId: string;
  /** Agent name, used in accessible labels and export filenames. */
  agentName?: string;
}

// ── Quick-action slash commands ─────────────────────────────────
const SLASH_COMMANDS = [
  { key: '/compact', label: 'Compact', desc: 'Compress context to save tokens' },
  { key: '/cost', label: 'Cost', desc: 'View token usage & spend' },
  { key: '/model sonnet', label: 'Sonnet', desc: 'Switch to Sonnet model' },
  { key: '/model opus', label: 'Opus', desc: 'Switch to Opus model' },
  { key: '/clear', label: 'Clear', desc: 'Wipe conversation history' },
] as const;

/** How opaque an explicit ANSI-black background is allowed to be. Low
 *  enough to read as tinted glass, high enough that a TUI's panels still
 *  register as distinct regions. */
const ANSI_BLACK_ALPHA = 0.5;

const XTERM_STYLE_ID = 'orch-xterm-base';

/** Injected once for the whole app. The previous guard was component-local
 *  state, so every agent card appended another identical <style> to
 *  document.head and none were ever removed. */
function ensureXtermStyles(): void {
  if (document.getElementById(XTERM_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = XTERM_STYLE_ID;
  style.textContent = `
    .xterm, .xterm-viewport, .xterm-rows, .xterm-rows > div,
    .xterm .xterm-screen, .xterm .xterm-scroll-area,
    .xterm .xterm-rows > div > span {
      background: transparent !important;
    }
    /* A visible, low-contrast scrollbar. xterm's default is invisible on
       a transparent background, so there was no scroll affordance at all. */
    .xterm-viewport::-webkit-scrollbar { width: 10px; }
    .xterm-viewport::-webkit-scrollbar-track { background: transparent; }
    .xterm-viewport::-webkit-scrollbar-thumb {
      background: rgba(255,255,255,0.14);
      border-radius: 5px;
      border: 2px solid transparent;
      background-clip: content-box;
    }
    .xterm-viewport::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.28); background-clip: content-box; }
    /* Search hit styling — the addon sets these CSS custom properties. */
    .xterm .xterm-decoration-overview-ruler { z-index: 8; }

    /* ── Full transparency ──────────────────────────────────────
       A TUI paints its own panels by setting cell background colours.
       Those arrive as basic (40-47), bright (100-107) and TRUECOLOR
       (48;2;r;g;b) escapes. Theme overrides can only reach the first two
       — truecolour is per-cell and unthemeable — which is why solid
       blocks kept surviving behind labels and status bars.

       With the DOM renderer each styled run is a span carrying an inline
       background-color, and !important is the one case where CSS beats
       an inline style. So this reaches every background regardless of how
       it was specified. Selection still shows: the DOM renderer draws it
       as a separate layer, not as cell backgrounds. */
    .orch-term-transparent .xterm-rows span { background-color: transparent !important; }
    .orch-term-transparent .xterm-rows > div { background-color: transparent !important; }
  `;
  document.head.appendChild(style);
}

export const CliTerminal: React.FC<CliTerminalProps> = ({ sessionId, agentName }) => {
  const theme = useThemeStore((s) => s.theme);
  // Selector subscriptions: subscribing to the whole settings store made
  // every terminal re-render whenever any unrelated setting changed.
  const terminalFontSize = useSettingsStore((s) => s.terminalFontSize);
  const terminalScrim = useSettingsStore((s) => s.terminalScrim);
  const terminalTransparency = useSettingsStore((s) => s.terminalTransparency);

  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);

  const [terminalReady, setTerminalReady] = useState(false);
  const [showToolbar, setShowToolbar] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [query, setQuery] = useState('');
  const [matchInfo, setMatchInfo] = useState<{ current: number; total: number } | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [unseenOutput, setUnseenOutput] = useState(false);
  const [fontScale, setFontScale] = useState(0);      // per-terminal nudge
  const [exportMsg, setExportMsg] = useState<string | null>(null);

  const searchInputRef = useRef<HTMLInputElement>(null);
  // Read inside the mount effect without listing it as a dependency —
  // that would remount xterm and discard scrollback whenever it changed.
  const transparencyRef = useRef(terminalTransparency);
  transparencyRef.current = terminalTransparency;

  useEffect(() => { ensureXtermStyles(); }, []);

  const effectiveFontSize = Math.max(9, Math.min(24, terminalFontSize + fontScale));

  // ── Wait for layout before mounting xterm ────────────────────
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

  const sendCommand = useCallback((cmd: string) => sendToPty(cmd + '\r'), [sendToPty]);

  const scrollToBottom = useCallback(() => {
    terminalRef.current?.scrollToBottom();
    setUnseenOutput(false);
  }, []);

  // ── Mount xterm ──────────────────────────────────────────────
  useEffect(() => {
    if (!terminalReady || !sessionId || !containerRef.current) return;
    let mounted = true;
    let unlistenTerm: (() => void) | null = null;

    const t = theme.terminal;
    // ANSI colour 0 is deliberately TRANSLUCENT.
    //
    // A transparent default background only covers cells the app never
    // styled. TUIs like Codex draw their panels and highlights by setting
    // an explicit black background (`\x1b[40m` / `\x1b[48;5;0m`), and xterm
    // paints those opaquely — which is why solid black rectangles kept
    // appearing behind headers and inline labels on every theme. Making
    // colour 0 translucent lets those panels read as a darker pane of the
    // same glass instead of a hole punched through the card.
    const ansi = {
      black: withAlpha(t.black || '#050304', ANSI_BLACK_ALPHA), red: t.red || '#E62E43', green: t.green || '#7EC8A0',
      yellow: t.yellow || '#F4A261', blue: t.blue || '#6B9AC4', magenta: t.magenta || '#C89EC4',
      cyan: t.cyan || '#7EC8C8', white: t.white || '#C8D6D6',
      // Bright backgrounds (SGR 100-107) resolve to these. Translucent so
      // they tint rather than block even in 'gpu' mode.
      brightBlack: withAlpha(t.brightBlack || '#5A6A6A', 0.55), brightRed: t.brightRed || '#E76F51',
      brightGreen: t.brightGreen || '#A8E6CF', brightYellow: t.brightYellow || '#F4C27A',
      brightBlue: t.brightBlue || '#8BB8E0', brightMagenta: t.brightMagenta || '#D8B8D4',
      brightCyan: t.brightCyan || '#A8E0E0', brightWhite: t.brightWhite || '#F5E6ED',
    };

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontSize: effectiveFontSize,
      fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', 'SF Mono', Consolas, monospace",
      // Slightly heavier strokes hold up far better against a bright,
      // busy wallpaper than the default 400 weight.
      fontWeight: 500,
      fontWeightBold: 700,
      // Readability: xterm's 1.0 default packs lines tightly, which is hard
      // to scan in a small card. 1.35 is close to what editors use.
      lineHeight: 1.35,
      letterSpacing: 0,
      cols: 140,
      rows: 40,
      convertEol: true,
      // REQUIRED for a see-through terminal. xterm paints its own
      // background layer inside the renderer (WebGL/canvas), which CSS
      // cannot reach — so `background: 'transparent'` in the theme and
      // `background: transparent !important` in stylesheets were both
      // being ignored and every terminal rendered opaque black on every
      // theme. This flag makes the renderer honour an alpha background.
      allowTransparency: true,
      // 100k lines of in-terminal scrollback. The full transcript still
      // lives on disk; this is just what stays instantly scrollable.
      scrollback: 100_000,
      allowProposedApi: true,
      // Draw bold as bold rather than as a bright colour, so bold text
      // doesn't silently change meaning-carrying colours.
      drawBoldTextInBrightColors: false,
      // 7:1 is WCAG AAA. Over a photographic backdrop the effective
      // contrast is worse than the nominal figure suggests, so aim high
      // and let xterm lift any pair that falls short.
      minimumContrastRatio: 7,
      scrollOnUserInput: true,
      smoothScrollDuration: 0,
      theme: {
        // rgba(0,0,0,0) rather than 'transparent': xterm parses theme
        // colours itself and the keyword is not reliably handled by the
        // WebGL renderer's colour parser.
        background: 'rgba(0, 0, 0, 0)',
        foreground: t.fg || '#EAF4F4',
        cursor: t.cursor || '#F4A261',
        cursorAccent: t.bg || '#0E1A14',
        selectionBackground: t.selection || 'rgba(244, 162, 97, 0.35)',
        ...ansi,
      },
    });

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const mod = e.ctrlKey || e.metaKey;

      // Copy selection
      if (mod && e.shiftKey && e.key === 'C') {
        const sel = term.getSelection();
        if (sel) navigator.clipboard.writeText(sel).catch(() => {});
        return false;
      }
      // Paste
      if (mod && e.shiftKey && e.key === 'V') {
        navigator.clipboard.readText().then((text) => { if (text) sendToPty(text); }).catch(() => {});
        return false;
      }
      // Raw Ctrl+V would send \x16; DOM paste handles it instead.
      if (mod && !e.shiftKey && e.key === 'v') return false;

      // Search
      if (mod && e.key === 'f') {
        setShowSearch(true);
        setTimeout(() => searchInputRef.current?.focus(), 0);
        return false;
      }
      // Toolbar
      if (mod && e.key === 'o') { setShowToolbar((p) => !p); return false; }
      // Font size
      if (mod && (e.key === '=' || e.key === '+')) { setFontScale((f) => Math.min(10, f + 1)); return false; }
      if (mod && e.key === '-') { setFontScale((f) => Math.max(-6, f - 1)); return false; }
      if (mod && e.key === '0') { setFontScale(0); return false; }

      return true;
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    fitAddonRef.current = fitAddon;

    const searchAddon = new SearchAddon();
    term.loadAddon(searchAddon);
    searchAddonRef.current = searchAddon;
    searchAddon.onDidChangeResults((r) => {
      setMatchInfo(r ? { current: r.resultIndex + 1, total: r.resultCount } : null);
    });

    // Correct width for CJK, emoji and box-drawing characters. Without
    // this, wide glyphs render half-width and every TUI that uses them
    // (which is most of them) draws misaligned.
    try {
      const unicode11 = new Unicode11Addon();
      term.loadAddon(unicode11);
      term.unicode.activeVersion = '11';
    } catch { /* proposed API unavailable */ }

    try { term.loadAddon(new ClipboardAddon()); } catch { /* optional */ }

    terminalRef.current = term;
    term.open(containerRef.current);

    try { term.loadAddon(new WebLinksAddon()); } catch { /* optional */ }

    // Renderer choice is a real trade-off, so it is the user's.
    //
    // WebGL is faster — it avoids building a span per styled run per row,
    // which matters when several agents stream at once. But it paints
    // cell backgrounds into a canvas that CSS cannot touch, so truecolour
    // TUI panels stay opaque no matter what. Full transparency therefore
    // requires the DOM renderer.
    let webgl: WebglAddon | null = null;
    if (transparencyRef.current === 'gpu') {
      try {
        webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          console.warn('[Terminal] WebGL context lost — falling back to DOM renderer');
          try { webgl?.dispose(); } catch { /* already gone */ }
          webgl = null;
        });
        term.loadAddon(webgl);
      } catch {
        webgl = null; // software rendering / remote desktop
      }
    }

    const safeFit = () => {
      if (!containerRef.current || !fitAddonRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 10) return;
      try { fitAddonRef.current.fit(); } catch { /* not laid out */ }
    };
    requestAnimationFrame(() => requestAnimationFrame(safeFit));

    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(safeFit, 80);
    });
    ro.observe(containerRef.current);

    // Track whether the user has scrolled up, so new output doesn't yank
    // them back down mid-read — a "jump to latest" affordance appears instead.
    const onScroll = () => {
      const buf = term.buffer.active;
      const bottom = buf.viewportY >= buf.baseY - 1;
      setAtBottom(bottom);
      if (bottom) setUnseenOutput(false);
    };
    term.onScroll(onScroll);

    // Wheel → page keys while a TUI holds the alternate buffer
    const wheelHandler = (e: WheelEvent) => {
      if (term.buffer.active.type !== 'alternate') return;
      e.preventDefault();
      e.stopPropagation();
      sendToPty(e.deltaY < 0 ? '\x1b[5~' : '\x1b[6~');
    };
    term.element?.addEventListener('wheel', wheelHandler, { capture: true, passive: false });

    // ── Restore scrollback ────────────────────────────────────
    // Written verbatim. The old path fetched 200 split lines and rejoined
    // them, which destroyed carriage returns and mangled the restore.
    (async () => {
      try {
        const raw = await readTerminal(sessionId);
        if (mounted && raw) {
          term.write(raw);
          term.scrollToBottom();
        }
      } catch { /* first mount */ }
    })();

    listen<string>(`term_out_${sessionId}`, (data) => {
      if (!mounted) return;
      term.write(data);
      const buf = term.buffer.active;
      if (buf.viewportY < buf.baseY - 1) setUnseenOutput(true);
    }).then((fn) => { unlistenTerm = fn; });

    term.onData(sendToPty);
    term.onResize(({ cols, rows }) => {
      invoke('resize_terminal', { sessionId, cols, rows }).catch(() => {});
    });

    setTimeout(() => term.focus(), 150);

    const el = containerRef.current;
    const handlePaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData('text/plain');
      if (text) { e.preventDefault(); sendToPty(text); }
    };
    el?.addEventListener('paste', handlePaste);

    return () => {
      mounted = false;
      if (unlistenTerm) unlistenTerm();
      ro.disconnect();
      if (resizeTimer) clearTimeout(resizeTimer);
      el?.removeEventListener('paste', handlePaste);
      if (term.element) term.element.removeEventListener('wheel', wheelHandler, { capture: true } as EventListenerOptions);
      try { webgl?.dispose(); } catch { /* already disposed */ }
      try { term.dispose(); } catch { /* context already lost */ }
      terminalRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
    };
    // theme/font are applied by the effects below, not by remounting —
    // a remount would drop scrollback and reset the shell's view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalReady, sessionId]);

  // ── Live re-theme ────────────────────────────────────────────
  useEffect(() => {
    const term = terminalRef.current;
    if (!term) return;
    const t = theme.terminal;
    term.options.theme = {
      background: 'rgba(0, 0, 0, 0)',
      foreground: t.fg || '#EAF4F4',
      cursor: t.cursor || '#F4A261',
      cursorAccent: t.bg || '#0E1A14',
      selectionBackground: t.selection || 'rgba(244,162,97,0.35)',
      black: withAlpha(t.black || '#050304', ANSI_BLACK_ALPHA), red: t.red || '#E62E43', green: t.green || '#7EC8A0',
      yellow: t.yellow || '#F4A261', blue: t.blue || '#6B9AC4', magenta: t.magenta || '#C89EC4',
      cyan: t.cyan || '#7EC8C8', white: t.white || '#C8D6D6',
      // Bright backgrounds (SGR 100-107) resolve to these. Translucent so
      // they tint rather than block even in 'gpu' mode.
      brightBlack: withAlpha(t.brightBlack || '#5A6A6A', 0.55), brightRed: t.brightRed || '#E76F51',
      brightGreen: t.brightGreen || '#A8E6CF', brightYellow: t.brightYellow || '#F4C27A',
      brightBlue: t.brightBlue || '#8BB8E0', brightMagenta: t.brightMagenta || '#D8B8D4',
      brightCyan: t.brightCyan || '#A8E0E0', brightWhite: t.brightWhite || '#F5E6ED',
    };
  }, [theme]);

  // ── Live font size / wrap ────────────────────────────────────
  useEffect(() => {
    const term = terminalRef.current;
    if (!term) return;
    term.options.fontSize = effectiveFontSize;
    requestAnimationFrame(() => {
      try { fitAddonRef.current?.fit(); } catch { /* not laid out */ }
    });
  }, [effectiveFontSize]);

  // ── Search ───────────────────────────────────────────────────
  const searchOpts = {
    decorations: {
      matchBackground: 'rgba(244,162,97,0.35)',
      matchBorder: 'rgba(244,162,97,0.9)',
      matchOverviewRuler: '#F4A261',
      activeMatchBackground: 'rgba(244,162,97,0.75)',
      activeMatchBorder: '#F4A261',
      activeMatchColorOverviewRuler: '#F4A261',
    },
  };

  const findNext = useCallback((q: string) => {
    if (!q) { searchAddonRef.current?.clearDecorations(); setMatchInfo(null); return; }
    searchAddonRef.current?.findNext(q, searchOpts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const findPrev = useCallback((q: string) => {
    if (!q) return;
    searchAddonRef.current?.findPrevious(q, searchOpts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { findNext(query); }, [query, findNext]);

  const closeSearch = useCallback(() => {
    setShowSearch(false);
    setQuery('');
    setMatchInfo(null);
    searchAddonRef.current?.clearDecorations();
    terminalRef.current?.focus();
  }, []);

  const doExport = useCallback(async (plain: boolean) => {
    const res = await transcriptExport(sessionId, plain);
    if (res.success) {
      const stats = await transcriptStats(sessionId).catch(() => null);
      const size = stats ? ` (${(stats.bytes / 1024).toFixed(0)} KB)` : '';
      setExportMsg(`Saved${size}`);
    } else if (!res.canceled) {
      setExportMsg(res.error || 'Export failed');
    }
    setTimeout(() => setExportMsg(null), 2600);
  }, [sessionId]);

  const fg = theme.terminal.fg || '#EAF4F4';
  const label = agentName ? `${agentName} terminal` : 'Agent terminal';

  const iconBtn: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: 24, height: 22, borderRadius: 5,
    border: `1px solid ${fg}18`, background: `${fg}0A`,
    color: fg, cursor: 'pointer', padding: 0,
  };

  return (
    <div
      style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', borderRadius: 'var(--radius-md)', position: 'relative' }}
      role="group"
      aria-label={label}
    >
      {/* ── Search bar ── */}
      {showSearch && (
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px',
            background: 'var(--surface-alt)', borderBottom: `1px solid ${fg}18`,
            fontSize: 11, fontFamily: "'JetBrains Mono', monospace",
          }}
          role="search"
        >
          <Search size={12} style={{ opacity: 0.6, flexShrink: 0 }} aria-hidden="true" />
          <input
            ref={searchInputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (e.shiftKey) findPrev(query); else findNext(query);
              }
              if (e.key === 'Escape') { closeSearch(); e.preventDefault(); }
            }}
            placeholder="Find in terminal…"
            aria-label="Find in terminal"
            style={{
              flex: 1, minWidth: 0, background: 'transparent', border: 'none',
              color: fg, fontSize: 11, fontFamily: 'inherit', outline: 'none',
            }}
          />
          <span style={{ opacity: 0.55, fontSize: 10, whiteSpace: 'nowrap' }} aria-live="polite">
            {query ? (matchInfo && matchInfo.total > 0 ? `${matchInfo.current}/${matchInfo.total}` : 'none') : ''}
          </span>
          <button onClick={() => findPrev(query)} title="Previous (Shift+Enter)" aria-label="Previous match" style={iconBtn}>
            <ArrowUp size={11} />
          </button>
          <button onClick={() => findNext(query)} title="Next (Enter)" aria-label="Next match" style={iconBtn}>
            <ArrowDown size={11} />
          </button>
          <button onClick={closeSearch} title="Close (Esc)" aria-label="Close search" style={iconBtn}>
            <X size={11} />
          </button>
        </div>
      )}

      {/* ── Toolbar ── */}
      {showToolbar && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px', fontSize: 11,
          fontFamily: "'JetBrains Mono', monospace", background: 'var(--surface-alt)',
          borderBottom: `1px solid ${fg}15`, flexWrap: 'wrap', userSelect: 'none',
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
          <button onClick={() => setFontScale((f) => Math.max(-6, f - 1))} title="Smaller text (Ctrl+-)" aria-label="Decrease font size" style={iconBtn}>
            <Type size={10} />
          </button>
          <span style={{ opacity: 0.5, fontSize: 9, minWidth: 20, textAlign: 'center' }}>{effectiveFontSize}</span>
          <button onClick={() => setFontScale((f) => Math.min(10, f + 1))} title="Larger text (Ctrl++)" aria-label="Increase font size" style={iconBtn}>
            <Type size={13} />
          </button>
          <button onClick={() => doExport(true)} title="Export full transcript as text" aria-label="Export transcript" style={iconBtn}>
            <Download size={11} />
          </button>
          <span style={{ opacity: 0.3, fontSize: 9 }}>Ctrl+O hide</span>
        </div>
      )}

      {/* Terminal surface.
          The scrim is what actually makes text readable on a transparent
          card: blur alone softens the backdrop but does not darken it, so
          light glyphs over a bright wallpaper stay low-contrast no matter
          how much blur is applied. Card transparency and terminal
          legibility are genuinely different needs, so this has its own
          control (Settings → Appearance → Terminal readability). */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <div
          aria-hidden="true"
          style={{
            position: 'absolute', inset: 0, pointerEvents: 'none',
            background: `rgba(6, 14, 11, ${terminalScrim})`,
          }}
        />
        <div
          ref={containerRef}
          className={terminalTransparency === 'full' ? 'orch-term-transparent' : undefined}
          style={{ position: 'absolute', inset: 0 }}
        />
      </div>

      {/* ── Jump to latest ── */}
      {!atBottom && (
        <button
          onClick={scrollToBottom}
          aria-label="Jump to latest output"
          style={{
            position: 'absolute', right: 14, bottom: 12, zIndex: 5,
            display: 'flex', alignItems: 'center', gap: 5,
            padding: '5px 10px', borderRadius: 999,
            border: `1px solid ${unseenOutput ? 'var(--accent)' : `${fg}25`}`,
            background: unseenOutput ? 'var(--accent)' : 'var(--surface-alt)',
            color: unseenOutput ? '#0E1A14' : fg,
            fontSize: 10, fontFamily: "'JetBrains Mono', monospace",
            cursor: 'pointer', boxShadow: '0 2px 10px rgba(0,0,0,0.35)',
          }}
        >
          <ChevronsDown size={11} />
          {unseenOutput ? 'New output' : 'Latest'}
        </button>
      )}

      {exportMsg && (
        <div
          role="status"
          style={{
            position: 'absolute', left: 12, bottom: 12, zIndex: 5,
            padding: '4px 10px', borderRadius: 6,
            background: 'var(--surface-alt)', border: `1px solid ${fg}22`,
            color: fg, fontSize: 10, fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          {exportMsg}
        </div>
      )}
    </div>
  );
};
