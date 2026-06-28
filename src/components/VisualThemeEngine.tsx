import React, { useState, useMemo } from 'react';
import { useThemeStore } from '../stores/useThemeStore';
import { themes, type ThemeName, type ThemeTokens } from '../styles/theme';

// ── Theme helpers ──────────────────────────────────────────────────

const THEME_ENTRIES: { id: ThemeName; label: string }[] = [
  { id: 'eden',    label: 'Biophilic Overgrown' },
  { id: 'twilight', label: 'Copenhagen Light' },
  { id: 'crimson', label: 'Opencode Zen' },
];

/** Extract alpha channel from an rgba/hex color. For hex, treat as opaque. */
function extractAlpha(theme: ThemeTokens): string {
  const val = theme.glass?.bg || 'rgba(0,0,0,0)';
  const m = val.match(/[\d.]+\)?$/);
  if (m) return parseFloat(m[0].replace(')', '')).toFixed(2);
  return '1.00';
}

/** Build 4-color telemetry swatch array: Background, Text, Selection, Brand Accent */
function getSwatchColors(t: ThemeTokens): string[] {
  // For selection: use terminal.selection if available, else accent at 30%
  const sel = t.terminal?.selection || `${t.colors.accent}40`;
  return [t.colors.bg, t.colors.text, sel, t.colors.accent];
}

/** Resolve a color to a solid hex approximation for the swatch */
function resolveColor(raw: string): string {
  if (raw.startsWith('#')) return raw;
  if (raw.startsWith('rgba') || raw.startsWith('rgb')) return raw;
  return raw;
}

// ── Telemetry Palette Swatch ──────────────────────────────────────

const TelemetrySwatch: React.FC<{ colors: string[]; label: string }> = ({ colors, label }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
    <div style={{
      display: 'flex', borderRadius: 8, overflow: 'hidden',
      height: 22, width: '100%',
      border: '1px solid rgba(255,255,255,0.06)',
    }}>
      {colors.map((c, i) => (
        <div
          key={i}
          title={label ? `${label} ${['Bg', 'Text', 'Sel', 'Brand'][i]}: ${c}` : c}
          style={{
            flex: 1, background: resolveColor(c),
            transition: 'background var(--anim-normal)',
          }}
        />
      ))}
    </div>
    <div style={{
      display: 'flex', justifyContent: 'space-between',
      fontSize: 8, fontWeight: 600, letterSpacing: 0.8,
      color: 'var(--text-muted)', textTransform: 'uppercase',
      padding: '0 2px',
    }}>
      <span>BG</span>
      <span>TEXT</span>
      <span>SEL</span>
      <span>BRAND</span>
    </div>
  </div>
);

// ── Alpha Opacity Badge ───────────────────────────────────────────

const AlphaBadge: React.FC<{ value: string }> = ({ value }) => (
  <div style={{
    display: 'inline-flex', alignItems: 'center', gap: 3,
    padding: '2px 8px', borderRadius: 20,
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.06)',
    fontSize: 9, fontWeight: 700, letterSpacing: 0.5,
    color: 'var(--text-muted)', fontFamily: 'var(--font-mono)',
    lineHeight: 1.5,
  }}>
    <span style={{ opacity: 0.6 }}>α</span>
    <span>{value}</span>
  </div>
);

// ── Theme Matrix Card ─────────────────────────────────────────────

