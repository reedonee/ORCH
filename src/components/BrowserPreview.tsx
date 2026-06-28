import React, { useState, useRef, useEffect } from 'react';
import { useBrowserStore, type BrowserTab } from '../stores/useBrowserStore';
import { useThemeStore } from '../stores/useThemeStore';
import { usePanelRegistry } from '../stores/usePanelRegistry';
import { usePanelDrag } from '../hooks/usePanelDrag';
import { computePanelZIndex } from '../lib/z-stack-manager';
import { browserGoBack, browserGoForward, browserRefresh } from '../lib/electron-api';
import { BrowserIcon } from './icons/CustomIcons';
import { X, ArrowLeft, ArrowRight, RotateCw, ExternalLink, Loader2, Plus } from 'lucide-react';

const MIN_W = 440;
const MIN_H = 240;
const HEADER_H = 36;
const NAV_H = 32;

function formatUrl(input: string): string {
  input = input.trim();
  if (!input) return '';
  if (input.startsWith('http://') || input.startsWith('https://')) return input;
  if (input.includes('.') && !input.includes(' ')) return `https://${input}`;
  return `https://www.google.com/search?q=${encodeURIComponent(input)}`;
}

function createWebviewInContainer(
  container: HTMLDivElement,
  tab: BrowserTab,
  updateTab: (id: string, updates: Partial<BrowserTab>) => void,
): () => void {
  container.style.position = 'relative';
  container.style.overflow = 'hidden';

  const wv = document.createElement('webview');
  wv.setAttribute('src', tab.url);
  wv.setAttribute('allowpopups', '');
  wv.setAttribute('partition', 'persist:orch-browser');
  wv.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;border:none;border-radius:0';

  // Track injected CSS keys so we can remove + re-inject on theme change
  let scrollCssKey: string | undefined;

  function injectScrollbarCss() {
    try {
      if (scrollCssKey !== undefined) {
        (wv as any).removeInsertedCSS(scrollCssKey);
      }
      const accent = useThemeStore.getState().theme.colors.accent;
      const r = parseInt(accent.slice(1, 3), 16);
      const g = parseInt(accent.slice(3, 5), 16);
      const b = parseInt(accent.slice(5, 7), 16);
      scrollCssKey = (wv as any).insertCSS(`
        ::-webkit-scrollbar { width: 8px; height: 8px; }
        ::-webkit-scrollbar-track { background: rgba(${r},${g},${b},0.10); border-radius: 4px; }
        ::-webkit-scrollbar-thumb { background: rgba(${r},${g},${b},0.30); border-radius: 4px; border: 1px solid rgba(${r},${g},${b},0.12); }
        ::-webkit-scrollbar-thumb:hover { background: rgba(${r},${g},${b},0.55); }
        ::-webkit-scrollbar-corner { background: transparent; }
      `);
    } catch {}
  }

  wv.addEventListener('did-navigate', ((e: any) => {
    updateTab(tab.id, { url: e.url, title: e.url, isLoading: false });
  }) as EventListener);
  wv.addEventListener('did-start-loading', (() => {
    updateTab(tab.id, { isLoading: true });
  }) as EventListener);
  wv.addEventListener('did-stop-loading', (() => {
    try {
      const title = (wv as any).getTitle?.() || (wv as any).getURL?.() || tab.url;
      updateTab(tab.id, { isLoading: false, title });
    } catch { updateTab(tab.id, { isLoading: false }); }
    injectScrollbarCss();
  }) as EventListener);
  wv.addEventListener('new-window', ((e: any) => {
    if (e.url) useBrowserStore.getState().openBrowser(e.url);
  }) as EventListener);

  container.appendChild(wv);
  (container as any).__webview = wv;
  (container as any).__injectScrollbarCss = injectScrollbarCss;
  return () => {
    try { container.removeChild(wv); } catch {}
  };
}

