// ── ORCH Command Palette ────────────────────────────────────────
// A slide-down search bar triggered via Ctrl+F.
// Glass-blur aesthetic with amber (#F4A261) highlight on matched text.
// Keyboard navigable: ↑↓ arrows, Enter to execute, Escape to dismiss.
// Clicking the backdrop (or pressing Escape) closes the palette.

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  Palette, Crosshair, LayoutGrid, Database,
  Terminal, Search, Music, PanelRightClose, Bug, Hammer,
} from 'lucide-react';
import { searchRegistry, type SearchAction } from '../lib/search-registry';
import { PROVIDER_ICONS } from './icons/ProviderIcon';
import { BrowserIcon } from './icons/CustomIcons';

/** Pick a branded icon for an action based on its id. */
function pickIcon(action: SearchAction): React.ReactNode {
  const size = 20;
  const props = { size, style: { color: 'var(--brand)', flexShrink: 0 } as React.CSSProperties };

  // Provider icons — use the real brand SVG, tinted to brand color
  if (action.id.startsWith('spawn-')) {
    const providerId = action.id.replace('spawn-', '');
    const ProviderSvg = PROVIDER_ICONS[providerId];
    if (ProviderSvg) return <span style={{ color: 'var(--brand)', display: 'flex' }}><ProviderSvg size={size} /></span>;
    return <Terminal {...props} />;
  }

  if (action.id.startsWith('theme-')) return <Palette {...props} />;
  if (action.id.startsWith('focus-')) return <Crosshair {...props} />;
  if (action.id.startsWith('toggle-browser')) return <BrowserIcon size={size} style={{ color: 'var(--brand)' }} />;
  if (action.id.startsWith('toggle-music')) return <Music {...props} />;
  if (action.id.startsWith('toggle-forge')) return <Hammer {...props} />;
  if (action.id.startsWith('toggle-feedback')) return <Bug {...props} />;
  if (action.id.startsWith('toggle-')) return <PanelRightClose {...props} />;
  if (action.id.startsWith('arrange-')) return <LayoutGrid {...props} />;
  if (action.id.startsWith('data-')) return <Database {...props} />;
  if (action.category === 'action') return <PanelRightClose {...props} />;
  return <Search {...props} />;
}

/** Strip prefixes like "Theme: ", "Spawn: ", "Toggle: ", "Toggle " from action titles. */
function cleanTitle(action: SearchAction): string {
  return action.title
    .replace(/^(Theme|Spawn|Focus|Toggle|Arrange)\s*:\s*/i, '')
    .replace(/^Toggle\s+/i, '')
    .replace(/^Data:\s*/i, '');
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

// ── Highlighted text component ──────────────────────────────────

/** Wraps matching substrings in <mark> with brand accent color. */
const HighlightedText: React.FC<{ text: string; query: string }> = ({ text, query }) => {
  if (!query.trim()) return <>{text}</>;

  const lower = query.toLowerCase().trim();
  const terms = lower.split(/\s+/).filter(Boolean);

  // Build a regex that matches any term, case-insensitive
  const pattern = terms
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const re = new RegExp(`(${pattern})`, 'gi');
  const parts = text.split(re);

  return (
    <>
      {parts.map((part, i) =>
        re.test(part) ? (
          <mark key={i} style={{
            background: 'color-mix(in srgb, var(--brand) 25%, transparent)',
            color: 'var(--brand)',
            borderRadius: 2,
            padding: '0 1px',
            fontWeight: 700,
          }}>
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
};

// ── Component ────────────────────────────────────────────────────

const CommandPalette: React.FC<CommandPaletteProps> = ({ open, onClose }) => {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Refresh registry on each open to pick up new agents/providers
  useEffect(() => {
    if (open) {
      searchRegistry.refresh();
      setQuery('');
      setSelectedIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Search results
  const results = useMemo(() => {
    if (!open) return [];
    return searchRegistry.search(query);
  }, [query, open]);

  // Reset selection when results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [results.length]);

  // Keyboard navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => Math.min(prev + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (results[selectedIndex]) {
        searchRegistry.execute(results[selectedIndex].id);
        onClose();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }, [results, selectedIndex, onClose]);

  const handleClick = useCallback((id: string) => {
    searchRegistry.execute(id);
    onClose();
  }, [onClose]);

  // ── Render ──────────────────────────────────────────────────────

  return (
    <div style={{ position: 'relative' }}>
      {open && (
        <div
          onClick={onClose}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 949,
            background: 'rgba(0,0,0,0.3)',
          }}
        />
      )}
      <div
        style={{
          position: 'fixed',
          top: '30%',
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 950,
          width: 340,
          maxWidth: '90vw',
          opacity: open ? 1 : 0,
          pointerEvents: open ? 'auto' : 'none',
          transition: 'opacity 140ms ease, transform 140ms ease',
          transformOrigin: 'top center',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 14px',
            borderRadius: 'var(--radius-lg) var(--radius-lg) 0 0',
            background: '#222524',
            border: '1px solid rgba(234, 244, 244, 0.06)',
            borderBottom: '1px solid rgba(234, 244, 244, 0.04)',
            backdropFilter: 'blur(16px)',
            WebkitBackdropFilter: 'blur(16px)',
            boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
          }}
        >
          <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--text-muted)', flexShrink: 0 }}>
            <circle cx={11} cy={11} r={8} />
            <path d="m21 21-4.35-4.35" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search actions, agents, themes..."
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: 'var(--text)',
              fontSize: 13,
              fontFamily: 'var(--font-mono)',
              lineHeight: '20px',
            }}
          />
          <span style={{ fontSize: 9, color: 'var(--text-muted)', fontFamily: 'var(--font-ui)', whiteSpace: 'nowrap' }}>
            {results.length} results
          </span>
        </div>

        {results.length > 0 && (
          <div
            style={{
              maxHeight: 320,
              overflowY: 'auto',
              borderRadius: '0 0 var(--radius-lg) var(--radius-lg)',
              background: '#222524',
              border: '1px solid rgba(234, 244, 244, 0.06)',
              borderTop: 'none',
            }}
          >
            {results.map((action, i) => {
              const isSelected = i === selectedIndex;
              return (
                <div
                  key={action.id}
                  onClick={() => handleClick(action.id)}
                  onMouseEnter={() => setSelectedIndex(i)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 14,
                    padding: '12px 14px',
                    cursor: 'pointer',
                    background: isSelected ? 'rgba(244, 162, 97, 0.08)' : 'transparent',
                    transition: 'background 70ms ease',
                    borderBottom: i < results.length - 1 ? '1px solid var(--border-dim)' : 'none',
                  }}
                >
                  {pickIcon(action)}
                  <div style={{
                    fontSize: 16,
                    fontWeight: 700,
                    color: 'var(--text)',
                    lineHeight: '22px',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>
                    <HighlightedText text={cleanTitle(action)} query={query} />
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {open && results.length === 0 && query.trim() && (
          <div
            style={{
              padding: '20px 14px',
              textAlign: 'center',
              borderRadius: '0 0 var(--radius-lg) var(--radius-lg)',
              background: '#222524',
              border: '1px solid rgba(234, 244, 244, 0.06)',
              borderTop: 'none',
              fontSize: 11,
              color: 'var(--text-muted)',
            }}
          >
            No results for &ldquo;{query}&rdquo;
          </div>
        )}
      </div>
    </div>
  );
};

export default CommandPalette;