const ThemeCard: React.FC<{
  theme: ThemeTokens;
  isActive: boolean;
  isHovered: boolean;
  onHover: () => void;
  onLeave: () => void;
  onSelect: () => void;
}> = ({ theme, isActive, isHovered, onHover, onLeave, onSelect }) => {
  const swatchColors = getSwatchColors(theme);
  const alpha = extractAlpha(theme);

  return (
    <button
      onClick={onSelect}
      onMouseEnter={onHover}
      onMouseLeave={onLeave}
      style={{
        display: 'flex', flexDirection: 'column', gap: 14,
        padding: 20, borderRadius: 'var(--radius-lg)',
        background: isHovered
          ? `linear-gradient(135deg, ${theme.colors.bg} 0%, ${theme.colors.bgAlt} 100%)`
          : 'var(--glass-bg)',
        border: isActive
          ? `1.5px solid ${theme.colors.accent}`
          : isHovered
            ? `1px solid ${theme.colors.accent}40`
            : '1px solid var(--glass-border)',
        cursor: 'pointer', textAlign: 'left',
        fontFamily: 'inherit',
        boxShadow: isActive
          ? `0 0 24px ${theme.colors.accent}25, inset 0 0 1px ${theme.colors.accent}15`
          : isHovered
            ? `0 0 16px ${theme.colors.accent}15`
            : 'none',
        transform: isHovered ? 'translateY(-2px)' : 'translateY(0)',
        transition: 'all 0.35s cubic-bezier(0.34, 1.56, 0.64, 1)',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* ambient glow on hover */}
      {isHovered && (
        <div style={{
          position: 'absolute', inset: 0,
          background: `radial-gradient(ellipse at 50% 0%, ${theme.colors.accent}10 0%, transparent 60%)`,
          pointerEvents: 'none',
        }} />
      )}

      {/* theme name */}
      <div style={{
        fontSize: 10, fontWeight: 800, letterSpacing: 1.6,
        textTransform: 'uppercase', color: isActive ? '#F4A261' : 'var(--text)',
        transition: 'color 0.3s ease',
        position: 'relative', zIndex: 1,
      }}>
        {theme.label}
      </div>

      {/* telemetry palette swatch */}
      <div style={{ position: 'relative', zIndex: 1 }}>
        <TelemetrySwatch colors={swatchColors} label={theme.label} />
      </div>

      {/* metadata row */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        position: 'relative', zIndex: 1,
      }}>
        <AlphaBadge value={`α: ${alpha}`} />
        {isActive && (
          <span style={{
            fontSize: 8, fontWeight: 700, letterSpacing: 1,
            textTransform: 'uppercase', color: theme.colors.accent,
          }}>
            Active
          </span>
        )}
      </div>
    </button>
  );
};

// ── Canvas Mini-Preview ──────────────────────────────────────────

