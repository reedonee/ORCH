import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GlassPanel } from './GlassPanel';
import { useSettingsStore } from '../stores/useSettingsStore';
import { useProviderStore } from '../stores/useProviderStore';
import { useThemeStore } from '../stores/useThemeStore';
import { Z_BASE_LAYERS } from '../lib/z-stack-manager';
import { useWorkspaceStore, LAYOUT_ENGINE_SPEC } from '../stores/useWorkspaceStore';
import { useAuthStore } from '../stores/useAuthStore';
import { useMusicPlayerStore } from '../stores/useMusicPlayerStore';
import { X, Palette, Layout, Keyboard, Mic, Bot, Key, Plug, User, Grid3X3, Theater, Crosshair, Columns2, Rows3, Share2, Volume2 } from 'lucide-react';
import { VisualThemeEngine } from './VisualThemeEngine';
import { getMcpUrl, installProvider, onInstallProgress, voiceModelStatus, voiceConfigure, voiceSpeak, invoke } from '../lib/electron-api';
import { PROVIDER_ICONS } from './icons/ProviderIcon';
import type { ProviderStatus } from '../types/provider';
import type { AgentProvider } from '../types/settings';
import type { VoiceModelStatus } from '../lib/electron-api';

interface SettingsDialogProps {
  onClose: () => void;
}

type Section = 'shortcuts' | 'style' | 'canvas' | 'audio' | 'agents' | 'apis' | 'mcp' | 'account';

// ── shared atoms ──────────────────────────────────────────────────

const SectionHeader: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1.4, textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 10 }}>
    {children}
  </div>
);

const Toggle: React.FC<{ checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }> = ({ checked, onChange, disabled }) => (
  <button
    role="switch" aria-checked={checked}
    onClick={() => !disabled && onChange(!checked)}
    disabled={disabled}
    style={{
      width: 36, height: 20, borderRadius: 'var(--radius-pill)',
      background: checked ? 'var(--accent)' : 'var(--border)',
      border: '1px solid var(--border)', position: 'relative',
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.4 : 1, padding: 0,
      transition: 'background var(--anim-fast)',
    }}
  >
    <span style={{
      position: 'absolute', top: 2, left: checked ? 18 : 2,
      width: 14, height: 14, borderRadius: '50%',
      background: checked ? 'var(--bg)' : 'var(--text-secondary)',
      transition: 'left var(--anim-fast)',
    }} />
  </button>
);

/** Labelled range control with a live value read-out. Every slider in
 *  this dialog was previously hand-rolled, so they drifted in spacing,
 *  and none carried an accessible name. */
