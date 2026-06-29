import React, { useState, useRef, useEffect } from 'react';
import { useAppStore } from '../stores/useAppStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { useTerminalStore } from '../stores/useTerminalStore';
import { useWorkspaceStore } from '../stores/useWorkspaceStore';
import { PROVIDER_ICONS } from './icons/ProviderIcon';
import { AppLogo } from './icons/AppLogo';
import { Settings, X, Maximize2, Minimize2, FolderOpen, ChevronDown, RotateCcw, Hammer } from 'lucide-react';
import { pickAgentName } from '../lib/agent-names';
import { getMcpUrl } from '../lib/electron-api';
import { Z_BASE_LAYERS } from '../lib/z-stack-manager';

// Premium thin plus
const PlusIcon: React.FC<{ size?: number }> = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

export interface PillBarProps {
  onOpenSettings: () => void;
  onOpenWorkspace: () => void;
  onOpenAuth: () => void;
}

const AGENT_COLORS = ['#F4A261', '#4EA8DE', '#6BBF8A', '#E76F51', '#B48BC9', '#F4C97A', '#7BC9C9', '#EAF4F4'];
const AGENT_ROLES = ['Developer', 'Terminal', 'File System', 'Debugger', 'Compiler', 'Network', 'Database', 'Observer'];

const btnStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  borderRadius: 9999,
  color: 'var(--text)',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  transition: 'background 150ms ease',
  fontFamily: 'inherit',
  fontSize: 'inherit',
};

