import React, { useState, useEffect, useRef } from 'react';
import { GlassPanel } from './GlassPanel';
import { useSettingsStore } from '../stores/useSettingsStore';
import { useProviderStore } from '../stores/useProviderStore';
import { useThemeStore } from '../stores/useThemeStore';
import { useWorkspaceStore, LAYOUT_ENGINE_SPEC } from '../stores/useWorkspaceStore';
import { useAuthStore } from '../stores/useAuthStore';
import { X, Radio, Palette, Layout, Keyboard, Bot, Key, Plug, Mic, Grid3X3, Target, Theater, User } from 'lucide-react';
import { getMcpUrl, installProvider, onInstallProgress } from '../lib/electron-api';
import { PROVIDER_ICONS } from './icons/ProviderIcon';
import type { ProviderStatus } from '../types/provider';
import type { AgentProvider } from '../types/settings';
import type { ThemeTokens } from '../styles/theme';

interface SettingsDialogProps {
  onClose: () => void;
}

type Section = 'style' | 'canvas' | 'shortcuts' | 'agents' | 'apis' | 'mcp' | 'audio' | 'account';

// const SOURCE_LABEL: Record<string, string> = {
//   'embedded-sidecar': 'embedded',
//   'embedded-resource': 'embedded',
//   'system-fallback': 'system',
// };

// ── small UI atoms ────────────────────────────────────────────────────────────

const SectionHeader: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div
    style={{
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: 1.4,
      textTransform: 'uppercase',
      color: 'var(--text-muted)',
      marginBottom: 10,
    }}
  >
    {children}
  </div>
);

const Pill: React.FC<{
  children: React.ReactNode;
  tone?: 'amber' | 'cyan' | 'muted' | 'dim';
}> = ({ children, tone = 'dim' }) => {
  const bg =
    tone === 'amber' ? 'var(--accent)' :
    tone === 'cyan' ? 'var(--info)' :
    tone === 'muted' ? 'var(--border)' :
    'transparent';
  const color =
    tone === 'amber' || tone === 'cyan' ? '#0E1A14' :
    tone === 'muted' ? 'var(--text-secondary)' :
    'var(--text-muted)';
  const border = tone === 'dim' ? '1px solid var(--border)' : '1px solid transparent';
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 10px',
        borderRadius: 'var(--radius-pill)',
        background: bg,
        color,
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: 0.6,
        textTransform: 'uppercase',
        border,
        lineHeight: 1.5,
      }}
    >
      {children}
    </span>
  );
};

const Toggle: React.FC<{ checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }> = ({
  checked,
  onChange,
  disabled,
}) => (
  <button
    role="switch"
    aria-checked={checked}
    onClick={() => !disabled && onChange(!checked)}
    disabled={disabled}
    style={{
      width: 36,
      height: 20,
      borderRadius: 'var(--radius-pill)',
      background: checked ? 'var(--accent)' : 'rgba(234,244,244,0.12)',
      border: '1px solid var(--border)',
      position: 'relative',
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.4 : 1,
      transition: 'background var(--anim-fast)',
      padding: 0,
    }}
  >
    <span
      style={{
        position: 'absolute',
        top: 2,
        left: checked ? 18 : 2,
        width: 14,
        height: 14,
        borderRadius: '50%',
        background: checked ? '#0E1A14' : 'var(--text-secondary)',
        transition: 'left var(--anim-fast)',
      }}
    />
  </button>
);

const HelpText: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div
    style={{
      fontSize: 12,
      color: 'var(--text-muted)',
      lineHeight: 1.6,
      marginTop: 8,
    }}
  >
    {children}
  </div>
);

// ── section content components ────────────────────────────────────────────────

// ── theme palette metadata (names + descriptions for preview) ──
const PALETTE_META: Record<string, Array<{ key: keyof ThemeTokens['colors']; name: string; note: string }>> = {
  base: [
    { key: 'bg', name: 'Canvas', note: 'Primary background' },
    { key: 'bgAlt', name: 'Surface Lift', note: 'Sidebar / elevated panels' },
    { key: 'text', name: 'Primary Text', note: 'Body copy, headings' },
    { key: 'textSecondary', name: 'Secondary Text', note: 'Labels, descriptions' },
    { key: 'textMuted', name: 'Muted Text', note: 'Disabled, placeholders' },
  ],
  accent: [
    { key: 'accent', name: 'Primary Accent', note: 'CTAs, active borders, focus' },
    { key: 'accentDim', name: 'Accent Dim', note: 'Hover states' },
    { key: 'brand', name: 'Brand', note: 'Logo, pillbar actions' },
    { key: 'menuBg', name: 'Menu BG', note: 'Dropdowns, tooltips' },
  ],
  semantic: [
    { key: 'error', name: 'Error', note: 'Danger, failures' },
    { key: 'warning', name: 'Warning', note: 'Caution, attention' },
    { key: 'success', name: 'Success', note: 'Completion, online' },
    { key: 'info', name: 'Info', note: 'Links, progress' },
  ],
};