const Slider: React.FC<{
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
  hint?: string;
}> = ({ label, value, min, max, step = 1, format, onChange, hint }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <label htmlFor={`sl-${label}`} style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{label}</label>
      <span style={{
        padding: '2px 10px', borderRadius: 'var(--radius-pill)', fontSize: 11,
        minWidth: 52, textAlign: 'center',
        background: 'var(--glass-bg)', border: '1px solid var(--border)',
      }}>
        {format ? format(value) : value}
      </span>
    </div>
    <input
      id={`sl-${label}`}
      type="range" min={min} max={max} step={step} value={value}
      aria-label={label}
      aria-valuetext={format ? format(value) : String(value)}
      onChange={(e) => onChange(Number(e.target.value))}
      style={{ width: '100%', accentColor: 'var(--accent)' }}
    />
    {hint && <div style={{ fontSize: 10.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>{hint}</div>}
  </div>
);

const glassCard: React.CSSProperties = {
  padding: 14, borderRadius: 'var(--radius-md)',
  background: 'var(--surface)',
  border: '1px solid var(--border-dim)',
};

const Pill: React.FC<{ children: React.ReactNode; tone?: 'amber' | 'dim' }> = ({ children, tone = 'dim' }) => (
  <span style={{
    display: 'inline-block', padding: '2px 10px', borderRadius: 'var(--radius-pill)',
    background: tone === 'amber' ? 'var(--accent)' : 'transparent',
    color: tone === 'amber' ? 'var(--bg)' : 'var(--text-muted)',
    border: tone === 'dim' ? '1px solid var(--border)' : '1px solid transparent',
    fontSize: 10, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase',
    lineHeight: 1.5,
  }}>{children}</span>
);

// ── Remap button (inline key-capture) ──────────────────────────────

const RemapButton: React.FC<{
  current: string;
  onSave: (combo: string) => void;
}> = ({ current, onSave }) => {
  const [capturing, setCapturing] = useState(false);

  return (
    <button
      onClick={() => {
        setCapturing(true);
        const handler = (e: KeyboardEvent) => {
          e.preventDefault();
          e.stopPropagation();
          const parts: string[] = [];
          if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
          if (e.shiftKey) parts.push('Shift');
          if (e.altKey) parts.push('Alt');
          const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
          if (key !== 'Ctrl' && key !== 'Shift' && key !== 'Meta' && key !== 'Alt') parts.push(key);
          if (parts.length > 0) onSave(parts.join('+'));
          window.removeEventListener('keydown', handler);
          setCapturing(false);
        };
        window.addEventListener('keydown', handler);
      }}
      style={{
        padding: capturing ? '2px 10px' : '2px 8px',
        fontSize: 9, fontWeight: 600, fontFamily: 'inherit',
        borderRadius: 4, border: capturing ? '1px solid var(--accent)' : '1px solid var(--border)',
        background: capturing ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'transparent',
        color: capturing ? 'var(--accent)' : 'var(--text-muted)',
        cursor: 'pointer', flexShrink: 0,
      }}
    >
      {capturing ? '…press combo' : 'Remap'}
    </button>
  );
};

// ── Styles ────────────────────────────────────────────────────────

const StyleSection: React.FC = () => {
  return (
    <div style={{ height: '100%' }}>
      <VisualThemeEngine />
    </div>
  );
};

// ── Canvas ────────────────────────────────────────────────────────

const CanvasSection: React.FC = () => {
  // Selector subscriptions — this dialog used to pull whole stores in
  // nine places, so opening it re-rendered on every unrelated change.
  const terminalFontSize = useSettingsStore((s) => s.terminalFontSize);
  const setTerminalFontSize = useSettingsStore((s) => s.setTerminalFontSize);
  const gridSnap = useSettingsStore((s) => s.gridSnap);
  const setGridSnap = useSettingsStore((s) => s.setGridSnap);
  const showGrid = useSettingsStore((s) => s.showGrid);
  const setShowGrid = useSettingsStore((s) => s.setShowGrid);
  const cardOpacity = useSettingsStore((s) => s.cardOpacity);
  const setCardOpacity = useSettingsStore((s) => s.setCardOpacity);
  const cardBlur = useSettingsStore((s) => s.cardBlur);
  const setCardBlur = useSettingsStore((s) => s.setCardBlur);
  const terminalScrim = useSettingsStore((s) => s.terminalScrim);
  const setTerminalScrim = useSettingsStore((s) => s.setTerminalScrim);
  const terminalTransparency = useSettingsStore((s) => s.terminalTransparency);
  const setTerminalTransparency = useSettingsStore((s) => s.setTerminalTransparency);
  const reduceMotion = useSettingsStore((s) => s.reduceMotion);
  const setReduceMotion = useSettingsStore((s) => s.setReduceMotion);

  const layoutMode = useWorkspaceStore((s) => s.layoutMode);
  const settings = useWorkspaceStore((s) => s.settings);
  const arrange = useWorkspaceStore((s) => s.arrange);
  const setLayoutMode = useWorkspaceStore((s) => s.setLayoutMode);
  const toggleSetting = useWorkspaceStore((s) => s.toggleSetting);
  const gridSize = LAYOUT_ENGINE_SPEC.arrangements.gridSnap;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* Layout */}
      <div>
        <SectionHeader>Agent Layout</SectionHeader>
        <div style={glassCard}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginBottom: 14 }}>
            {([
              { id: 'grid' as const,          label: 'Grid',   icon: <Grid3X3 size={14} />, desc: 'Even cells, sized to your window' },
              { id: 'focus' as const,         label: 'Focus',  icon: <Crosshair size={14} />, desc: 'Selected agent large, rest in a rail' },
              { id: 'split' as const,         label: 'Split',  icon: <Columns2 size={14} />, desc: 'Two balanced columns' },
              { id: 'rail' as const,          label: 'Rail',   icon: <Rows3 size={14} />, desc: 'Single horizontal strip' },
              { id: 'constellation' as const, label: 'Cluster',icon: <Share2 size={14} />, desc: 'Group by delegation links' },
              { id: 'stage' as const,         label: 'Stage',  icon: <Theater size={14} />, desc: 'Browser left, agents right' },
            ]).map(({ id, label, icon, desc }) => {
              const active = layoutMode === id;
              return (
                <button
                  key={id}
                  onClick={() => { if (active) setLayoutMode(null); else arrange(id); }}
                  title={desc}
                  aria-pressed={active}
                  style={{
                    padding: '10px 6px',
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
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Auto-lifecycle */}
      <div>
        <SectionHeader>Auto-Lifecycle</SectionHeader>
        <div style={glassCard}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>Tidy on open/close</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <Toggle checked={settings.tidyOnWindowOpen} onChange={() => toggleSetting('tidyOnWindowOpen')} />
                <Toggle checked={settings.tidyOnWindowClose} onChange={() => toggleSetting('tidyOnWindowClose')} />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Grid snap */}
      <div>
        <SectionHeader>Grid</SectionHeader>
        <div style={{ ...glassCard, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>Snap to grid</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{gridSize}px snap on release</div>
            </div>
            <Toggle checked={gridSnap} onChange={setGridSnap} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>Canvas grid overlay</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Visual alignment guide</div>
            </div>
            <Toggle checked={showGrid} onChange={setShowGrid} />
          </div>
        </div>
      </div>

      {/* Appearance */}
      <div>
        <SectionHeader>Appearance</SectionHeader>
        <div style={{ ...glassCard, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Slider
            label="Card transparency"
            value={Math.round((1 - cardOpacity) * 100)}
            min={0} max={65} step={5}
            format={(v) => `${v}%`}
            onChange={(v) => setCardOpacity(1 - v / 100)}
            hint="How much of the canvas shows through agent cards."
          />
          <Slider
            label="Backdrop blur"
            value={cardBlur}
            min={0} max={40} step={2}
            format={(v) => `${v}px`}
            onChange={setCardBlur}
            hint="Frosts whatever is behind a card. Off gives the sharpest text: with blur on, Windows can't use ClearType for card text, so it looks slightly softer."
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Terminal transparency</div>
            <div style={{ display: 'flex', gap: 6 }}>
              {([
                { id: 'full' as const, label: 'Full', desc: 'See-through, and every colour the agent draws is kept.' },
                { id: 'gpu' as const,  label: 'GPU',  desc: 'Faster rendering, but a TUI’s dark panels may draw solid.' },
              ]).map(({ id, label, desc }) => (
                <button
                  key={id}
                  onClick={() => setTerminalTransparency(id)}
                  title={desc}
                  aria-pressed={terminalTransparency === id}
                  style={{
                    flex: 1, padding: '8px 10px', borderRadius: 'var(--radius-sm)',
                    border: terminalTransparency === id ? '1.5px solid var(--accent)' : '1px solid var(--border)',
                    background: terminalTransparency === id ? 'var(--accent)12' : 'transparent',
                    color: 'var(--text)', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit',
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 10.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>
              Card transparency and blur above apply to the whole card,
              terminal included. Reopen a terminal for a change here to take effect.
            </div>
          </div>

          <Slider
            label="Terminal readability"
            value={Math.round(terminalScrim * 100)}
            min={0} max={100} step={5}
            format={(v) => `${v}%`}
            onChange={(v) => setTerminalScrim(v / 100)}
            hint="Optional. Darkens just the terminal, in your theme's colour, if light text is hard to read over a bright wallpaper. 0% keeps the terminal as clear as the card."
          />
          <Slider
            label="Terminal font size"
            value={terminalFontSize}
            min={9} max={22} step={1}
            format={(v) => `${v}px`}
            onChange={setTerminalFontSize}
            hint="Per-terminal overrides: Ctrl +, Ctrl -, Ctrl 0 to reset."
          />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Reduce motion</div>
              <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 2 }}>
                Shortens layout animations and disables decorative movement.
              </div>
            </div>
            <Toggle checked={reduceMotion} onChange={setReduceMotion} />
          </div>
        </div>
      </div>
    </div>
  );
};

// ── Shortcuts (all configurable + PTT) ────────────────────────────

const ShortcutsSection: React.FC = () => {
  const { shortcuts, setShortcut, pttKey, setPttKey } = useSettingsStore();
  const brand = useThemeStore((s) => s.theme.colors.brand);

  const keyStyle = (combo: string): React.CSSProperties => ({
    fontFamily: "'SF Mono', 'JetBrains Mono', monospace",
    fontSize: 10.5, fontWeight: 600, padding: '2px 7px', borderRadius: 5,
    background: `rgba(244,162,97,0.08)`,
    border: `1px solid rgba(244,162,97,0.20)`,
    color: brand, lineHeight: '18px', whiteSpace: 'nowrap',
  });

  type ShortcutRow = {
    actionId?: string;
    combo: string;
    desc: string;
  };

  const GROUPS: { group: string; items: ShortcutRow[] }[] = [
    {
      group: 'Canvas',
      items: [
        { combo: 'Scroll', desc: 'Zoom centered on cursor' },
        { combo: 'Left-drag', desc: 'Pan canvas' },
        { combo: 'Shift+Drag', desc: 'Quick-pan anywhere' },
        { combo: shortcuts['auto-layout'] || 'Ctrl+L', desc: 'Auto-layout agents', actionId: 'auto-layout' },
        { combo: shortcuts['focus-agent'] || 'Ctrl+K', desc: 'Focus camera on agent', actionId: 'focus-agent' },
        { combo: 'Delete', desc: 'Remove selected elements' },
        { combo: shortcuts['undo'] || 'Ctrl+Z', desc: 'Undo', actionId: 'undo' },
        { combo: shortcuts['redo'] || 'Ctrl+Shift+Z', desc: 'Redo', actionId: 'redo' },
      ],
    },
    {
      group: 'Agent Controls',
      items: [
        { combo: shortcuts['toggle-music'] || 'Ctrl+Shift+M', desc: 'Toggle Music Player', actionId: 'toggle-music' },
        { combo: shortcuts['toggle-browser'] || 'Ctrl+Shift+B', desc: 'Toggle Browser', actionId: 'toggle-browser' },
        { combo: shortcuts['toggle-toolbar'] || 'Ctrl+O', desc: 'Toggle quick-action toolbar', actionId: 'toggle-toolbar' },
        { combo: shortcuts['spawn-agent'] || 'Ctrl+N', desc: 'Spawn new agent', actionId: 'spawn-agent' },
      ],
    },
    {
      group: 'Voice / PTT',
      items: [
        { combo: pttKey || 'Ctrl+E', desc: 'Push-to-talk (hold to record)', actionId: '__ptt__' },
        { combo: shortcuts['toggle-mic'] || 'Ctrl+Shift+E', desc: 'Toggle mic mute', actionId: 'toggle-mic' },
      ],
    },
    {
      group: 'General',
      items: [
        { combo: 'Esc', desc: 'Close settings / dialogs / modals' },
        { combo: shortcuts['open-settings'] || 'Ctrl+,', desc: 'Open settings', actionId: 'open-settings' },
        { combo: shortcuts['toggle-fullscreen'] || 'F11', desc: 'Toggle fullscreen', actionId: 'toggle-fullscreen' },
      ],
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
        gap: 12,
      }}>
        {GROUPS.map((g) => (
          <div
            key={g.group}
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border-dim)',
              borderRadius: 10, padding: '14px 14px 8px',
              backdropFilter: 'none',
            }}
          >
            <div style={{
              fontSize: 9, fontWeight: 700, textTransform: 'uppercase',
              letterSpacing: 1.2, color: 'var(--text-muted)',
              marginBottom: 10, paddingBottom: 8,
              borderBottom: '1px solid var(--border-dim)',
            }}>
              {g.group}
            </div>
            {g.items.map((s, i) => {
              const isPtt = s.actionId === '__ptt__';
              return (
                <div
                  key={i}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '5px 0', opacity: 0.85,
                    transition: 'opacity 0.12s',
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = '1'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = '0.85'; }}
                >
                  <kbd style={keyStyle(s.combo)}>{s.combo}</kbd>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.4, flex: 1 }}>
                    {s.desc}
                  </div>
                  {isPtt ? (
                    <RemapButton current={pttKey || 'Ctrl+E'} onSave={setPttKey} />
                  ) : s.actionId && s.actionId !== '__ptt__' ? (
                    <RemapButton
                      current={shortcuts[s.actionId] || ''}
                      onSave={(combo) => setShortcut(s.actionId!, combo)}
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
};

// ── Agents ────────────────────────────────────────────────────────

/** Folders the user trusted once for an agent type; ORCH answers that
 *  agent's "trust this folder?" prompt there automatically. */
const TrustedFolders: React.FC = () => {
  const [entries, setEntries] = useState<Array<{ providerId: string; folder: string }> | null>(null);
  const refresh = useCallback(() => {
    invoke<Array<{ providerId: string; folder: string }>>('trust_list').then(setEntries).catch(() => setEntries([]));
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  if (!entries || entries.length === 0) return null;
  return (
    <div style={{
      padding: '12px 16px', borderRadius: 'var(--radius-md)',
      background: 'var(--surface)', border: '1px solid var(--border-dim)',
      display: 'flex', flexDirection: 'column', gap: 6,
    }}>
      <div style={{ fontSize: 13, fontWeight: 600 }}>Trusted folders</div>
      <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
        You trusted these once; ORCH answers that agent&apos;s folder-trust prompt there for you.
      </div>
      {entries.map(({ providerId, folder }) => (
        <div key={`${providerId}:${folder}`} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5 }}>
          <span style={{
            fontSize: 9, textTransform: 'uppercase', letterSpacing: 0.8, color: 'var(--text-muted)',
            padding: '1px 6px', border: '1px solid var(--border-dim)', borderRadius: 999, flexShrink: 0,
          }}>{providerId}</span>
          <span title={folder} style={{
            flex: 1, minWidth: 0, fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{folder}</span>
          <button
            onClick={() => { void invoke('trust_forget', { providerId, folder }).then(refresh); }}
            style={{
              padding: '3px 10px', fontSize: 11, borderRadius: 'var(--radius-sm)', cursor: 'pointer',
              border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', fontFamily: 'inherit',
            }}
          >
            Forget
          </button>
        </div>
      ))}
    </div>
  );
};

const AgentsSection: React.FC = () => {
  const { providers } = useSettingsStore();
  const defaultApprovalMode = useSettingsStore((s) => s.defaultApprovalMode);
  const setDefaultApprovalMode = useSettingsStore((s) => s.setDefaultApprovalMode);
  const [installStates, setInstallStates] = useState<Record<string, { phase: string; percent: number; message: string }>>({});
  const [statuses, setStatuses] = useState<Record<string, ProviderStatus>>({});
  const [probed, setProbed] = useState(false);

  useEffect(() => {
    const specs = providers
      .filter((p) => !p.shell)
      .map((p) => ({ id: p.id, name: p.name, command: p.command, args: p.args }));
    if (specs.length) {
      useProviderStore.getState().probeAll(specs).then(() => {
        setStatuses(useProviderStore.getState().statuses);
        setProbed(true);
      }).catch(() => setProbed(true));
    }
  }, [providers]);

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
      await installProvider(p.id);
    } catch (err: any) {
      setInstallStates((prev) => ({ ...prev, [p.id]: { phase: 'error', percent: 0, message: err.message } }));
    }
  };

  const agentProviders = providers.filter((p) => !p.shell);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        padding: '12px 16px', borderRadius: 'var(--radius-md)',
        background: 'var(--surface)', border: '1px solid var(--border-dim)',
      }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Auto-approve new agents</div>
          <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 2 }}>
            Off: agents ask before running tools, and ORCH shows the request on the card and says it aloud.
            Each agent can be switched from its card. Folder trust is asked once per agent type and folder.
          </div>
        </div>
        <Toggle
          checked={defaultApprovalMode === 'auto'}
          onChange={(v) => setDefaultApprovalMode(v ? 'auto' : 'manual')}
        />
      </div>
      <TrustedFolders />
      {agentProviders.map((p) => {
        const status = statuses[p.id];
        const isAvailable = status?.available;
        const install = installStates[p.id];
        const installing = install && (install.phase === 'starting' || install.phase === 'installing');
        const Icon = PROVIDER_ICONS[p.id];

        return (
          <div key={p.id} style={{
            display: 'flex', alignItems: 'center', gap: 12,
            padding: '12px 16px', borderRadius: 'var(--radius-md)',
            background: 'var(--surface)', border: '1px solid var(--border-dim)',
            transition: 'all var(--anim-fast)',
          }}>
            <div style={{
              width: 36, height: 36, borderRadius: 8,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: isAvailable ? 'color-mix(in srgb, var(--brand) 10%, transparent)' : 'var(--surface)',
              color: isAvailable ? 'var(--accent)' : 'var(--text-muted)', flexShrink: 0,
            }}>
              {Icon ? <Icon size={20} /> : <Bot size={18} />}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{p.name}</div>
            </div>
            {installing ? (
              <div style={{ width: 100, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ height: 4, borderRadius: 2, background: 'var(--border-dim)', overflow: 'hidden' }}>
                  <div style={{ height: '100%', borderRadius: 2, width: `${install.percent}%`, background: `linear-gradient(90deg, var(--brand), var(--accent))`, transition: 'width 0.3s ease' }} />
                </div>
              </div>
            ) : isAvailable ? (
              <span style={{ fontSize: 11, color: 'var(--success)', fontWeight: 600, padding: '4px 12px', borderRadius: 'var(--radius-pill)', background: 'color-mix(in srgb, var(--success) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--success) 20%, transparent)' }}>
                Available
              </span>
            ) : install?.phase === 'error' ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 10, color: 'var(--error)', maxWidth: 100, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{install.message}</span>
                <button onClick={() => handleInstall(p)} style={{ padding: '6px 14px', fontSize: 11, fontWeight: 600, borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', cursor: 'pointer', fontFamily: 'inherit' }}>Retry</button>
              </div>
            ) : (
              <button onClick={() => handleInstall(p)} style={{ padding: '6px 14px', fontSize: 11, fontWeight: 600, borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', cursor: 'pointer', fontFamily: 'inherit' }}>Download</button>
            )}
          </div>
        );
      })}
      {probed && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center', padding: '4px 0' }}>
          {agentProviders.filter((p) => statuses[p.id]?.available).length} / {agentProviders.length} available
        </div>
      )}
    </div>
  );
};

// ── API Keys ──────────────────────────────────────────────────────

const KNOWN_PROVIDERS: { key: string; label: string; envVar: string }[] = [
  { key: 'anthropic', label: 'Anthropic', envVar: 'ANTHROPIC_API_KEY' },
  { key: 'openai', label: 'OpenAI', envVar: 'OPENAI_API_KEY' },
  { key: 'google', label: 'Google / Gemini', envVar: 'GOOGLE_API_KEY' },
];

const ApiKeysSection: React.FC = () => {
  const { apiKeys, setApiKey, removeApiKey } = useSettingsStore();
  const [provider, setProvider] = useState('');
  const [value, setValue] = useState('');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {KNOWN_PROVIDERS.map((kp) => {
          const stored = apiKeys.find((k) => k.provider === kp.key);
          return (
            <div key={kp.key} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '10px 14px', borderRadius: 'var(--radius-md)',
              background: 'var(--surface)', border: '1px solid var(--border-dim)',
            }}>
              <div style={{ minWidth: 130 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{kp.label}</div>
                <div style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', marginTop: 1 }}>{kp.envVar}</div>
              </div>
              <input className="glass-input" type="password"
                value={stored?.key || ''}
                onChange={(e) => { if (e.target.value) setApiKey(kp.key, e.target.value); else removeApiKey(kp.key); }}
                placeholder={stored ? '••••••••' : `Enter ${kp.envVar}…`}
                style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 12 }}
              />
              {stored && <Pill tone="amber">saved</Pill>}
            </div>
          );
        })}
      </div>

      {/* custom keys */}
      {apiKeys.filter((k) => !KNOWN_PROVIDERS.some((kp) => kp.key === k.provider)).length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {apiKeys.filter((k) => !KNOWN_PROVIDERS.some((kp) => kp.key === k.provider)).map((k) => (
            <div key={k.provider} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '10px 14px', borderRadius: 'var(--radius-md)',
              background: 'var(--surface)', border: '1px solid var(--border-dim)',
            }}>
              <Pill tone="amber">{k.provider}</Pill>
              <span style={{ fontSize: 12, color: 'var(--text-muted)', flex: 1, fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {k.key.slice(0, 12)}••••{k.key.slice(-4)}
              </span>
              <button onClick={() => removeApiKey(k.provider)}
                style={{ padding: '3px 10px', fontSize: 11, color: 'var(--error)', background: 'transparent', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontFamily: 'inherit' }}>
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* add custom */}
      <div style={{
        padding: 12, borderRadius: 'var(--radius-md)',
        background: 'var(--surface)', border: '1px solid var(--border-dim)',
        display: 'flex', gap: 8, alignItems: 'center',
      }}>
        <input className="glass-input" value={provider}
          onChange={(e) => setProvider(e.target.value)}
          placeholder="provider (groq, cohere…)"
          style={{ width: 160 }}
        />
        <input className="glass-input" value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="sk-…" type="password" style={{ flex: 1 }}
        />
        <button onClick={() => { if (provider && value) { setApiKey(provider, value); setProvider(''); setValue(''); } }}
          style={{
            padding: '8px 18px', fontSize: 12, fontWeight: 600,
            background: 'var(--accent)', color: 'var(--bg)', border: 'none',
            borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontFamily: 'inherit',
          }}>
          Add
        </button>
      </div>
    </div>
  );
};

// ── MCP ────────────────────────────────────────────────────────────

const McpSection: React.FC = () => {
  const { mcpServers, addMcpServer, removeMcpServer, toggleMcpServer } = useSettingsStore();
  const [name, setName] = useState('');
  const [cmd, setCmd] = useState('');
  const [orchUrl, setOrchUrl] = useState<string | null>(null);

  useEffect(() => { getMcpUrl().then(setOrchUrl).catch(() => {}); }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {orchUrl && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: 12, borderRadius: 'var(--radius-md)',
          background: 'var(--surface)', border: '1px solid var(--border-dim)',
        }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--success)', flexShrink: 0, boxShadow: '0 0 6px rgba(107,191,138,0.5)' }} />
          <span style={{ fontSize: 13, fontWeight: 600 }}>ORCH MCP Server</span>
          <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', marginLeft: 'auto' }}>{orchUrl}</span>
          <Pill tone="amber">built-in</Pill>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {mcpServers.length === 0 && (
          <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: 14, textAlign: 'center' }}>
            No MCP servers configured.
          </div>
        )}
        {mcpServers.map((s) => (
          <div key={s.id} style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '10px 14px', borderRadius: 'var(--radius-md)',
            background: 'var(--surface)', border: '1px solid var(--border-dim)',
          }}>
            <span className={`status-dot ${s.enabled ? 'active' : 'idle'}`} />
            <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>{s.name}</span>
            <Pill tone="dim">{s.type}</Pill>
            <button onClick={() => toggleMcpServer(s.id)}
              style={{ padding: '3px 10px', fontSize: 11, background: 'transparent', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text)', cursor: 'pointer', fontFamily: 'inherit' }}>
              {s.enabled ? 'Disable' : 'Enable'}
            </button>
            <button onClick={() => removeMcpServer(s.id)}
              style={{ padding: '3px 10px', fontSize: 11, color: 'var(--error)', background: 'transparent', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontFamily: 'inherit' }}>
              <X size={14} />
            </button>
          </div>
        ))}
      </div>

      <div style={{
        padding: 12, borderRadius: 'var(--radius-md)',
        background: 'var(--surface)', border: '1px solid var(--border-dim)',
        display: 'flex', gap: 8, alignItems: 'center',
      }}>
        <input className="glass-input" value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Server name" style={{ width: 160 }}
        />
        <input className="glass-input" value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          placeholder="command or URL" style={{ flex: 1 }}
        />
        <button onClick={() => {
          if (name && cmd) {
            addMcpServer({
              id: crypto.randomUUID(), name,
              type: cmd.startsWith('http') ? 'sse' : 'stdio',
              command: cmd.startsWith('http') ? undefined : cmd,
              url: cmd.startsWith('http') ? cmd : undefined,
              enabled: true,
            });
            setName(''); setCmd('');
          }
        }}
          style={{
            padding: '8px 18px', fontSize: 12, fontWeight: 600,
            background: 'var(--accent)', color: 'var(--bg)', border: 'none',
            borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontFamily: 'inherit',
          }}>
          Add
        </button>
      </div>
    </div>
  );
};

// ── Audio ─────────────────────────────────────────────────────────

const AudioSection: React.FC = () => {
  const audioInputDeviceId = useSettingsStore((s) => s.audioInputDeviceId);
  const setAudioInputDevice = useSettingsStore((s) => s.setAudioInputDevice);
  const groqApiKey = useSettingsStore((s) => s.groqApiKey);
  const setGroqApiKey = useSettingsStore((s) => s.setGroqApiKey);
  const enableGroqOnSTTFailure = useSettingsStore((s) => s.enableGroqOnSTTFailure);
  const setGroqOnSTTFailure = useSettingsStore((s) => s.setGroqOnSTTFailure);
  const instantStart = useSettingsStore((s) => s.instantStart);
  const setInstantStart = useSettingsStore((s) => s.setInstantStart);
  const voiceId = useSettingsStore((s) => s.voiceId);
  const setVoiceId = useSettingsStore((s) => s.setVoiceId);
  const voiceSpeed = useSettingsStore((s) => s.voiceSpeed);
  const setVoiceSpeed = useSettingsStore((s) => s.setVoiceSpeed);
  const voiceVolume = useSettingsStore((s) => s.voiceVolume);
  const setVoiceVolume = useSettingsStore((s) => s.setVoiceVolume);
  const speakLifecycle = useSettingsStore((s) => s.speakLifecycle);
  const setSpeakLifecycle = useSettingsStore((s) => s.setSpeakLifecycle);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [previewing, setPreviewing] = useState(false);
  const [modelStatus, setModelStatus] = useState<VoiceModelStatus | null>(null);
  const groqKey = groqApiKey || '';
  const enableGroq = enableGroqOnSTTFailure || false;

  useEffect(() => {
    navigator.mediaDevices?.enumerateDevices().then((all) => {
      setDevices(all.filter((d) => d.kind === 'audioinput'));
    }).catch(() => {});
  }, []);

  // Push voice settings to the Python sidecar. Without this the controls
  // would only change local state and the assistant would keep using the
  // defaults it booted with.
  useEffect(() => {
    voiceConfigure(voiceId, voiceSpeed).catch(() => {});
  }, [voiceId, voiceSpeed]);

  const previewVoice = useCallback(async () => {
    setPreviewing(true);
    try {
      await voiceSpeak('preview', 'Max is spinning up. Sky and Zed are ready.');
    } catch { /* sidecar not running */ }
    setTimeout(() => setPreviewing(false), 2500);
  }, []);

  // Poll voice model status every 3s
  useEffect(() => {
    const poll = () => {
      voiceModelStatus().then(setModelStatus).catch(() => {});
    };
    poll();
    const id = setInterval(poll, 3000);
    return () => clearInterval(id);
  }, []);

  const ModelRow: React.FC<{ name: string; ok: boolean; detail?: string }> = ({ name, ok, detail }) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0' }}>
      <span className={`status-dot ${ok ? 'active' : 'idle'}`} />
      <span style={{ fontSize: 12, fontWeight: 600 }}>{name}</span>
      <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 'auto' }}>
        {ok ? 'Ready' : detail || 'Not found'}
      </span>
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* device select */}
      <div style={glassCard}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <select value={audioInputDeviceId} onChange={(e) => setAudioInputDevice(e.target.value)}
            className="glass-input"
            style={{ width: '100%', padding: '10px 32px 10px 12px', fontSize: 13, fontFamily: "'JetBrains Mono', 'Cascadia Code', monospace", cursor: 'pointer' }}>
            <option value="">System Default</option>
            {devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>{d.label || `Mic ${d.deviceId.slice(0, 8)}…`}</option>
            ))}
          </select>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, borderTop: '1px solid var(--border-dim)', paddingTop: 10 }}>
          <span className={`status-dot ${devices.length > 0 ? 'active' : 'idle'}`} />
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {devices.length > 0 ? `${devices.length} input device${devices.length !== 1 ? 's' : ''} available` : 'No devices — grant mic access'}
          </span>
        </div>
      </div>

      {/* Speech output */}
      <div>
        <SectionHeader>Speech</SectionHeader>
        <div style={{ ...glassCard, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label htmlFor="voice-id" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Voice</label>
            <select
              id="voice-id"
              value={voiceId}
              onChange={(e) => setVoiceId(e.target.value)}
              style={{
                padding: '8px 10px', borderRadius: 'var(--radius-sm)',
                background: 'var(--surface)', border: '1px solid var(--border)',
                color: 'var(--text)', fontSize: 12, fontFamily: 'inherit', outline: 'none',
              }}
            >
              {/* Kokoro's bundled voice set. */}
              <optgroup label="American English">
                <option value="af_bella">Bella (warm)</option>
                <option value="af_nicole">Nicole (soft)</option>
                <option value="af_sarah">Sarah (neutral)</option>
                <option value="af_sky">Sky (bright)</option>
                <option value="am_adam">Adam</option>
                <option value="am_michael">Michael</option>
              </optgroup>
              <optgroup label="British English">
                <option value="bf_emma">Emma</option>
                <option value="bf_isabella">Isabella</option>
                <option value="bm_george">George</option>
                <option value="bm_lewis">Lewis</option>
              </optgroup>
            </select>
          </div>

          <Slider
            label="Speech volume"
            value={Math.round(voiceVolume * 100)}
            min={0} max={100} step={5}
            format={(v) => (v === 0 ? 'Muted' : `${v}%`)}
            onChange={(v) => setVoiceVolume(v / 100)}
            hint="Applies immediately, including to speech already playing."
          />

          <Slider
            label="Speech rate"
            value={voiceSpeed}
            min={0.6} max={1.8} step={0.05}
            format={(v) => `${v.toFixed(2)}×`}
            onChange={setVoiceSpeed}
            hint="Applies to the next thing ORCH says."
          />

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Announce agents by name</div>
              <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 2 }}>
                Say "Max is spinning up" when agents start and stop.
              </div>
            </div>
            <Toggle checked={speakLifecycle} onChange={setSpeakLifecycle} />
          </div>

          <button
            onClick={previewVoice}
            disabled={previewing}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              padding: '9px 14px', borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border)', background: 'var(--glass-bg)',
              color: 'var(--text)', fontSize: 12, fontFamily: 'inherit',
              cursor: previewing ? 'default' : 'pointer', opacity: previewing ? 0.6 : 1,
            }}
          >
            <Volume2 size={13} />
            {previewing ? 'Speaking…' : 'Preview voice'}
          </button>
        </div>
      </div>

      {/* Instant Start */}
      <div style={glassCard}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700 }}>Instant Start</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>Keep mic warmed up between captures</div>
          </div>
          <div onClick={() => setInstantStart(!instantStart)}
            style={{
              position: 'relative', width: 42, height: 24, flexShrink: 0,
              borderRadius: 12, cursor: 'pointer',
              background: instantStart ? `linear-gradient(135deg, var(--brand), var(--accent-dim))` : 'var(--surface)',
              transition: 'all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)',
              boxShadow: instantStart ? `0 0 12px color-mix(in srgb, var(--brand) 35%, transparent)` : 'none',
            }}>
            <div style={{
              position: 'absolute', top: 2, left: instantStart ? 20 : 2,
              width: 20, height: 20, borderRadius: '50%',
              background: instantStart ? '#fff' : 'var(--text-muted)',
              transition: 'all 0.35s cubic-bezier(0.34, 1.56, 0.64, 1)',
              boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
            }} />
          </div>
        </div>
      </div>

      {/* Voice Models status */}
      <div style={glassCard}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: modelStatus?.serverRunning ? 'var(--accent)' : 'var(--text-muted)' }}>
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <line x1="12" y1="19" x2="12" y2="23" />
            <line x1="8" y1="23" x2="16" y2="23" />
          </svg>
          Voice Models (V3 · TDT)
          <span style={{ fontSize: 10, marginLeft: 'auto', color: 'var(--text-muted)', fontWeight: 400 }}>
            {modelStatus?.serverRunning ? 'Server running' : 'Server stopped'}
            <span className={`status-dot ${modelStatus?.serverRunning ? 'active' : 'idle'}`} style={{ marginLeft: 6 }} />
          </span>
        </div>
        <div style={{ borderTop: '1px solid var(--border-dim)', paddingTop: 4 }}>
          <ModelRow name="Parakeet TDT V3 (STT)" ok={modelStatus?.models.parakeet.present ?? false} detail="Downloads on first launch" />
          <ModelRow name="Kokoro (TTS · ONNX)" ok={modelStatus?.models.kokoro.present ?? false} detail="Downloads on first voice capture" />
          <ModelRow name="Whisper (STT · fallback)" ok={modelStatus?.models.whisper.present ?? false} detail="Cached by faster-whisper" />
        </div>
      </div>

      {/* Groq STT fallback */}
      <div style={{ borderTop: '1px solid var(--border-dim)', paddingTop: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--accent)' }}>
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
          </svg>
          Groq STT Fallback
        </div>
        <div style={glassCard}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type={groqKey ? 'password' : 'text'} value={groqKey}
                onChange={(e) => setGroqApiKey(e.target.value)}
                placeholder="gsk_…" className="glass-input"
                style={{ flex: 1, padding: '10px 12px', fontSize: 13, fontFamily: "'JetBrains Mono', monospace" }}
              />
              {groqKey && (
                <button onClick={() => setGroqApiKey('')}
                  style={{ width: 36, height: 36, padding: 0, fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: '1px solid rgba(231,111,81,0.3)', borderRadius: 'var(--radius-sm)', color: 'var(--error)', cursor: 'pointer' }}>
                  ✕
                </button>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <input type="checkbox" checked={enableGroq}
                onChange={(e) => setGroqOnSTTFailure(e.target.checked)}
                style={{ accentColor: 'var(--accent)', width: 16, height: 16, cursor: 'pointer' }}
              />
              <label style={{ fontSize: 11, color: 'var(--text-secondary)', cursor: 'pointer', userSelect: 'none' }}>
                Fallback to Groq when local STT fails
              </label>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

// ── Account ───────────────────────────────────────────────────────

const AccountSection: React.FC = () => {
  const { user, status, login, logout } = useAuthStore();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const isAuthed = status === 'authenticated' && !!user;

  const handleLogin = async () => {
    setError('');
    const { error: err } = await login(email, password);
    if (err) setError(err || 'Login failed');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {isAuthed ? (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12, padding: 16,
          borderRadius: 'var(--radius-md)', background: 'var(--surface)', border: '1px solid var(--border-dim)',
        }}>
          <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, fontWeight: 700, color: 'var(--bg)', flexShrink: 0 }}>
            {(user.email || '?').charAt(0).toUpperCase()}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>{user.email}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Supabase</div>
          </div>
          <button onClick={logout} style={{ padding: '10px 20px', fontSize: 12, fontWeight: 600, color: 'var(--error)', background: 'transparent', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontFamily: 'inherit' }}>Sign Out</button>
        </div>
      ) : (
        <div style={{ padding: 16, borderRadius: 'var(--radius-md)', background: 'var(--surface)', border: '1px solid var(--border-dim)' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <input className="glass-input" type="email" value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email" style={{ padding: '10px 14px', fontSize: 13, borderRadius: 'var(--radius-sm)' }}
            />
            <input className="glass-input" type="password" value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password" style={{ padding: '10px 14px', fontSize: 13, borderRadius: 'var(--radius-sm)' }}
              onKeyDown={(e) => { if (e.key === 'Enter') handleLogin(); }}
            />
            {error && <div style={{ fontSize: 11, color: 'var(--error)' }}>{error}</div>}
            <button onClick={handleLogin} disabled={status === 'loading'}
              style={{ padding: '10px 0', borderRadius: 'var(--radius-sm)', border: 'none', background: 'var(--accent)', color: 'var(--bg)', fontSize: 13, fontWeight: 700, cursor: status === 'loading' ? 'wait' : 'pointer', fontFamily: 'inherit' }}>
              {status === 'loading' ? 'Signing in…' : 'Sign In'}
            </button>
          </div>
        </div>
      )}

      {/* SoundCloud */}
      <div style={{ borderTop: '1px solid var(--border-dim)', paddingTop: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="#FF7700"><path d="M11.56 8.87V17h8.47a1.85 1.85 0 0 0 0-3.7 1.82 1.82 0 0 0-.42.05 3.49 3.49 0 0 0-3.36-4.14 3.56 3.56 0 0 0-1.16.2 4.55 4.55 0 0 0-3.53-2.09z"/><path d="M8.74 10.24V17h1.57V9.49a2.05 2.05 0 0 0-1.57.75zM5.75 11.37V17h1.57v-5.62a3.1 3.1 0 0 0-1.57 0zM2.82 12.74V17h1.57v-4.46a2.44 2.44 0 0 0-1.57.2zM0 14.42V17h1.57v-2.93a2.1 2.1 0 0 0-1.57.35z"/></svg>
          SoundCloud
        </div>
        <SoundCloudSection />
      </div>
    </div>
  );
};

const SoundCloudSection: React.FC = () => {
  const { scToken, scUser, setScToken, setScUser, clearScAuth } = useMusicPlayerStore();
  const [loading, setLoading] = useState(false);
  const [showAuth, setShowAuth] = useState(false);

  if (scUser) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 14, borderRadius: 'var(--radius-md)', background: 'var(--surface)', border: '1px solid var(--border-dim)' }}>
        <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'color-mix(in srgb, var(--brand) 12%, transparent)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 700, color: 'var(--brand)', flexShrink: 0, overflow: 'hidden' }}>
          {scUser.avatar ? <img src={scUser.avatar} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : scUser.username.charAt(0).toUpperCase()}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{scUser.username}</div>
        </div>
        <button onClick={clearScAuth} style={{ padding: '6px 14px', fontSize: 11, color: 'var(--error)', fontWeight: 600, background: 'transparent', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontFamily: 'inherit' }}>Disconnect</button>
      </div>
    );
  }

  return (
    <div style={{ padding: 14, borderRadius: 'var(--radius-md)', background: 'var(--surface)', border: '1px solid var(--border-dim)' }}>
      {showAuth ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <input className="glass-input" value={scToken} onChange={(e) => setScToken(e.target.value)}
            placeholder="Paste SoundCloud OAuth token…"
            style={{ padding: '10px 14px', fontSize: 12, fontFamily: "'JetBrains Mono', monospace", borderRadius: 'var(--radius-sm)' }}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => setShowAuth(false)} style={{ padding: '8px 16px', fontSize: 12, flex: 1, background: 'transparent', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text)', cursor: 'pointer', fontFamily: 'inherit' }}>Cancel</button>
            {scToken && (
              <button onClick={async () => {
                setLoading(true);
                try {
                  const { musicScUser } = await import('../lib/electron-api');
                  const result = await musicScUser(scToken);
                  if (result.success && result.data) setScUser(result.data);
                } catch {}
                setLoading(false);
              }} disabled={loading}
                style={{ padding: '8px 16px', fontSize: 12, fontWeight: 600, flex: 1, borderRadius: 'var(--radius-sm)', border: 'none', background: 'var(--accent)', color: 'var(--bg)', cursor: loading ? 'wait' : 'pointer', fontFamily: 'inherit' }}>
                {loading ? 'Verifying…' : 'Connect'}
              </button>
            )}
          </div>
        </div>
      ) : (
        <button onClick={() => setShowAuth(true)} style={{ padding: '8px 16px', fontSize: 12, fontWeight: 600, borderRadius: 'var(--radius-sm)', border: '1px solid var(--brand)', background: 'color-mix(in srgb, var(--brand) 8%, transparent)', color: 'var(--brand)', cursor: 'pointer', fontFamily: 'inherit' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M13.5 12H3"/></svg>
            Link SoundCloud
          </span>
        </button>
      )}
    </div>
  );
};