const TabContent: React.FC<{ tab: BrowserTab }> = ({ tab }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const updateTab = useBrowserStore((s) => s.updateTab);
  const brandColor = useThemeStore((s) => s.theme.colors.brand);
  const accent = useThemeStore((s) => s.theme.colors.accent);
  const mountedRef = useRef(false);

  useEffect(() => {
    if (!containerRef.current) return;
    return createWebviewInContainer(containerRef.current, tab, updateTab);
  }, [tab.id]);

  // Re-inject scrollbar CSS when accent color changes (theme switch)
  useEffect(() => {
    if (!mountedRef.current) return;
    const inject = (containerRef.current as any)?.__injectScrollbarCss;
    if (inject) inject();
  }, [accent]);

  // Navigate webview when store URL changes (local navigation via URL bar)
  useEffect(() => {
    if (!mountedRef.current) { mountedRef.current = true; return; }
    const wv = (containerRef.current as any)?.__webview;
    if (wv && tab.url) {
      try { wv.loadURL(tab.url); } catch {}
    }
  }, [tab.url]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { onBrowserNavigate, onBrowserGoBack, onBrowserGoForward, onBrowserRefresh: onRefresh } =
        await import('../lib/electron-api');
      if (cancelled) return;
      const unsubNav = onBrowserNavigate(tab.id, (url: string) => {
        const wv = (containerRef.current as any)?.__webview;
        if (wv) try { wv.loadURL(url); } catch {}
      });
      const unsubBack = onBrowserGoBack(tab.id, () => {
        const wv = (containerRef.current as any)?.__webview;
        if (wv) try { wv.goBack(); } catch {}
      });
      const unsubFwd = onBrowserGoForward(tab.id, () => {
        const wv = (containerRef.current as any)?.__webview;
        if (wv) try { wv.goForward(); } catch {}
      });
      const unsubRefresh = onRefresh(tab.id, () => {
        const wv = (containerRef.current as any)?.__webview;
        if (wv) try { wv.reload(); } catch {}
      });
      return () => { unsubNav(); unsubBack(); unsubFwd(); unsubRefresh(); };
    })();
    return () => { cancelled = true; };
  }, [tab.id]);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', position: 'relative', minHeight: 0, overflow: 'hidden' }}>
      {tab.isLoading && (
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, height: 2, zIndex: 10,
          background: `linear-gradient(90deg, ${brandColor} 0%, ${brandColor}88 50%, ${brandColor} 100%)`,
          backgroundSize: '200% 100%',
          animation: 'shimmer 1s ease infinite',
        }} />
      )}
      <div ref={containerRef} style={{ flex: 1 }} />
    </div>
  );
};