const StyleSection: React.FC = () => {
  const { theme, themeName, setTheme } = useThemeStore();
  const c = theme.colors;

  const themesList = [
    { id: 'eden', label: 'Overgrown Transit', bg: '#0E1A14', accent: '#F4A261' },
    { id: 'twilight', label: 'Twilight Horizon', bg: '#1C1326', accent: '#E76F51' },
    { id: 'crimson', label: 'Crimson Age', bg: '#050304', accent: '#E62E43' },
  ] as const;

  // Build preview blobs from the actual theme accent
  // const blobA = c.accent;
  // const blobB = c.info;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div>
        <div style={{ fontSize: 26, fontWeight: 800, color: 'var(--text)', marginBottom: 4 }}>Style</div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 14 }}>
          Each theme pairs a unique palette with a full-screen background.
        </div>
      </div>

      {/* theme selector cards */}
      <div style={{ display: 'flex', gap: 10 }}>
        {themesList.map(({ id, label, bg, accent }) => {
          const active = themeName === id;
          return (
            <button
              key={id}
              onClick={() => setTheme(id)}
              style={{
                flex: 1, padding: 14, borderRadius: 'var(--radius-lg)',
                background: active ? `linear-gradient(135deg, ${bg}, ${bg}88)` : 'var(--glass-bg)',
                border: active ? `1.5px solid ${accent}` : '1px solid var(--glass-border)',
                color: 'var(--text)',
                cursor: 'pointer',
                textAlign: 'left',
                fontFamily: 'inherit',
                transition: 'all var(--anim-fast)',
                boxShadow: active ? `0 0 20px ${accent}30` : 'none',
              }}
            >
              <div style={{
                width: 28, height: 28, borderRadius: 8,
                background: `linear-gradient(135deg, ${accent}, ${accent}88)`,
                marginBottom: 10,
                boxShadow: active ? `0 0 16px ${accent}50` : 'none',
              }} />
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 2 }}>{label}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{active ? 'Active' : 'Click to apply'}</div>
            </button>
          );
        })}
      </div>

      {/* live preview — dynamic per theme */}
      <div
        className="glass"
        style={{
          padding: 16,
          borderRadius: 'var(--radius-lg)',
          background: `linear-gradient(135deg, ${c.bg} 0%, ${c.bgAlt} 100%)`,
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            position: 'absolute', top: -40, right: -40, width: 160, height: 160,
            borderRadius: '50%', background: c.accent, filter: 'blur(60px)', opacity: 0.35,
            pointerEvents: 'none',
          }}
        />
        <div
          style={{
            position: 'absolute', bottom: -60, left: -30, width: 200, height: 200,
            borderRadius: '50%', background: c.info, filter: 'blur(70px)', opacity: 0.25,
            pointerEvents: 'none',
          }}
        />
        <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ width: 28, height: 28, borderRadius: 8, background: c.brand, boxShadow: `0 0 16px ${c.accentGlow}` }} />
            <div>
              <div style={{ fontSize: 14, fontWeight: 700 }}>{theme.label}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{theme.video.endsWith('.jpg') ? 'Static image' : 'Animated video'} background</div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
            {[c.bg, c.bgAlt, c.surface, c.accent, c.brand, c.info].map((swatch, i) => (
              <div
                key={i}
                style={{
                  flex: 1, height: 28, borderRadius: 6,
                  background: swatch,
                  border: '1px solid var(--border)',
                }}
              />
            ))}
          </div>
        </div>
      </div>

      {/* dynamic color groups */}
      {Object.entries(PALETTE_META).map(([group, swatches]) => (
        <div key={group}>
          <SectionHeader>{group === 'base' ? 'Background & Text' : group === 'accent' ? 'Accents & Brand' : 'Semantic Colors'}</SectionHeader>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {swatches.map(({ key, name, note }) => {
              const hex = c[key];
              return (
                <div
                  key={key}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 12,
                    padding: '8px 12px', borderRadius: 'var(--radius-md)',
                    background: 'rgba(255,255,255,0.02)',
                    border: '1px solid var(--border-dim)',
                  }}
                >
                  <div
                    style={{
                      width: 32, height: 32, borderRadius: 8,
                      background: hex,
                      border: '1px solid var(--border)',
                      boxShadow: key === 'accent' || key === 'brand' ? `0 0 12px ${hex}66` : 'none',
                      flexShrink: 0,
                    }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{name}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{note}</div>
                  </div>
                  <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>{hex}</div>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      <HelpText>
        Colors update live from the theme object. Surfaces use translucent rgba for glass effect.
      </HelpText>
    </div>
  );
};

/* const SwatchRow removed — was unused */

const CanvasSection: React.FC = () => {
  const { terminalFontSize, setTerminalFontSize, gridSnap, setGridSnap, showGrid, setShowGrid } = useSettingsStore();
  const layoutMode = useWorkspaceStore((s) => s.layoutMode);
  const settings = useWorkspaceStore((s) => s.settings);
  const { arrangeTidy, arrangeGrid, arrangeStage, setLayoutMode, toggleSetting } = useWorkspaceStore.getState();

  const gridSize = LAYOUT_ENGINE_SPEC.arrangements.gridSnap;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div>
        <div style={{ fontSize: 26, fontWeight: 800, marginBottom: 4 }}>Canvas</div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 14 }}>
          The infinite workspace — pan, zoom, grid behavior, and agent window layout.
        </div>
      </div>

      {/* ── Zoom Range ────────────────────────────────────────────── */}
      <div>
        <SectionHeader>Zoom Range</SectionHeader>
        <div className="glass" style={{ padding: 14, borderRadius: 'var(--radius-md)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>10%</span>
            <div style={{ flex: 1, height: 4, borderRadius: 2, background: 'var(--border-dim)', position: 'relative' }}>
              <div
                style={{
                  position: 'absolute', left: 0, top: 0, height: '100%',
                  width: '50%', background: 'var(--accent)', borderRadius: 2,
                }}
              />
            </div>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>500%</span>
          </div>
          <HelpText>Scroll the wheel anywhere on the canvas to zoom. Bounded 10%–500%.</HelpText>
        </div>
      </div>

      {/* ── Pan ──────────────────────────────────────────────────── */}
      <div>
        <SectionHeader>Pan</SectionHeader>
        <div className="glass" style={{ padding: 14, borderRadius: 'var(--radius-md)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Pill tone="dim">left-drag</Pill>
            <Pill tone="dim">middle-drag</Pill>
            <Pill tone="dim">touch</Pill>
          </div>
          <HelpText>Drag empty space to pan. Click an agent card to drag it instead.</HelpText>
        </div>
      </div>

      {/* ── Grid Snap ────────────────────────────────────────────── */}
      <div>
        <SectionHeader>Grid Snap</SectionHeader>
        <div className="glass" style={{ padding: 14, borderRadius: 'var(--radius-md)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: gridSnap ? 8 : 0 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>Snap to grid</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                Align cards to {gridSize}px grid on release
              </div>
            </div>
            <Toggle checked={gridSnap} onChange={setGridSnap} />
          </div>
          {gridSnap && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0 0' }}>
              <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Size</span>
              <span
                className="glass"
                style={{
                  padding: '3px 14px', borderRadius: 'var(--radius-pill)',
                  fontSize: 11, fontFamily: 'var(--font-mono)', fontWeight: 600,
                }}
              >
                {gridSize}px
              </span>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Fixed — matches layout engine snap unit</span>
            </div>
          )}
        </div>
      </div>

      {/* ── Show Grid ────────────────────────────────────────────── */}
      <div>
        <SectionHeader>Show Grid</SectionHeader>
        <div className="glass" style={{ padding: 14, borderRadius: 'var(--radius-md)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>Canvas grid overlay</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Visual guide for card alignment</div>
            </div>
            <Toggle checked={showGrid} onChange={setShowGrid} />
          </div>
        </div>
      </div>

      {/* ── Layout (NEW) ─────────────────────────────────────────── */}
      <div>
        <SectionHeader>Agent Layout</SectionHeader>
        <div className="glass" style={{ padding: 14, borderRadius: 'var(--radius-md)' }}>
          {/* Mode action buttons */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
            {([
              { id: 'tidy' as const,  label: 'Tidy',  icon: <Grid3X3 size={14} />, desc: 'Flow arrange all windows' },
              { id: 'grid' as const,  label: 'Grid',  icon: <Layout size={14} />,  desc: 'Matrix grid alignment' },
              { id: 'stage' as const, label: 'Stage', icon: <Theater size={14} />, desc: 'Cinematic focus layout' },
            ]).map(({ id, label, icon, desc }) => {
              const active = layoutMode === id;
              return (
                <button
                  key={id}
                  onClick={() => {
                    if (active) setLayoutMode(null); // toggle off
                    else if (id === 'tidy') arrangeTidy();
                    else if (id === 'grid') arrangeGrid();
                    else if (id === 'stage') arrangeStage();
                  }}
                  title={desc}
                  style={{
                    flex: 1, padding: '10px 6px',
                    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
                    borderRadius: 'var(--radius-md)',
                    border: active ? '1.5px solid var(--accent)' : '1px solid var(--border)',
                    background: active ? 'var(--accent)12' : 'transparent',
                    color: active ? 'var(--accent)' : 'var(--text-secondary)',
                    cursor: 'pointer', fontFamily: 'inherit',
                    transition: 'all var(--anim-fast)',
                  }}
                >
                  <span style={{ opacity: active ? 1 : 0.6 }}>{icon}</span>
                  <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase' }}>
                    {label}
                  </span>
                  {active && (
                    <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>active — tap to disable</span>
                  )}
                </button>
              );
            })}
          </div>

          <HelpText>
            Apply an arrangement to all agent windows. Active mode re-runs automatically when windows
            open or close.
          </HelpText>
        </div>
      </div>

      {/* ── Canvas Window Settings (NEW) ─────────────────────────── */}
      <div>
        <SectionHeader>Auto-Lifecycle</SectionHeader>
        <div className="glass" style={{ padding: 14, borderRadius: 'var(--radius-md)' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>Tidy on open</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  Auto-arrange when a new terminal spawns
                </div>
              </div>
              <Toggle
                checked={settings.tidyOnWindowOpen}
                onChange={() => toggleSetting('tidyOnWindowOpen')}
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>Tidy on close</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  Auto-arrange when a terminal window is closed
                </div>
              </div>
              <Toggle
                checked={settings.tidyOnWindowClose}
                onChange={() => toggleSetting('tidyOnWindowClose')}
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>Agent canvas control</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  Allow agents to manipulate the canvas (future)
                </div>
              </div>
              <Toggle
                checked={settings.allowAgentCanvasControl}
                onChange={() => toggleSetting('allowAgentCanvasControl')}
                disabled
              />
            </div>
          </div>
        </div>
      </div>

      {/* ── Terminal Font Size ───────────────────────────────────── */}
      <div>
        <SectionHeader>Terminal Font Size</SectionHeader>
        <div className="glass" style={{ padding: 14, borderRadius: 'var(--radius-md)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="range" min={10} max={20} step={1}
              value={terminalFontSize}
              onChange={(e) => setTerminalFontSize(Number(e.target.value))}
              style={{ flex: 1, accentColor: 'var(--accent)' }}
            />
            <span className="glass" style={{ padding: '3px 12px', borderRadius: 'var(--radius-pill)', fontSize: 12, minWidth: 48, textAlign: 'center' }}>
              {terminalFontSize}px
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

const ShortcutsSection: React.FC = () => {
  const SHORTCUTS: { keys: string[]; desc: string }[] = [
    { keys: ['Scroll'], desc: 'Zoom canvas in/out (10%–500%)' },
    { keys: ['Left-drag', 'Middle-drag'], desc: 'Pan the infinite canvas' },
    { keys: ['Click + drag card header'], desc: 'Move an agent card' },
    { keys: ['Ctrl', 'L'], desc: 'Auto-layout all agents in a grid' },
    { keys: ['Ctrl', 'K'], desc: 'Focus camera on the selected agent' },
    { keys: ['Esc'], desc: 'Close settings / dialogs' },
    { keys: ['Enter'], desc: 'Send terminal command' },
    { keys: ['↑', '↓'], desc: 'Cycle terminal command history' },
    { keys: ['Ctrl', 'O'], desc: 'Toggle quick-action toolbar in terminals' },
    { keys: ['Ctrl', 'E'], desc: 'Hold to talk — voice input via Parakeet STT' },
    { keys: ['Click sleeping card'], desc: 'Wake a hibernated agent' },
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div>
        <div style={{ fontSize: 26, fontWeight: 800, marginBottom: 4 }}>Shortcuts</div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 14 }}>
          Speed keys for the canvas, terminals, and agent management.
        </div>
      </div>
      <div className="glass" style={{ padding: 6, borderRadius: 'var(--radius-md)' }}>
        {SHORTCUTS.map((s, i) => (
          <div
            key={i}
            style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '10px 12px',
              borderBottom: i < SHORTCUTS.length - 1 ? '1px solid var(--border-dim)' : 'none',
            }}
          >
            <div style={{ display: 'flex', gap: 4, minWidth: 200 }}>
              {s.keys.map((k, j) => (
                <kbd
                  key={j}
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    fontWeight: 600,
                    padding: '3px 9px',
                    borderRadius: 6,
                    background: 'rgba(244,162,97,0.10)',
                    border: '1px solid rgba(244,162,97,0.30)',
                    color: 'var(--accent)',
                    lineHeight: 1,
                  }}
                >
                  {k}
                </kbd>
              ))}
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{s.desc}</div>
          </div>
        ))}
      </div>
    </div>
  );
};

const AgentsSection: React.FC = () => {
  const { providers, providerModes } = useSettingsStore();
  const setProviderMode = useSettingsStore((s) => s.setProviderMode);
  const [installStates, setInstallStates] = useState<Record<string, { phase: string; percent: number; message: string }>>({});
  const [statuses, setStatuses] = useState<Record<string, ProviderStatus>>({});
  const [probed, setProbed] = useState(false);

  // Probe all providers on mount
  useEffect(() => {
    const specs = providers
      .filter((p) => p.id !== 'cursor')
      .map((p) => ({ id: p.id, name: p.name, command: p.command, args: p.args }));
    if (specs.length) {
      useProviderStore.getState().probeAll(specs).then(() => {
        setStatuses(useProviderStore.getState().statuses);
        setProbed(true);
      }).catch(() => setProbed(true));
    }
  }, [providers]);

  // Listen for install progress
  useEffect(() => {
    const unsub = onInstallProgress((data) => {
      setInstallStates((prev) => ({ ...prev, [data.providerId]: data }));
      if (data.phase === 'done' || data.phase === 'error') {
        setTimeout(() => {
          const spec = providers.find((p) => p.id === data.providerId);
          if (spec) {
            useProviderStore.getState().probeOne(spec.id, spec.name, spec.command, spec.args).then(() => {
              setStatuses({ ...useProviderStore.getState().statuses });
            });
          }
        }, 1500);
      }
    });
    return unsub;
  }, [providers]);

  const handleInstall = async (p: AgentProvider) => {
    setInstallStates((prev) => ({ ...prev, [p.id]: { phase: 'starting', percent: 0, message: 'Starting install...' } }));
    try {
      await installProvider(p.id, p.command);
    } catch (err: any) {
      setInstallStates((prev) => ({ ...prev, [p.id]: { phase: 'error', percent: 0, message: err.message } }));
    }
  };

  const agentProviders = providers.filter((p) => !p.shell && p.id !== 'cursor');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <div style={{ fontSize: 26, fontWeight: 800, marginBottom: 4 }}>Supported Agents</div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 14 }}>
          Each agent can run on the cloud (VPS) or locally. Switch modes per agent below.
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {agentProviders.map((p) => {
          const status = statuses[p.id];
          const isAvailable = status?.available;
          const install = installStates[p.id];
          const installing = install && (install.phase === 'starting' || install.phase === 'installing');
          const Icon = PROVIDER_ICONS[p.id];
          const mode: 'cloud' | 'local' = providerModes[p.id] ?? (p.type === 'custom' ? 'local' : 'cloud');

          return (
            <div
              key={p.id}
              className="glass"
              style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '12px 16px', borderRadius: 'var(--radius-md)',
                transition: 'all var(--anim-fast)',
              }}
            >
              {/* Logo */}
              <div style={{
                width: 36, height: 36, borderRadius: 8,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: isAvailable ? 'rgba(255, 120, 31, 0.10)' : 'rgba(255,255,255,0.03)',
                color: isAvailable ? 'var(--accent)' : 'var(--text-muted)',
                flexShrink: 0,
              }}>
                {Icon ? <Icon size={20} /> : <Bot size={18} />}
              </div>

              {/* Name + command */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                  {p.name}
                  {!p.shell && (
                    <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                      {p.command}
                    </span>
                  )}
                </div>
              </div>

              {/* Cloud/Local mode toggle */}
              <button
                onClick={() => setProviderMode(p.id, mode === 'cloud' ? 'local' : 'cloud')}
                style={{
                  display: 'flex', alignItems: 'center', gap: 4,
                  padding: '3px 10px', borderRadius: 'var(--radius-pill)',
                  fontSize: 10, fontWeight: 700, letterSpacing: 0.5,
                  textTransform: 'uppercase', border: '1px solid var(--border)',
                  cursor: 'pointer', transition: 'all var(--anim-fast)',
                  background: mode === 'cloud' ? 'var(--accent)' : 'rgba(234,244,244,0.06)',
                  color: mode === 'cloud' ? '#0E1A14' : 'var(--text-secondary)',
                  flexShrink: 0,
                }}
              >
                {mode === 'cloud' ? '☁ Cloud' : '◈ Local'}
              </button>

              {/* Status / Action — only when local mode */}
              {mode === 'local' && (installing ? (
                <div style={{ width: 120, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{
                    height: 4, borderRadius: 2,
                    background: 'rgba(255,255,255,0.06)',
                    overflow: 'hidden',
                  }}>
                    <div style={{
                      height: '100%', borderRadius: 2,
                      width: `${install.percent}%`,
                      background: 'linear-gradient(90deg, var(--accent), #ff9944)',
                      transition: 'width 0.3s ease',
                    }} />
                  </div>
                  <div style={{ fontSize: 9, color: 'var(--text-muted)', textAlign: 'right', fontFamily: 'var(--font-mono)' }}>
                    {install.percent}%
                  </div>
                </div>
              ) : isAvailable ? (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '4px 12px', borderRadius: 'var(--radius-pill)',
                  background: 'rgba(107, 191, 138, 0.10)',
                  border: '1px solid rgba(107, 191, 138, 0.20)',
                }}>
                  <span style={{
                    width: 6, height: 6, borderRadius: '50%',
                    background: '#6BBF8A',
                    boxShadow: '0 0 6px rgba(107,191,138,0.5)',
                  }} />
                  <span style={{ fontSize: 11, color: '#6BBF8A', fontWeight: 600 }}>Available</span>
                </div>
              ) : install?.phase === 'error' ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 10, color: 'var(--error)', maxWidth: 100, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {install.message}
                  </span>
                  <button
                    className="glass-btn"
                    onClick={() => handleInstall(p)}
                    style={{ padding: '6px 14px', fontSize: 11, fontWeight: 600 }}
                  >
                    Retry
                  </button>
                </div>
              ) : (
                <button
                  className="glass-btn"
                  onClick={() => handleInstall(p)}
                  style={{ padding: '6px 14px', fontSize: 11, fontWeight: 600 }}
                >
                  Download
                </button>
              ))}
            </div>
          );
        })}
      </div>

      {probed && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center', padding: '4px 0' }}>
          {agentProviders.filter((p) => statuses[p.id]?.available).length} of {agentProviders.length} agents available
        </div>
      )}
    </div>
  );
};

/* const AddCustomProviderForm removed — was unused */

const KNOWN_PROVIDERS: { key: string; label: string; envVar: string; hint: string }[] = [
  { key: 'anthropic', label: 'Anthropic', envVar: 'ANTHROPIC_API_KEY', hint: 'Used by Hermes + Claude Code agents' },
  { key: 'openai', label: 'OpenAI', envVar: 'OPENAI_API_KEY', hint: 'Used by Codex CLI agent' },
  { key: 'google', label: 'Google / Gemini', envVar: 'GOOGLE_API_KEY', hint: 'Used by Antigravity agent' },
];

const ApiKeysSection: React.FC = () => {
  const { apiKeys, setApiKey, removeApiKey } = useSettingsStore();
  const [provider, setProvider] = useState('');
  const [value, setValue] = useState('');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <div style={{ fontSize: 26, fontWeight: 800, marginBottom: 4 }}>API Keys</div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 14 }}>
          Per-provider keys. Stored locally, passed to agents as env vars.
        </div>
      </div>

      {/* Known provider rows */}
      <SectionHeader>Known Providers</SectionHeader>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {KNOWN_PROVIDERS.map((kp) => {
          const stored = apiKeys.find((k) => k.provider === kp.key);
          return (
            <div
              key={kp.key}
              className="glass"
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '10px 14px', borderRadius: 'var(--radius-md)',
              }}
            >
              <div style={{ minWidth: 130 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{kp.label}</div>
                <div style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', marginTop: 1 }}>
                  {kp.envVar}
                </div>
              </div>
              <input
                className="glass-input"
                type="password"
                value={stored?.key || ''}
                onChange={(e) => {
                  if (e.target.value) setApiKey(kp.key, e.target.value);
                  else removeApiKey(kp.key);
                }}
                placeholder={stored ? '••••••••' : `Enter ${kp.envVar}…`}
                style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 12 }}
              />
              {stored && (
                <Pill tone="amber">saved</Pill>
              )}
            </div>
          );
        })}
      </div>

      {/* Existing key list (non-known providers) */}
      {apiKeys.filter((k) => !KNOWN_PROVIDERS.some((kp) => kp.key === k.provider)).length > 0 && (
        <>
          <SectionHeader>Custom Keys</SectionHeader>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {apiKeys
              .filter((k) => !KNOWN_PROVIDERS.some((kp) => kp.key === k.provider))
              .map((k) => (
                <div
                  key={k.provider}
                  className="glass"
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '10px 14px', borderRadius: 'var(--radius-md)',
                  }}
                >
                  <Pill tone="amber">{k.provider}</Pill>
                  <span
                    style={{
                      fontSize: 12, color: 'var(--text-muted)',
                      flex: 1, fontFamily: 'var(--font-mono)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}
                  >
                    {k.key.slice(0, 12)}••••{k.key.slice(-4)}
                  </span>
                  <button
                    className="glass-btn"
                    onClick={() => removeApiKey(k.provider)}
                    style={{ padding: '3px 10px', fontSize: 11, color: 'var(--error)' }}
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
          </div>
        </>
      )}

      {/* Add custom key form */}
      <div
        className="glass"
        style={{
          padding: 12, borderRadius: 'var(--radius-md)',
          display: 'flex', flexDirection: 'column', gap: 10,
        }}
      >
        <SectionHeader>Add Custom Provider</SectionHeader>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            className="glass-input"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            placeholder="provider (e.g. groq, cohere…)"
            style={{ width: 180 }}
          />
          <input
            className="glass-input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="sk-…"
            type="password"
            style={{ flex: 1 }}
          />
          <button
            className="glass-btn"
            onClick={() => {
              if (provider && value) {
                setApiKey(provider, value);
                setProvider('');
                setValue('');
              }
            }}
            style={{
              padding: '8px 18px', fontSize: 12, fontWeight: 600,
              background: 'var(--accent)', color: '#0E1A14', borderColor: 'var(--accent)',
            }}
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
};

const McpSection: React.FC = () => {
  const { mcpServers, addMcpServer, removeMcpServer, toggleMcpServer } = useSettingsStore();
  const [name, setName] = useState('');
  const [cmd, setCmd] = useState('');
  const [orchUrl, setOrchUrl] = useState<string | null>(null);

  useEffect(() => {
    getMcpUrl().then(setOrchUrl).catch(() => {});
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <div style={{ fontSize: 26, fontWeight: 800, marginBottom: 4 }}>MCP</div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 14 }}>
          Model Context Protocol servers — tools for your agents.
        </div>
      </div>

      {/* ORCH built-in MCP server status */}
      {orchUrl && (
        <div className="glass" style={{ padding: 12, borderRadius: 'var(--radius-md)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <Radio size={16} style={{ color: 'var(--success)', flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>ORCH MCP Server</div>
            <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', wordBreak: 'break-all' }}>
              {orchUrl}
            </div>
          </div>
          <Pill tone="amber">built-in</Pill>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {mcpServers.length === 0 && (
          <div
            className="glass"
            style={{
              fontSize: 13, color: 'var(--text-muted)',
              padding: 14, borderRadius: 'var(--radius-md)',
              textAlign: 'center',
            }}
          >
            No MCP servers configured. Add one below.
          </div>
        )}
        {mcpServers.map((s) => (
          <div
            key={s.id}
            className="glass"
            style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '10px 14px', borderRadius: 'var(--radius-md)',
            }}
          >
            <span className={`status-dot ${s.enabled ? 'active' : 'idle'}`} />
            <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>{s.name}</span>
            <Pill tone="dim">{s.type}</Pill>
            <button
              className="glass-btn"
              onClick={() => toggleMcpServer(s.id)}
              style={{ padding: '3px 10px', fontSize: 11 }}
            >
              {s.enabled ? 'Disable' : 'Enable'}
            </button>
            <button
              className="glass-btn"
              onClick={() => removeMcpServer(s.id)}
              style={{ padding: '3px 10px', fontSize: 11, color: 'var(--error)' }}
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>

      <div
        className="glass"
        style={{
          padding: 12, borderRadius: 'var(--radius-md)',
          display: 'flex', flexDirection: 'column', gap: 10,
        }}
      >
        <SectionHeader>Add a server</SectionHeader>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            className="glass-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Server name"
            style={{ width: 180 }}
          />
          <input
            className="glass-input"
            value={cmd}
            onChange={(e) => setCmd(e.target.value)}
            placeholder="command or URL"
            style={{ flex: 1 }}
          />
          <button
            className="glass-btn"
            onClick={() => {
              if (name && cmd) {
                addMcpServer({
                  id: crypto.randomUUID(),
                  name,
                  type: cmd.startsWith('http') ? 'sse' : 'stdio',
                  command: cmd.startsWith('http') ? undefined : cmd,
                  url: cmd.startsWith('http') ? cmd : undefined,
                  enabled: true,
                });
                setName('');
                setCmd('');
              }
            }}
            style={{
              padding: '8px 18px', fontSize: 12, fontWeight: 600,
              background: 'var(--accent)', color: '#0E1A14', borderColor: 'var(--accent)',
            }}
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
};

// ── Audio Section ─────────────────────────────────────────────────

const AudioSection: React.FC = () => {
  const { audioInputDeviceId, setAudioInputDevice, groqApiKey, enableGroqOnSTTFailure, setGroqApiKey, setGroqOnSTTFailure, instantStart, setInstantStart } = useSettingsStore();
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const groqKey = groqApiKey || '';
  const enableGroq = enableGroqOnSTTFailure || false;

  // Enumerate on mount (permission may not be granted — that's OK, list will be empty)
  useEffect(() => {
    navigator.mediaDevices?.enumerateDevices().then((all) => {
      setDevices(all.filter((d) => d.kind === 'audioinput'));
    }).catch(() => {});
  }, []);

  // Re-enumerate when the section becomes visible (permission may have been granted)
  useEffect(() => {
    const id = setTimeout(() => {
      navigator.mediaDevices?.enumerateDevices().then((all) => {
        setDevices(all.filter((d) => d.kind === 'audioinput'));
      }).catch(() => {});
    }, 500);
    return () => clearTimeout(id);
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <div style={{ fontSize: 26, fontWeight: 800, marginBottom: 4 }}>Audio Input</div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 14 }}>
          Microphone selection and device status for voice commands.
        </div>
      </div>

      {/* Selected device card */}
      <div className="glass" style={{ padding: 14, borderRadius: 'var(--radius-md)', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 32, height: 32, borderRadius: '50%',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(255, 120, 31, 0.12)',
            color: 'var(--accent)',
            flexShrink: 0,
          }}>
            <Mic size={16} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4, fontWeight: 500 }}>Input device</div>
            <div style={{ position: 'relative' }}>
              <select
                value={audioInputDeviceId}
                onChange={(e) => setAudioInputDevice(e.target.value)}
                className="glass-input"
                style={{
                  width: '100%',
                  padding: '10px 32px 10px 12px',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: 13,
                  fontFamily: "'JetBrains Mono', 'Cascadia Code', monospace",
                  color: devices.length === 0 ? 'var(--text-muted)' : 'var(--text)',
                  appearance: 'none',
                  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23ff781f' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`,
                  backgroundRepeat: 'no-repeat',
                  backgroundPosition: 'right 12px center',
                  cursor: 'pointer',
                }}
              >
                <option value="">System Default</option>
                {devices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `Microphone ${d.deviceId.slice(0, 8)}…`}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Device status */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, borderTop: '1px solid var(--border-dim)', paddingTop: 10 }}>
          <span className={`status-dot ${devices.length > 0 ? 'active' : 'idle'}`} />
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {devices.length > 0
              ? `${devices.length} input device${devices.length !== 1 ? 's' : ''} available`
              : 'Permission needed — press Ctrl+E to grant mic access'
            }
          </span>
        </div>
      </div>

      {/* Help card */}
      <div className="glass" style={{ padding: 12, borderRadius: 'var(--radius-md)' }}>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }}>
          <strong style={{ color: 'var(--text-secondary)' }}>Push-to-Talk:</strong> Hold <kbd style={{ color: 'var(--accent)', fontFamily: 'var(--font-mono)', fontSize: 11, border: '1px solid rgba(255,120,31,0.3)', padding: '1px 6px', borderRadius: 4 }}>Ctrl+E</kbd> while speaking.
          Release to send. Devices appear here after first use.
        </div>
      </div>

      {/* Instant Start */}
      <div className="glass" style={{ padding: 14, borderRadius: 'var(--radius-md)', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', letterSpacing: 0.2 }}>
              Instant Start
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.5, maxWidth: 320 }}>
              Keep the mic warmed up between captures so voice input starts with
              zero latency. Uses standby mic access in the background.
            </div>
          </div>
          {/* Premium toggle switch */}
          <div
            onClick={() => setInstantStart(!instantStart)}
            style={{
              position: 'relative', width: 42, height: 24, flexShrink: 0,
              borderRadius: 12, cursor: 'pointer',
              background: instantStart
                ? 'linear-gradient(135deg, #ff781f 0%, #e0671a 100%)'
                : 'rgba(255,255,255,0.08)',
              transition: 'all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)',
              boxShadow: instantStart
                ? '0 0 12px rgba(255,120,31,0.35), inset 0 1px 0 rgba(255,255,255,0.15)'
                : 'inset 0 1px 0 rgba(255,255,255,0.04)',
            }}
          >
            <div style={{
              position: 'absolute', top: 2, left: instantStart ? 20 : 2,
              width: 20, height: 20, borderRadius: '50%',
              background: instantStart ? '#fff' : 'rgba(255,255,255,0.35)',
              transition: 'all 0.35s cubic-bezier(0.34, 1.56, 0.64, 1)',
              boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
            }} />
          </div>
        </div>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          borderTop: '1px solid var(--border-dim)', paddingTop: 10,
        }}>
          <span style={{
            width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
            background: instantStart ? '#4ADE80' : 'rgba(255,255,255,0.15)',
            transition: 'background 0.3s ease',
          }} />
          <span style={{ fontSize: 11, color: instantStart ? 'var(--text-secondary)' : 'var(--text-muted)', transition: 'color 0.3s ease' }}>
            {instantStart ? 'Mic primed — zero-latency PTT' : 'Full cold start on each PTT press'}
          </span>
        </div>
      </div>

      {/* ── Groq Premium Fallback ─────────────────────────────── */}
      <div style={{ borderTop: '1px solid var(--border-dim)', paddingTop: 14, marginTop: 4 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--accent)' }}>
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
          </svg>
          Groq STT Fallback
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.5 }}>
          When local Whisper fails to recognise speech, ORCH can send the audio to Groq's
          <strong style={{ color: 'var(--text-secondary)' }}> whisper-large-v3-turbo </strong>
          for a high-fidelity re-transcription. Your key is stored locally and never sent anywhere else.
        </div>

        <div className="glass" style={{ padding: 14, borderRadius: 'var(--radius-md)', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* API key input */}
          <GroqKeyInput />

          {/* Enable toggle */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <input
              type="checkbox"
              checked={enableGroq}
              onChange={(e) => setGroqOnSTTFailure(e.target.checked)}
              id="groq-toggle"
              style={{ accentColor: 'var(--accent)', width: 16, height: 16, cursor: 'pointer' }}
            />
            <label htmlFor="groq-toggle" style={{ fontSize: 12, color: 'var(--text-secondary)', cursor: 'pointer', userSelect: 'none' }}>
              Enable Groq fallback when local STT fails
            </label>
          </div>

          {/* Status indicator */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, borderTop: '1px solid var(--border-dim)', paddingTop: 10 }}>
            <span className={`status-dot ${groqKey ? 'active' : 'idle'}`} />
            <span style={{ fontSize: 11, color: groqKey ? 'var(--text-secondary)' : 'var(--text-muted)' }}>
              {groqKey
                ? `Groq key configured ${enableGroq ? '· fallback active' : '· fallback disabled'}`
                : 'No key set — local STT only (free, always-on)'
              }
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

// ── Groq Key Input ──────────────────────────────────────────────
// Premium masked input for the BYOK Groq API key

const GroqKeyInput: React.FC = () => {
  const { groqApiKey, setGroqApiKey } = useSettingsStore();
  const [showKey, setShowKey] = useState(false);
  const [localValue, setLocalValue] = useState(groqApiKey || '');
  const [saved, setSaved] = useState(false);

  // Sync from store on mount
  useEffect(() => {
    setLocalValue(groqApiKey || '');
  }, [groqApiKey]);

  const handleSave = () => {
    setGroqApiKey(localValue.trim());
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleClear = () => {
    setLocalValue('');
    setGroqApiKey('');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6 }}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
        Groq API Key
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          type={showKey ? 'text' : 'password'}
          value={localValue}
          onChange={(e) => { setLocalValue(e.target.value); setSaved(false); }}
          placeholder="gsk_..."
          className="glass-input"
          style={{
            flex: 1,
            padding: '10px 12px',
            borderRadius: 'var(--radius-sm)',
            fontSize: 13,
            fontFamily: "'JetBrains Mono', 'Cascadia Code', monospace",
            color: localValue ? 'var(--text)' : 'var(--text-muted)',
          }}
        />
        <button
          onClick={() => setShowKey(!showKey)}
          title={showKey ? 'Hide key' : 'Show key'}
          className="glass-btn"
          style={{
            width: 36, height: 36, padding: 0, fontSize: 14,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
            border: '1px solid var(--glass-border)',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--glass-bg)',
            color: 'var(--text-muted)',
            cursor: 'pointer',
          }}
        >
          {showKey ? '🙈' : '👁'}
        </button>
        <button
          onClick={handleSave}
          disabled={!localValue.trim()}
          className="glass-btn"
          style={{
            padding: '8px 16px',
            fontSize: 12,
            fontWeight: 600,
            borderRadius: 'var(--radius-sm)',
            border: saved ? '1px solid var(--success)' : '1px solid var(--glass-border)',
            background: saved ? 'rgba(78, 168, 222, 0.12)' : 'var(--glass-bg)',
            color: saved ? 'var(--success)' : 'var(--text)',
            cursor: localValue.trim() ? 'pointer' : 'not-allowed',
            opacity: localValue.trim() ? 1 : 0.4,
            fontFamily: 'inherit',
            transition: 'all 0.2s ease',
          }}
        >
          {saved ? '✓ Saved' : 'Save'}
        </button>
        {localValue && (
          <button
            onClick={handleClear}
            title="Clear key"
            className="glass-btn"
            style={{
              width: 36, height: 36, padding: 0, fontSize: 14,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0,
              border: '1px solid rgba(231, 111, 81, 0.3)',
              borderRadius: 'var(--radius-sm)',
              background: 'rgba(231, 111, 81, 0.08)',
              color: 'var(--error)',
              cursor: 'pointer',
            }}
          >
            ✕
          </button>
        )}
      </div>
    </div>
  );
};