export const PillBar: React.FC<PillBarProps> = ({ onOpenSettings, onOpenWorkspace, onOpenAuth }) => {
  const agents = useAppStore((s) => s.agents);
  const addAgent = useAppStore((s) => s.addAgent);
  const providers = useSettingsStore((s) => s.providers);
  const getApiKey = useSettingsStore((s) => s.getApiKey);
  const createTerminal = useTerminalStore((s) => s.createTerminal);
  const wsName = useWorkspaceStore((s) => s.currentWorkspaceName);
  const wsPath = useWorkspaceStore((s) => s.currentWorkspacePath);
  const isDirty = useWorkspaceStore((s) => s.isDirty);
  const recentWorkspaces = useWorkspaceStore((s) => s.recentWorkspaces);
  const openWorkspace = useWorkspaceStore((s) => s.openWorkspace);
  const [showDropdown, setShowDropdown] = useState(false);
  const [showWsDropdown, setShowWsDropdown] = useState(false);
  const [creating, setCreating] = useState<string | null>(null);
  const [mcpUrl, setMcpUrl] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(() => !!document.fullscreenElement);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const wsDropdownRef = useRef<HTMLDivElement>(null);

  // Fetch MCP server URL on mount
  useEffect(() => {
    getMcpUrl().then(setMcpUrl).catch(() => {});
  }, []);

  // Fullscreen change listener
  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      document.documentElement.requestFullscreen();
    }
  };

  // close dropdown on click outside
  useEffect(() => {
    if (!showDropdown) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showDropdown]);

  // close workspace dropdown on click outside
  useEffect(() => {
    if (!showWsDropdown) return;
    const handler = (e: MouseEvent) => {
      if (wsDropdownRef.current && !wsDropdownRef.current.contains(e.target as Node)) {
        setShowWsDropdown(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showWsDropdown]);

  const handleCreate = async (providerId: string) => {
    setCreating(providerId);
    const provider = providers.find((p) => p.id === providerId);
    if (!provider) { setCreating(null); return; }

    const color = AGENT_COLORS[Math.floor(Math.random() * AGENT_COLORS.length)];
    const role = AGENT_ROLES[Math.floor(Math.random() * AGENT_ROLES.length)];
    const { agents } = useAppStore.getState();
    const name = `${pickAgentName(agents.map(a => a.name))} - ${provider.name}`;

    const env: Record<string, string> = {};
    if (provider.envKey) {
      const key = getApiKey(provider.envKey);
      if (key) {
        const varName = provider.envKey === 'anthropic' ? 'ANTHROPIC_API_KEY'
          : provider.envKey === 'openai' ? 'OPENAI_API_KEY'
          : provider.envKey === 'google' ? 'GOOGLE_API_KEY'
          : `${provider.envKey.toUpperCase()}_API_KEY`;
        env[varName] = key;
      }
    }

    const launchMode = provider.launchMode ?? 'embedded';
    const kind = provider.shell === false ? 'cli' : 'shell';

    try {
      let termId: string | null = null;

      if (launchMode === 'embedded') {
        // ── Local node-pty session ──
        termId = await createTerminal(
          name,
          `${name} Terminal`,
          provider.command,
          provider.args,
          Object.keys(env).length > 0 ? env : undefined,
          kind,
          providerId,
        );
      }

      const store = useAppStore.getState();
      const { agents } = store;
      // Spawn at the layout engine's computed position
      const pos = useWorkspaceStore.getState().spawnPosition();
      const x = pos.x;
      const y = pos.y;

      const newAgent = {
        id: crypto.randomUUID(),
        name,
        role,
        status: 'idle' as const,
        terminalId: termId || undefined,
        provider: providerId,
        x,
        y,
        color,
      };

      await addAgent(newAgent);

      setShowDropdown(false);
    } catch (err) {
      console.error('Agent creation failed:', err);
    }
    setCreating(null);
  };

  return (
    <div
      data-chrome="pill-bar"
      style={{
        position: 'fixed',
        top: 26,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: Z_BASE_LAYERS.pillBar,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 8,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          padding: '3px 6px',
          borderRadius: 9999,
          boxShadow: '0 8px 32px rgba(0,0,0,0.35)',
          background: '#222524',
        }}
      >
        {/* Logo — ORCH hex mark */}
        <div style={{
          width: 28, height: 28,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--brand)',
          filter: 'drop-shadow(0 0 4px color-mix(in srgb, var(--brand) 40%, transparent))',
        }}>
          <AppLogo className="w-5 h-5" />
        </div>

        {/* Workspace — dropdown */}
        <div ref={wsDropdownRef} style={{ position: 'relative' }}>
          <button
            onClick={() => setShowWsDropdown(!showWsDropdown)}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            style={{
              ...btnStyle,
              padding: '4px 10px',
              gap: 6,
              fontSize: 12,
              fontWeight: 500,
              maxWidth: 180,
            }}
            title={wsPath || 'No workspace — click to create or open one'}
          >
            <FolderOpen size={12} style={{ flexShrink: 0, color: wsPath ? 'var(--brand)' : 'var(--text-muted)' }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {wsName || 'Workspace'}
            </span>
            {isDirty && (
              <span style={{
                width: 5, height: 5, borderRadius: '50%',
                background: 'var(--brand)',
                flexShrink: 0,
              }} />
            )}
            <ChevronDown size={10} style={{ flexShrink: 0, opacity: 0.5, transition: 'transform 150ms ease', transform: showWsDropdown ? 'rotate(180deg)' : 'rotate(0deg)' }} />
          </button>

          {showWsDropdown && (
            <div
              className="animate-fade-in"
              style={{
                position: 'absolute', top: 'calc(100% + 6px)',
                left: '50%', transform: 'translateX(-50%)',
                minWidth: 220, padding: 6,
                borderRadius: 'var(--radius-lg)',
                zIndex: Z_BASE_LAYERS.dropdown,
                background: 'var(--menu-bg)',
                border: '1px solid var(--border-dim)',
                boxShadow: '0 8px 32px rgba(0,0,0,0.35)',
              }}
            >
              {recentWorkspaces.length > 0 ? (
                <>
                  <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--text-muted)', padding: '6px 10px 4px' }}>
                    Recent
                  </div>
                  {recentWorkspaces.slice(0, 5).map((ws) => {
                    const active = ws.path === wsPath;
                    return (
                      <button
                        key={ws.path}
                        onClick={() => {
                          if (!active) openWorkspace(ws.path);
                          setShowWsDropdown(false);
                        }}
                        disabled={active}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 10,
                          width: '100%', padding: '8px 10px',
                          borderRadius: 'var(--radius-md)',
                          background: active ? 'color-mix(in srgb, var(--brand) 10%, transparent)' : 'transparent',
                          border: 'none',
                          color: active ? 'var(--accent)' : 'var(--text)',
                          cursor: active ? 'default' : 'pointer',
                          fontSize: 12, fontWeight: 500,
                          textAlign: 'left',
                          fontFamily: 'inherit',
                          transition: 'background var(--anim-fast)',
                        }}
                        onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'color-mix(in srgb, var(--brand) 12%, transparent)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = active ? 'color-mix(in srgb, var(--brand) 10%, transparent)' : 'transparent'; }}
                      >
                        <FolderOpen size={13} style={{ flexShrink: 0, opacity: 0.6 }} />
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                          {ws.name}
                        </span>
                        {active && <span style={{ fontSize: 9, color: 'var(--accent)', fontWeight: 700 }}>✓</span>}
                      </button>
                    );
                  })}
                </>
              ) : (
                <div style={{ fontSize: 11, color: 'var(--text-muted)', padding: '10px', textAlign: 'center' }}>
                  No recent workspaces
                </div>
              )}
              <div style={{ height: 1, background: 'var(--border-dim)', margin: '4px 0' }} />
              <button
                onClick={() => { onOpenWorkspace(); setShowWsDropdown(false); }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  width: '100%', padding: '8px 10px',
                  borderRadius: 'var(--radius-md)',
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--brand)',
                  cursor: 'pointer',
                  fontSize: 12, fontWeight: 600,
                  textAlign: 'left',
                  fontFamily: 'inherit',
                  transition: 'background var(--anim-fast)',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'color-mix(in srgb, var(--brand) 12%, transparent)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                <RotateCcw size={13} />
                Open / Create Workspace…
              </button>
            </div>
          )}
        </div>
        {/* Agent count */}
        <div
          style={{
            padding: '4px 10px', fontSize: 12,
            fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6,
            whiteSpace: 'nowrap',
          }}
        >
          <span className={`status-dot ${agents.length > 0 ? 'active' : 'idle'}`} />
          <span>{agents.length}</span>
        </div>

        {/* + New — borderless action trigger */}
        <div ref={dropdownRef} style={{ position: 'relative' }}>
          <button
            onClick={() => setShowDropdown(!showDropdown)}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'color-mix(in srgb, var(--brand) 12%, transparent)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            style={{
              ...btnStyle,
              padding: '4px 12px',
              fontWeight: 700, fontSize: 12,
              gap: 4,
              color: 'var(--brand)',
              fontFamily: 'var(--font-accent)',
            }}
          >
            <PlusIcon /> New
          </button>

          {showDropdown && (
            <div
              className="animate-fade-in"
              style={{
                position: 'absolute', top: 'calc(100% + 6px)',
                left: '50%', transform: 'translateX(-50%)',
                minWidth: 200, padding: 6,
                borderRadius: 'var(--radius-lg)',
                zIndex: Z_BASE_LAYERS.dropdown,
                background: 'var(--menu-bg)',
                border: '1px solid var(--border-dim)',
                boxShadow: '0 8px 32px rgba(0,0,0,0.35)',
              }}
            >
              {providers.filter((p) => p.id !== 'cmd' && p.id !== 'bash' && p.id !== 'wsl').map((p) => {
                const isCreating = creating === p.id;
                return (
                  <button
                    key={p.id}
                    onClick={() => handleCreate(p.id)}
                    disabled={isCreating}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      width: '100%', padding: '10px 12px',
                      borderRadius: 'var(--radius-md)',
                      background: 'transparent',
                      border: 'none',
                      color: isCreating ? 'var(--text-muted)' : 'var(--text)',
                      cursor: isCreating ? 'wait' : 'pointer',
                      fontSize: 13, fontWeight: 500,
                      textAlign: 'left',
                      fontFamily: 'inherit',
                      transition: 'background var(--anim-fast)',
                    }}
                    onMouseEnter={(e) => { if (!isCreating) e.currentTarget.style.background = 'color-mix(in srgb, var(--brand) 12%, transparent)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    <span style={{
                      width: 28, height: 28, borderRadius: 6,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      flexShrink: 0, color: 'var(--brand)',
                    }}>
                      {(() => {
                        const ProviderSvg = PROVIDER_ICONS[p.id];
                        return ProviderSvg
                          ? <ProviderSvg size={18} />
                          : <span style={{ fontSize: 14, fontWeight: 700 }}>{p.name.charAt(0)}</span>;
                      })()}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, fontFamily: 'var(--font-accent)' }}>{p.name}</div>
                    </div>
                    {isCreating && <span style={{ fontSize: 11, color: 'var(--brand)' }}>…</span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Separator */}
        <div style={{ width: 1, height: 18, background: 'rgba(255,255,255,0.08)', margin: '0 4px' }} />

        {/* Fullscreen toggle */}
        <button
          onClick={toggleFullscreen}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          style={{
            ...btnStyle,
            width: 28, height: 28,
            fontSize: 14,
          }}
          title={isFullscreen ? 'Exit fullscreen (Esc)' : 'Enter fullscreen'}
        >
          {isFullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </button>

        {/* Settings — borderless */}
        <button
          onClick={onOpenSettings}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          style={{
            ...btnStyle,
            width: 28, height: 28,
            fontSize: 15,
          }}
          title="Settings"
        >
          <Settings size={14} />
        </button>

        {/* Close — borderless */}
        <button
          onClick={() => window.close()}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(231, 111, 81, 0.15)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          style={{
            ...btnStyle,
            width: 28, height: 28,
            fontSize: 13,
            color: 'rgba(231, 111, 81, 0.7)',
          }}
          title="Close"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
};