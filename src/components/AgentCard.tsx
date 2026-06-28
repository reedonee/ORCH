import React, { useState, useCallback, useEffect } from 'react';
import { GlassPanel } from './GlassPanel';
import { CliTerminal } from './CliTerminal';
import { useAppStore, type Agent } from '../stores/useAppStore';
import { usePanelRegistry } from '../stores/usePanelRegistry';
import { useThemeStore } from '../stores/useThemeStore';
import { useTerminalStore } from '../stores/useTerminalStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { usePanelDrag } from '../hooks/usePanelDrag';
import { computePanelZIndex } from '../lib/z-stack-manager';
import { BUILTIN_PROVIDERS } from '../types/settings';
import { X, Minus, Maximize2, RefreshCw, Moon } from 'lucide-react';
import { wakeAgent } from '../lib/electron-api';
import { PROVIDER_ICONS } from './icons/ProviderIcon';

const MIN_W = 260;
const MIN_H = 180;
const DEFAULT_W = 520;
const DEFAULT_H = 360;

interface AgentCardProps {
  agent: Agent;
  onClose: () => void;
  onFocus?: () => void;
}

// memo() prevents re-render when pan/zoom changes the `agent` reference in store
export const AgentCard: React.FC<AgentCardProps> = React.memo(({ agent, onClose }) => {
  const updateAgentPosition = useAppStore((s) => s.updateAgentPosition);
  const updateAgentSize = useAppStore((s) => s.updateAgentSize);
  const selectedAgentId = useAppStore((s) => s.selectedAgentId);
  const setSelectedAgent = useAppStore((s) => s.setSelectedAgent);
  const brandColor = useThemeStore((s) => s.theme.colors.brand);
  const themeColors = useThemeStore((s) => s.theme.colors);
  const createTerminal = useTerminalStore((s) => s.createTerminal);

  const [minimized, setMinimized] = useState(false);

  // ── Barge-In flash effect ────────────────────────────────────
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.agentId === agent.id) {
        setFlash(true);
        setTimeout(() => setFlash(false), 600);
      }
    };
    window.addEventListener('bargein-interrupt', handler);
    return () => window.removeEventListener('bargein-interrupt', handler);
  }, [agent.id]);

  // ── Unified drag/resize via panel registry ─────────────────
  const {
    dragHandlers,
    resizeHandlers,
    positionStyle,
    transition,
    isDragging,
    isResizing,
  } = usePanelDrag({
    panelId: agent.id,
    snapToGrid: 32,
  });

  // ── Compute z-index from central stack manager ─────────────
  const registry = usePanelRegistry();
  const focusPanel = usePanelRegistry((s) => s.focusPanel);
  const zIndex = computePanelZIndex(
    agent.id,
    'canvas',
    10,                          // baseZIndex for unselected agents
    true,                        // focusable
    registry.activePanelId,
    registry.dragPanelId,
    registry.resizePanelId,
    registry.zStack,
  );

  // ── restart claude-code session with --continue ────────────────────────────
  const resumeClaudeSession = useCallback(async () => {
    const prov = BUILTIN_PROVIDERS.find((p) => p.id === 'claude-code');
    if (!prov) return;
    const env: Record<string, string> = {};
    if (prov.envKey) {
      const key = useSettingsStore.getState().apiKeys.find(k => k.provider === prov.envKey);
      if (key) {
        const varName = prov.envKey === 'anthropic' ? 'ANTHROPIC_API_KEY'
          : `${prov.envKey.toUpperCase()}_API_KEY`;
        env[varName] = key.key;
      }
    }
    const resumeArgs = ['--dangerously-skip-permissions', '--continue'];
    const termId = await createTerminal(
      agent.name, `${agent.name} Terminal`,
      prov.command, resumeArgs,
      Object.keys(env).length > 0 ? env : undefined,
      'cli', 'claude-code',
    );
    if (termId) {
      useAppStore.getState().updateAgentTerminalId(agent.id, termId);
    }
  }, [agent, createTerminal]);

  // ── restart hermes session with --continue ─────────────────────────────
  const resumeHermesSession = useCallback(async () => {
    const prov = BUILTIN_PROVIDERS.find((p) => p.id === 'hermes');
    if (!prov) return;
    const env: Record<string, string> = {};
    if (prov.envKey) {
      const key = useSettingsStore.getState().apiKeys.find(k => k.provider === prov.envKey);
      if (key) {
        env['ANTHROPIC_API_KEY'] = key.key;
      }
    }
    const resumeArgs = ['--continue'];
    const termId = await createTerminal(
      agent.name, `${agent.name} Terminal`,
      prov.command, resumeArgs,
      Object.keys(env).length > 0 ? env : undefined,
      'cli', 'hermes',
    );
    if (termId) {
      useAppStore.getState().updateAgentTerminalId(agent.id, termId);
    }
  }, [agent, createTerminal]);

  const displayW = minimized ? 240 : (positionStyle.width as number || DEFAULT_W);
  const displayH = minimized ? 48 : (positionStyle.height as number || DEFAULT_H);

  return (
    <div
      id={`agent-card-${agent.id}`}
      data-agent-card="true"
      style={{
        position: 'absolute',
        left: positionStyle.left,
        top: positionStyle.top,
        transition,
        width: displayW,
        height: displayH,
        boxSizing: 'border-box',
        zIndex,
        cursor: isDragging ? 'grabbing' : isResizing ? 'nwse-resize' : 'default',
      }}
    >
      <GlassPanel
        accent={agent.id === selectedAgentId}
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          borderRadius: 'var(--radius-lg)',
          background: `linear-gradient(135deg, ${themeColors.bgAlt}CC 0%, ${themeColors.bg}E6 100%)`,
          border: flash
            ? '1px solid rgba(255, 68, 68, 0.7)'
            : selectedAgentId === agent.id
              ? `1px solid ${brandColor}70`
              : '1px solid rgba(255, 255, 255, 0.12)',
          boxShadow: flash
            ? '0 0 20px rgba(255, 68, 68, 0.5), inset 0 1px 0 rgba(255,255,255,0.10)'
            : selectedAgentId === agent.id
              ? `0 0 24px ${brandColor}50, 0 0 60px ${brandColor}20, inset 0 1px 0 rgba(255,255,255,0.10)`
              : 'inset 0 1px 0 rgba(255,255,255,0.05)',
          position: 'relative',
          zIndex: 0,
        }}
      >
        {/* Frosted glass noise overlay */}
        <div style={{
          position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none',
          borderRadius: 'inherit', overflow: 'hidden',
          opacity: 0.5, mixBlendMode: 'overlay',
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 512 512' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.75' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.08'/%3E%3C/svg%3E")`,
        }} />
        <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div
          onMouseDown={(e) => {
            e.stopPropagation();
            // Select agent on header click (does not focus terminal)
            setSelectedAgent(agent.id);
            // Elevate in the z-stack + mark as active for the focus layer
            focusPanel(agent.id);
            if (agent.status === 'sleeping') wakeAgent(agent.id);
            // Delegate to unified drag handler
            dragHandlers.onMouseDown(e);
          }}
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '0 12px',
            height: 40,
            background: 'var(--surface-alt)',
            borderBottom: minimized
              ? 'none'
              : '1px solid var(--border-dim)',
            cursor: 'grab',
            userSelect: 'none',
            WebkitFontSmoothing: 'antialiased',
            textShadow: '0 1px 2px rgba(0,0,0,0.75)',
          }}
        >
          <div style={{ width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, color: 'var(--brand)' }}>
            {(() => {
              const ProviderSvg = PROVIDER_ICONS[agent.provider || ''];
              return ProviderSvg
                ? <ProviderSvg size={16} />
                : <span style={{ width: 8, height: 8, borderRadius: '50%', display: 'block', background: 'var(--brand)', boxShadow: '0 0 6px color-mix(in srgb, var(--brand) 33%, transparent)' }} />;
            })()}
          </div>
          <span style={{ fontFamily: "'JetBrains Mono', 'Cascadia Code', monospace", fontSize: 13, letterSpacing: 0.3, color: 'var(--text)', fontWeight: 600, flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {agent.name}
          </span>
          <button className="glass-btn no-drag" onClick={(e) => { e.stopPropagation(); setMinimized(!minimized); }}
            style={{ width: 24, height: 24, padding: 0, fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--glass-bg)', border: '1px solid var(--glass-border)', color: 'var(--text-secondary)' }}>
            {minimized ? <Maximize2 size={12} /> : <Minus size={12} />}
          </button>
          <button className="glass-btn no-drag" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onClose(); }}
            style={{ width: 24, height: 24, padding: 0, fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--glass-bg)', border: '1px solid var(--glass-border)', color: 'var(--text-secondary)' }}>
            <X size={12} />
          </button>
        </div>

        {/* Terminal content */}
        {!minimized && (
          <div style={{ flex: 1, padding: 4, overflow: 'hidden', minHeight: 0 }}>
            {agent.status === 'sleeping' ? (
              <div style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                height: '100%', gap: 8, color: 'var(--text-muted)', opacity: 0.5, fontSize: 13,
              }}>
                <Moon size={20} />
                <span>Agent sleeping — click to wake</span>
              </div>
            ) : agent.terminalId && agent.provider && ['claude-code', 'codex', 'opencode', 'hermes'].includes(agent.provider) ? (
                  <CliTerminal sessionId={agent.terminalId} />
            ) : agent.provider && ['cursor', 'antigravity'].includes(agent.provider) ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)', fontSize: 13, textAlign: 'center', padding: 20 }}>
                {agent.provider === 'cursor'
                  ? 'Cursor launched as an external app in the ORCH project folder.'
                  : 'Antigravity launched as an external app in the ORCH project folder.'}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, height: '100%', color: 'var(--text-muted)', fontSize: 13 }}>
                {agent.provider === 'claude-code' ? (
                  <>
                    <span>Session ended</span>
                    <button
                      onClick={resumeClaudeSession}
                      style={{
                        padding: '6px 16px', borderRadius: 6, border: '1px solid var(--accent)',
                        background: 'var(--accent)15', color: 'var(--accent)',
                        cursor: 'pointer', fontSize: 12, fontFamily: 'inherit',
                        display: 'flex', alignItems: 'center', gap: 6,
                      }}
                    >
                      <RefreshCw size={12} /> ↻ Continue last session
                    </button>
                  </>
                ) : agent.provider === 'hermes' ? (
                  <>
                    <span>Session ended</span>
                    <button
                      onClick={resumeHermesSession}
                      style={{
                        padding: '6px 16px', borderRadius: 6, border: '1px solid var(--accent)',
                        background: 'var(--accent)15', color: 'var(--accent)',
                        cursor: 'pointer', fontSize: 12, fontFamily: 'inherit',
                        display: 'flex', alignItems: 'center', gap: 6,
                      }}
                    >
                      <RefreshCw size={12} /> ↻ Continue last session
                    </button>
                  </>
                ) : (
                  <span>Terminal not connected</span>
                )}
              </div>
            )}
          </div>
        )}

        {/* Resize handle — bottom-right corner */}
        {!minimized && (
          <div
            className="no-drag"
            onMouseDown={resizeHandlers.onMouseDown}
            style={{
              position: 'absolute', bottom: 0, right: 0,
              width: 20, height: 20,
              cursor: 'nwse-resize',
              zIndex: 10,
              display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end',
              padding: 2,
              pointerEvents: 'auto',
            }}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" style={{ opacity: 0.35 }}>
              <line x1="8" y1="10" x2="10" y2="10" stroke="var(--text-muted)" strokeWidth="1.5" strokeLinecap="round" />
              <line x1="10" y1="8" x2="10" y2="10" stroke="var(--text-muted)" strokeWidth="1.5" strokeLinecap="round" />
              <line x1="4" y1="10" x2="10" y2="10" stroke="var(--text-muted)" strokeWidth="1.5" strokeLinecap="round" opacity="0.5" />
              <line x1="10" y1="4" x2="10" y2="10" stroke="var(--text-muted)" strokeWidth="1.5" strokeLinecap="round" opacity="0.5" />
            </svg>
          </div>
        )}
        </div>
      </GlassPanel>
    </div>
  );
});