// ── Account Section ───────────────────────────────────────────────

const AccountSection: React.FC = () => {
  const { user, status, signIn, signOut } = useAuthStore();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const isAuthed = status === 'authenticated' && !!user;

  const handleLogin = async () => {
    setError('');
    const { error: err } = await signIn(email, password);
    if (err) setError(err.message || 'Login failed');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div>
        <div style={{ fontSize: 26, fontWeight: 800, marginBottom: 4 }}>Account</div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 14 }}>
          Supabase authentication — link your workspace across devices.
        </div>
      </div>

      {isAuthed ? (
        <div className="glass" style={{ padding: 16, borderRadius: 'var(--radius-md)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
            <div style={{
              width: 40, height: 40, borderRadius: '50%',
              background: 'var(--accent)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 16, fontWeight: 700, color: '#0E1A14',
              flexShrink: 0,
            }}>
              {(user.email || '?').charAt(0).toUpperCase()}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 600 }}>{user.email}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Connected via Supabase</div>
            </div>
          </div>
          <button
            onClick={signOut}
            className="glass-btn"
            style={{ padding: '10px 20px', fontSize: 12, fontWeight: 600, color: 'var(--error)' }}
          >
            Sign Out
          </button>
        </div>
      ) : (
        <div className="glass" style={{ padding: 16, borderRadius: 'var(--radius-md)' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <input
              className="glass-input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email"
              style={{ padding: '10px 14px', fontSize: 13, borderRadius: 'var(--radius-sm)' }}
            />
            <input
              className="glass-input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              style={{ padding: '10px 14px', fontSize: 13, borderRadius: 'var(--radius-sm)' }}
              onKeyDown={(e) => { if (e.key === 'Enter') handleLogin(); }}
            />
            {error && (
              <div style={{ fontSize: 11, color: 'var(--error)', padding: '4px 0' }}>{error}</div>
            )}
            <button
              onClick={handleLogin}
              disabled={status === 'loading'}
              style={{
                padding: '10px 0',
                borderRadius: 'var(--radius-sm)',
                border: 'none',
                background: 'var(--accent)',
                color: '#0E1A14',
                fontSize: 13, fontWeight: 700,
                cursor: status === 'loading' ? 'wait' : 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {status === 'loading' ? 'Signing in…' : 'Sign In'}
            </button>
          </div>
          <HelpText>Enter your Supabase credentials to enable cloud sync across devices.</HelpText>
        </div>
      )}
    </div>
  );
};

// ── root settings dialog ─────────────────────────────────────────────────────

const SECTIONS: { id: Section; label: string; icon: React.ComponentType<{ size?: number }> }[] = [
  { id: 'style',     label: 'Style',     icon: Palette },
  { id: 'canvas',    label: 'Canvas',    icon: Layout },
  { id: 'shortcuts', label: 'Shortcuts', icon: Keyboard },
  { id: 'agents',    label: 'Agents',    icon: Bot },
  { id: 'apis',      label: 'API Keys',  icon: Key },
  { id: 'mcp',       label: 'MCP',       icon: Plug },
  { id: 'audio',     label: 'Audio',     icon: Mic },
  { id: 'account',   label: 'Account',   icon: User },
];

const SECTION_TITLES: Record<Section, { title: string; sub: string }> = {
  style:     { title: 'Style',     sub: 'The visual identity of ORCH.' },
  canvas:    { title: 'Canvas',    sub: 'Infinite workspace behavior.' },
  shortcuts: { title: 'Shortcuts', sub: 'Speed keys for the canvas and terminal.' },
  agents:    { title: 'Agents',    sub: 'CLI / Code / Cursor / launch.' },
  apis:      { title: 'API Keys',  sub: 'Per-provider credentials.' },
  mcp:       { title: 'MCP',       sub: 'Model Context Protocol servers.' },
  audio:     { title: 'Audio',     sub: 'Microphone and voice input settings.' },
  account:   { title: 'Account',   sub: 'Supabase authentication and profile.' },
};

export const SettingsDialog: React.FC<SettingsDialogProps> = ({ onClose }) => {
  const [section, setSection] = useState<Section>('style');
  const { providers } = useSettingsStore();
  const probed = useRef(false);

  // Auto-probe providers on first open of the agents section
  useEffect(() => {
    if (section === 'agents' && !probed.current) {
      const specs = providers
        .filter((p) => p.launchMode === 'embedded' && !p.shell)
        .map((p) => ({ id: p.id, name: p.name, command: p.command, args: p.args }));
      if (specs.length) useProviderStore.getState().probeAll(specs);
      probed.current = true;
    }
  }, [section, providers]);

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 2000,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.6)',
        animation: 'fadeIn var(--anim-normal) ease',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <GlassPanel
        className="animate-scale-in"
        style={{
          width: 880,
          maxWidth: 'calc(100vw - 32px)',
          height: 640,
          maxHeight: '85vh',
          padding: 0,
          overflow: 'hidden',
          display: 'flex',
          borderRadius: 'var(--radius-xl)',
          boxShadow: 'var(--shadow-xl)',
        }}
      >
        {/* ── sidebar ──────────────────────────────────────────────── */}
        <div
          style={{
            width: 220,
            flexShrink: 0,
            background: 'var(--bg-alt)',
            borderRight: '1px solid var(--border)',
            display: 'flex',
            flexDirection: 'column',
            padding: '20px 12px',
            gap: 4,
          }}
        >
          <div
            style={{
              fontSize: 11, fontWeight: 700, letterSpacing: 1.4,
              textTransform: 'uppercase', color: 'var(--text-muted)',
              padding: '4px 12px 12px',
            }}
          >
            Settings
          </div>

          {SECTIONS.map((s) => {
            const active = section === s.id;
            return (
              <button
                key={s.id}
                onClick={() => setSection(s.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '8px 12px',
                  borderRadius: 'var(--radius-md)',
                  background: active ? 'var(--accent)' : 'transparent',
                  color: active ? '#0E1A14' : 'var(--text-secondary)',
                  border: 'none',
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontFamily: 'inherit',
                  fontSize: 13,
                  fontWeight: 600,
                  transition: 'all var(--anim-fast)',
                }}
                onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'var(--glass-hover)'; }}
                onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
              >
                <span style={{
                  width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: active ? '#0E1A14' : 'var(--accent)',
                }}>
                  {React.createElement(s.icon, { size: 16 })}
                </span>
                <span style={{ flex: 1 }}>{s.label}</span>
              </button>
            );
          })}

          <div style={{ flex: 1 }} />
        </div>

        {/* ── main content ─────────────────────────────────────────── */}
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            minWidth: 0,
            background: 'var(--bg)',
          }}
        >
          {/* header */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '20px 28px 16px',
              borderBottom: '1px solid var(--border-dim)',
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 22, fontWeight: 800, lineHeight: 1.1 }}>
                {SECTION_TITLES[section].title}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                {SECTION_TITLES[section].sub}
              </div>
            </div>
            <button
              onClick={onClose}
              className="glass-btn"
              style={{
                width: 30, height: 30, padding: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 14, color: 'var(--text-secondary)',
                borderRadius: '50%',
              }}
              title="Close (Esc)"
            >
              <X size={14} />
            </button>
          </div>

          {/* body */}
          <div
            style={{
              flex: 1,
              overflow: 'auto',
              padding: '24px 28px 28px',
            }}
          >
            {section === 'style' && <StyleSection />}
            {section === 'canvas' && <CanvasSection />}
            {section === 'shortcuts' && <ShortcutsSection />}
            {section === 'agents' && <AgentsSection />}
            {section === 'apis' && <ApiKeysSection />}
            {section === 'mcp' && <McpSection />}
            {section === 'audio' && <AudioSection />}
            {section === 'account' && <AccountSection />}
          </div>
        </div>
      </GlassPanel>
    </div>
  );
};