// ── Main BrowserPreview Panel ─────────────────────────────────
export const BrowserPreview: React.FC = () => {
  const store = useBrowserStore();
  const { tabs, activeTabId, visible, setVisible, openBrowser, closeBrowser, navigateTo, setActiveTab, setPosition, setSize } = store;
  const brandColor = useThemeStore((s) => s.theme.colors.brand);
  const c = useThemeStore((s) => s.theme.colors);
  const g = useThemeStore((s) => s.theme.glass);
  const [urlInput, setUrlInput] = useState('');

  // ── Unified drag/resize via panel registry ─────────────────
  const {
    dragHandlers,
    resizeHandlers,
    positionStyle,
    transition,
    isDragging,
    isResizing,
  } = usePanelDrag({
    panelId: 'browser',
    snapToGrid: 32,
  });

  // ── Z-index from central stack manager ─────────────────────
  const registry = usePanelRegistry();
  const zIndex = computePanelZIndex(
    'browser',
    'canvas',
    105,
    true,
    registry.activePanelId,
    registry.dragPanelId,
    registry.resizePanelId,
    registry.zStack,
  );

  // ── Register with the panel registry ───────────────────────
  useEffect(() => {
    registry.registerPanel({
      id: 'browser',
      type: 'browser',
      space: 'canvas',
      x: store.x, y: store.y, width: store.width, height: store.height,
      minWidth: MIN_W,
      minHeight: MIN_H,
      defaultWidth: 920,
      defaultHeight: 540,
      participatesInAutoLayout: true,
      participatesInFraming: true,
      participatesInCollision: true,
      draggable: true,
      resizable: true,
      focusable: true,
      baseZIndex: 105,
      persistent: false,
    });
    return () => { registry.unregisterPanel('browser'); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync registry → browser store after hook commits position/size
  const panel = usePanelRegistry((s) => s.panels['browser']);
  const lastSyncRef = useRef({ x: 0, y: 0, w: 0, h: 0 });
  useEffect(() => {
    if (!panel) return;
    const ls = lastSyncRef.current;
    // Only push to browser store if values actually changed (breaks circular sync)
    if (panel.x !== ls.x || panel.y !== ls.y) {
      setPosition(panel.x, panel.y);
    }
    if (panel.width !== ls.w || panel.height !== ls.h) {
      setSize(panel.width, panel.height);
    }
    lastSyncRef.current = { x: panel.x, y: panel.y, w: panel.width, h: panel.height };
  }, [panel?.x, panel?.y, panel?.width, panel?.height, setPosition, setSize]);

  // ── URL update ──────────────────────────────────────────────
  useEffect(() => {
    const active = tabs.find((t) => t.id === activeTabId);
    if (active) setUrlInput(active.url);
  }, [activeTabId, tabs]);

  const handleNavigate = () => {
    if (!urlInput.trim() || !activeTabId) return;
    navigateTo(activeTabId, formatUrl(urlInput));
  };

  const activeTab = tabs.find((t) => t.id === activeTabId);
  if (!visible) return null;

  return (
    <div
      className="animate-scale-in"
      style={{
        position: 'absolute',
        left: positionStyle.left as number,
        top: positionStyle.top as number,
        width: positionStyle.width as number,
        height: positionStyle.height as number,
        zIndex,
        borderRadius: 'var(--radius-lg)',
        overflow: 'hidden',
        display: 'flex', flexDirection: 'column',
        background: c.bgAlt,
        border: `1px solid ${c.border}`,
        cursor: isDragging ? 'grabbing' : isResizing ? 'nwse-resize' : 'default',
        transition,
      }}
    >
      {/* ── Header (draggable) ──────────────────────────────────── */}
      <div
        onMouseDown={(e) => {
          e.stopPropagation();
          registry.focusPanel('browser');
          dragHandlers.onMouseDown(e);
        }}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, height: HEADER_H,
          padding: '0 8px', background: c.surfaceAlt,
          borderBottom: `1px solid ${c.borderDim}`,
          cursor: 'grab', userSelect: 'none', flexShrink: 0,
        }}
      >
        <BrowserIcon size={12} style={{ color: brandColor, flexShrink: 0 }} />
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--font-heading)' }}>
          Browser {activeTab ? `· ${activeTab.title.slice(0, 40)}` : ''}
        </span>
        <span className="no-drag" onClick={() => setVisible(false)}
          style={{ width: 20, height: 20, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'var(--text-muted)', flexShrink: 0 }}>
          <X size={12} />
        </span>
      </div>

      {/* ── Tab bar ─────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '4px 8px', background: c.surface, borderBottom: `1px solid ${c.borderDim}`, flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: 2, flex: 1, overflow: 'hidden' }}>
          {tabs.map((tab) => (
            <div key={tab.id} onClick={() => setActiveTab(tab.id)}
              className="no-drag"
              style={{
                display: 'flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 'var(--radius-sm)',
                background: tab.id === activeTabId ? c.surfaceAlt : 'transparent',
                border: tab.id === activeTabId ? `1px solid ${c.border}` : '1px solid transparent',
                cursor: 'pointer', maxWidth: 120, fontSize: 10, color: tab.id === activeTabId ? brandColor : 'var(--text-secondary)',
                flexShrink: 0, transition: 'all var(--anim-fast)',
              }}>
              {tab.isLoading
                ? <Loader2 size={9} style={{ animation: 'spin 0.8s linear infinite', flexShrink: 0 }} />
                : <BrowserIcon size={9} style={{ flexShrink: 0 }} />}
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 60, fontFamily: 'var(--font-accent)' }}>{tab.title.slice(0, 15)}</span>
              {tabs.length > 1 && (
                <span onClick={(e) => { e.stopPropagation(); closeBrowser(tab.id); }}
                  style={{ opacity: 0.4, cursor: 'pointer', display: 'flex', flexShrink: 0 }}>
                  <X size={9} />
                </span>
              )}
            </div>
          ))}
          <div onClick={() => openBrowser()} className="no-drag" style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 20, height: 20, borderRadius: 'var(--radius-sm)', cursor: 'pointer', color: 'var(--text-muted)', flexShrink: 0,
          }}><Plus size={10} /></div>
        </div>
      </div>

      {/* ── Navigation bar ──────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, height: NAV_H, padding: '0 8px', background: c.surface, flexShrink: 0 }}>
        <button className="no-drag" onClick={() => activeTabId && browserGoBack(activeTabId)}
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: 2, display: 'flex', fontFamily: 'inherit' }}>
          <ArrowLeft size={12} />
        </button>
        <button className="no-drag" onClick={() => activeTabId && browserGoForward(activeTabId)}
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: 2, display: 'flex', fontFamily: 'inherit' }}>
          <ArrowRight size={12} />
        </button>
        <button className="no-drag" onClick={() => activeTabId && browserRefresh(activeTabId)}
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: 2, display: 'flex', fontFamily: 'inherit' }}>
          <RotateCw size={11} />
        </button>
        <div style={{ flex: 1, position: 'relative' }}>
          <input value={urlInput} onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleNavigate(); }}
            placeholder="URL or search…"
            className="no-drag"
            style={{
              width: '100%', padding: '3px 22px 3px 8px', borderRadius: 9999,
              background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)',
              color: 'var(--text)', fontSize: 11, fontFamily: "'JetBrains Mono', monospace", outline: 'none',
            }}
          />
          <span className="no-drag" onClick={handleNavigate}
            style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', color: brandColor, cursor: 'pointer', display: 'flex', opacity: 0.7 }}>
            <ExternalLink size={10} />
          </span>
        </div>
      </div>

      {/* ── Web content ─────────────────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', position: 'relative', overflow: 'hidden' }}>
        {activeTab ? <TabContent key={activeTab.id} tab={activeTab} /> : (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)', fontSize: 12, flexDirection: 'column', gap: 8 }}>
            <BrowserIcon size={24} style={{ opacity: 0.3 }} />
            <span>Open a browser tab</span>
          </div>
        )}
      </div>

      {/* ── Resize handle ───────────────────────────────────────── */}
      <div className="no-drag" onMouseDown={(e) => {
        e.stopPropagation();
        resizeHandlers.onMouseDown(e);
      }}
        style={{
          position: 'absolute', bottom: 0, right: 0, width: 20, height: 20,
          cursor: 'nwse-resize', zIndex: 10, display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end', padding: 2, pointerEvents: 'auto',
        }}>
        <svg width="10" height="10" viewBox="0 0 10 10" style={{ opacity: 0.35 }}>
          <line x1="8" y1="10" x2="10" y2="10" stroke="var(--text-muted)" strokeWidth="1.5" strokeLinecap="round" />
          <line x1="10" y1="8" x2="10" y2="10" stroke="var(--text-muted)" strokeWidth="1.5" strokeLinecap="round" />
          <line x1="4" y1="10" x2="10" y2="10" stroke="var(--text-muted)" strokeWidth="1.5" strokeLinecap="round" opacity="0.5" />
          <line x1="10" y1="4" x2="10" y2="10" stroke="var(--text-muted)" strokeWidth="1.5" strokeLinecap="round" opacity="0.5" />
        </svg>
      </div>
    </div>
  );
};