// ── Root dialog ───────────────────────────────────────────────────

const SECTIONS: { id: Section; label: string; icon: React.ComponentType<{ size?: number }> }[] = [
  { id: 'shortcuts', label: 'Shortcuts', icon: Keyboard },
  { id: 'style',     label: 'Style',     icon: Palette },
  { id: 'canvas',    label: 'Canvas',    icon: Layout },
  { id: 'audio',     label: 'Audio',     icon: Mic },
  { id: 'agents',    label: 'Agents',    icon: Bot },
  { id: 'apis',      label: 'API Keys',  icon: Key },
  { id: 'mcp',       label: 'MCP',       icon: Plug },
  { id: 'account',   label: 'Account',   icon: User },
];

const SECTION_TITLES: Record<Section, string> = {
  shortcuts: 'Shortcuts',
  style:     'Style',
  canvas:    'Canvas',
  audio:     'Audio',
  agents:    'Agents',
  apis:      'API Keys',
  mcp:       'MCP',
  account:   'Account',
};

export const SettingsDialog: React.FC<SettingsDialogProps> = ({ onClose }) => {
  const [section, setSection] = useState<Section>('shortcuts');
  const { providers } = useSettingsStore();
  const probed = useRef(false);

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
        position: 'fixed', inset: 0, zIndex: Z_BASE_LAYERS.modal,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.6)',
        animation: 'fadeIn var(--anim-normal) ease',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <GlassPanel
        className="animate-scale-in"
        style={{
          width: 880, maxWidth: 'calc(100vw - 32px)',
          height: 640, maxHeight: '85vh',
          padding: 0, overflow: 'hidden',
          display: 'flex', borderRadius: 'var(--radius-xl)',
          boxShadow: 'var(--shadow-xl)',
        }}
      >
        {/* sidebar */}
        <div style={{
          width: 200, flexShrink: 0, background: 'var(--bg-alt)',
          borderRight: '1px solid var(--border)',
          display: 'flex', flexDirection: 'column',
          padding: '20px 12px', gap: 4,
        }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1.4, textTransform: 'uppercase', color: 'var(--text-muted)', padding: '4px 12px 12px' }}>
            Settings
          </div>
          {SECTIONS.map((s) => {
            const active = section === s.id;
            return (
              <button key={s.id} onClick={() => setSection(s.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '8px 12px', borderRadius: 'var(--radius-md)',
                  background: active ? 'var(--accent)' : 'transparent',
                  color: active ? 'var(--bg)' : 'var(--text-secondary)',
                  border: 'none', cursor: 'pointer', textAlign: 'left',
                  fontFamily: 'inherit', fontSize: 13, fontWeight: 600,
                  transition: 'all var(--anim-fast)',
                }}
                onMouseEnter={(e) => { if (!active) (e.currentTarget as HTMLElement).style.background = 'var(--glass-hover)'; }}
                onMouseLeave={(e) => { if (!active) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
              >
                <span style={{ width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', color: active ? 'var(--bg)' : 'var(--accent)' }}>
                  {React.createElement(s.icon, { size: 16 })}
                </span>
                <span style={{ flex: 1 }}>{s.label}</span>
              </button>
            );
          })}
          <div style={{ flex: 1 }} />
          {/* ── App version badge ──────────────────────────── */}
          <div style={{
            padding: '12px 12px 4px',
            borderTop: '1px solid var(--border-dim)',
          }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6,
              fontSize: 9, fontWeight: 600, letterSpacing: 0.8,
              color: 'var(--text-muted)', opacity: 0.5,
              fontFamily: 'var(--font-mono)',
            }}>
              <span style={{
                width: 5, height: 5, borderRadius: '50%',
                background: 'var(--accent)', opacity: 0.4,
              }} />
              v{__APP_VERSION__}
            </div>
          </div>
        </div>

        {/* main content */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, background: 'var(--bg)' }}>
          {/* header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '20px 28px 16px', borderBottom: '1px solid var(--border-dim)' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 22, fontWeight: 800, lineHeight: 1.1 }}>{SECTION_TITLES[section]}</div>
            </div>
            <button onClick={onClose}
              style={{ width: 30, height: 30, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, color: 'var(--text-secondary)', borderRadius: '50%', background: 'transparent', border: '1px solid var(--border)', cursor: 'pointer' }}
              title="Close (Esc)">
              <X size={14} />
            </button>
          </div>

          {/* body */}
          <div style={{ flex: 1, overflow: 'auto', padding: '24px 28px 28px' }}>
            {section === 'shortcuts' && <ShortcutsSection />}
            {section === 'style' && <StyleSection />}
            {section === 'canvas' && <CanvasSection />}
            {section === 'audio' && <AudioSection />}
            {section === 'agents' && <AgentsSection />}
            {section === 'apis' && <ApiKeysSection />}
            {section === 'mcp' && <McpSection />}
            {section === 'account' && <AccountSection />}
          </div>
        </div>
      </GlassPanel>
    </div>
  );
};