const CanvasMiniPreview: React.FC<{
  theme: ThemeTokens;
  themeName: ThemeName;
  isTransitioning: boolean;
}> = ({ theme, isTransitioning }) => {
  const c = theme.colors;

  return (
    <div style={{
      position: 'relative',
      width: '100%', height: '100%',
      borderRadius: 'var(--radius-lg)',
      overflow: 'hidden',
      background: c.bg,
      border: '1px solid var(--glass-border)',
      transition: 'background 0.5s ease, border-color 0.5s ease',
    }}>
      {/* animated ambient background loop */}
      <div style={{
        position: 'absolute', inset: 0, opacity: 0.35,
        background: `
          radial-gradient(ellipse 80% 60% at 20% 30%, ${c.accent}20 0%, transparent 60%),
          radial-gradient(ellipse 60% 40% at 80% 70%, ${c.accentDim}15 0%, transparent 50%),
          radial-gradient(ellipse 40% 50% at 50% 20%, ${c.brand}10 0%, transparent 40%)
        `,
        animation: isTransitioning ? 'none' : 'ambientDrift 12s ease-in-out infinite alternate',
        transition: 'background 0.5s ease',
      }} />

      {/* content container */}
      <div style={{
        position: 'relative', zIndex: 1,
        display: 'flex', flexDirection: 'column',
        height: '100%', padding: 16, gap: 12,
      }}>
        {/* mock title bar */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '6px 10px', borderRadius: 'var(--radius-md)',
          background: c.surface,
          border: `1px solid ${c.border}`,
          transition: 'background 0.4s ease, border-color 0.4s ease',
        }}>
          {/* traffic lights */}
          <div style={{ display: 'flex', gap: 4 }}>
            {['#FF5F57', '#FFBD2E', '#28C840'].map((col) => (
              <div key={col} style={{
                width: 6, height: 6, borderRadius: '50%',
                background: col, opacity: 0.7,
              }} />
            ))}
          </div>
          <div style={{
            flex: 1, height: 6, borderRadius: 3,
            background: c.border, opacity: 0.5,
          }} />
          <div style={{
            width: 12, height: 12, borderRadius: 4,
            background: c.accent, opacity: 0.8,
          }} />
        </div>

        {/* editor area */}
        <div style={{
          display: 'flex', gap: 8, flex: 1,
        }}>
          {/* sidebar mock */}
          <div style={{
            width: 28, borderRadius: 'var(--radius-sm)',
            background: c.surface,
            border: `1px solid ${c.borderDim}`,
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', padding: 6, gap: 4,
            transition: 'background 0.4s ease',
          }}>
            {[0, 1, 2].map((i) => (
              <div key={i} style={{
                width: 14, height: 14, borderRadius: 4,
                background: i === 1 ? c.accent : c.border,
                opacity: i === 1 ? 0.8 : 0.3,
                transition: 'background 0.4s ease',
              }} />
            ))}
          </div>

          {/* main content */}
          <div style={{
            flex: 1, display: 'flex', flexDirection: 'column',
            gap: 6,
          }}>
            {/* text lines */}
            {[70, 45, 85, 30, 60, 50].map((w, i) => (
              <div key={i} style={{
                height: i === 2 ? 14 : 6,
                width: `${w}%`,
                borderRadius: 3,
                background: i === 2 ? c.accent + '20' : c.borderDim,
                border: i === 2 ? `1px solid ${c.accent}30` : 'none',
                transition: 'background 0.4s ease, border-color 0.4s ease',
              }} />
            ))}

            {/* agent status badges row */}
            <div style={{
              display: 'flex', gap: 4, marginTop: 4,
              flexWrap: 'wrap',
            }}>
              {[
                { label: 'Hermes', color: c.accent },
                { label: 'Claude', color: c.brand },
                { label: 'Codex', color: c.info },
              ].map((agent, i) => (
                <div key={i} style={{
                  display: 'flex', alignItems: 'center', gap: 3,
                  padding: '2px 6px', borderRadius: 10,
                  background: `${agent.color}18`,
                  border: `1px solid ${agent.color}30`,
                  fontSize: 6, fontWeight: 700,
                  color: c.text,
                  letterSpacing: 0.3,
                  transition: 'all 0.4s ease',
                }}>
                  <div style={{
                    width: 4, height: 4, borderRadius: '50%',
                    background: c.success,
                    animation: !isTransitioning ? 'pulseGlow 2s ease-in-out infinite' : 'none',
                  }} />
                  {agent.label}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* bottom terminal bar */}
        <div style={{
          padding: '4px 10px', borderRadius: 'var(--radius-sm)',
          background: c.surfaceAlt,
          border: `1px solid ${c.borderDim}`,
          display: 'flex', alignItems: 'center', gap: 6,
          fontFamily: 'var(--font-mono)',
          fontSize: 6, color: c.textMuted,
          transition: 'all 0.4s ease',
        }}>
          <span style={{ color: c.success }}>●</span>
          <span style={{ flex: 1, opacity: 0.5 }}>~/workspace/orch</span>
          <span style={{ color: c.accent, opacity: 0.7 }}>▌</span>
        </div>
      </div>
    </div>
  );
};

// ── Ambient keyframes injection ──────────────────────────────────

const ambientKeyframes = `
@keyframes ambientDrift {
  0%   { transform: scale(1) rotate(0deg); opacity: 0.3; }
  50%  { transform: scale(1.08) rotate(1.5deg); opacity: 0.45; }
  100% { transform: scale(1) rotate(0deg); opacity: 0.3; }
}
@keyframes pulseGlow {
  0%, 100% { box-shadow: 0 0 2px currentColor; opacity: 0.7; }
  50%      { box-shadow: 0 0 6px currentColor; opacity: 1; }
}
`;

// ── The Theme Visual Engine ───────────────────────────────────────

export const VisualThemeEngine: React.FC = () => {
  const { theme: activeTheme, themeName, setTheme } = useThemeStore();
  const [hoveredId, setHoveredId] = useState<ThemeName | null>(null);
  const [isTransitioning, setIsTransitioning] = useState(false);

  // The preview uses the hovered theme, or the active theme if nothing is hovered
  const previewTheme = hoveredId ? themes[hoveredId] : activeTheme;
  const previewName = hoveredId || themeName;

  const handleSelect = (id: ThemeName) => {
    if (id === themeName) return;
    setIsTransitioning(true);
    setTheme(id);
    // The CSS variable transition runs in-app via App.tsx
    setTimeout(() => setIsTransitioning(false), 600);
  };

  const themeEntries = useMemo(() =>
    THEME_ENTRIES.map((entry) => ({
      ...entry,
      theme: themes[entry.id],
    })),
  []);

  return (
    <>
      {/* inject ambient animations once */}
      <style>{ambientKeyframes}</style>

      <div style={{
        display: 'flex', gap: 24, height: '100%', minHeight: 380,
      }}>
        {/* ── Left: Theme Matrix Grid ─────────────────────────── */}
        <div style={{
          flex: '0 0 280px',
          display: 'flex', flexDirection: 'column', gap: 10,
          overflow: 'auto',
          paddingRight: 4,
        }}>
          <div style={{
            fontSize: 9, fontWeight: 700, letterSpacing: 1.6,
            textTransform: 'uppercase', color: 'var(--text-muted)',
            padding: '0 2px 4px',
          }}>
            Theme Matrix
          </div>
          {themeEntries.map(({ id, label, theme }) => (
            <ThemeCard
              key={id}
              theme={theme}
              isActive={themeName === id}
              isHovered={hoveredId === id}
              onHover={() => setHoveredId(id)}
              onLeave={() => setHoveredId(null)}
              onSelect={() => handleSelect(id)}
            />
          ))}
        </div>

        {/* ── Right: High-Fidelity Canvas Preview ────────────── */}
        <div style={{
          flex: 1,
          display: 'flex', flexDirection: 'column', gap: 10,
        }}>
          <div style={{
            fontSize: 9, fontWeight: 700, letterSpacing: 1.6,
            textTransform: 'uppercase', color: 'var(--text-muted)',
            padding: '0 2px 4px',
          }}>
            Live Preview
          </div>
          <div style={{
            flex: 1,
            borderRadius: 'var(--radius-lg)',
            overflow: 'hidden',
            minHeight: 240,
          }}>
            <CanvasMiniPreview
              theme={previewTheme}
              themeName={previewName}
              isTransitioning={isTransitioning}
            />
          </div>

          {/* preview metadata */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 12,
            padding: '8px 12px', borderRadius: 'var(--radius-md)',
            background: 'var(--glass-bg)',
            border: '1px solid var(--glass-border)',
            fontSize: 10, color: 'var(--text-secondary)',
          }}>
            <span style={{ fontWeight: 700, color: 'var(--text)' }}>
              {previewTheme.label}
            </span>
            <span style={{ color: 'var(--text-muted)' }}>·</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9 }}>
              bg: {previewTheme.colors.bg}
            </span>
            <span style={{ color: 'var(--text-muted)' }}>·</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: previewTheme.colors.accent }}>
              accent: {previewTheme.colors.accent}
            </span>
            <span style={{ color: 'var(--text-muted)' }}>·</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: previewTheme.colors.brand }}>
              brand: {previewTheme.colors.brand}
            </span>
          </div>
        </div>
      </div>
    </>
  );
};
