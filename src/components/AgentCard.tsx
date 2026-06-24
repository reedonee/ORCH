import React, { useState, useRef, useCallback, useEffect } from 'react';
import { GlassPanel } from './GlassPanel';
import { TerminalView } from './TerminalView';
import { CliTerminal } from './CliTerminal';
import { VpsTerminal } from './VpsTerminal';
import { ErrorBoundary } from './ErrorBoundary';
import { useAppStore, type Agent } from '../stores/useAppStore';
import { useThemeStore } from '../stores/useThemeStore';
import { useTerminalStore } from '../stores/useTerminalStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { BUILTIN_PROVIDERS } from '../types/settings';
import { X, Minus, Maximize2, RefreshCw, Moon } from 'lucide-react';
import { snapToGrid } from '../lib/canvas-utils';
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
  const createTerminal = useTerminalStore((s) => s.createTerminal);

  const [isDragging, setIsDragging] = useState(false);
  const [dragPos, setDragPos] = useState({ x: agent.x, y: agent.y });
  const [isResizing, setIsResizing] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const dragRef = useRef({ startX: 0, startY: 0, startMX: 0, startMY: 0 });
  const resizeRef = useRef({ startX: 0, startY: 0, startW: DEFAULT_W, startH: DEFAULT_H });
  const posRef = useRef({ x: agent.x, y: agent.y });
  const [cardW, setCardW] = useState(agent.width || DEFAULT_W);
  const [cardH, setCardH] = useState(agent.height || DEFAULT_H);
  const sizeRef = useRef({ w: cardW, h: cardH });

  // keep ref & dragPos in sync with store when not dragging
  useEffect(() => {
    posRef.current = { x: agent.x, y: agent.y };
    if (!isDragging) setDragPos({ x: agent.x, y: agent.y });
  }, [agent.x, agent.y, isDragging]);

  useEffect(() => {
    setCardW(agent.width || DEFAULT_W);
    setCardH(agent.height || DEFAULT_H);
  }, [agent.width, agent.height]);

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

  // ── drag (batched: local state during move, commit to store on release) ──
  useEffect(() => {
    if (!isDragging) return;
    const onMove = (e: MouseEvent) => {
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      const nx = dragRef.current.startMX + dx;
      const ny = dragRef.current.startMY + dy;
      posRef.current = { x: nx, y: ny };
      setDragPos({ x: nx, y: ny });
      // NOT updating zustand here — commit once on mouseup
    };
    const onUp = () => {
      setIsDragging(false);
      const snappedX = snapToGrid(posRef.current.x);
      const snappedY = snapToGrid(posRef.current.y);
      posRef.current = { x: snappedX, y: snappedY };
      updateAgentPosition(agent.id, snappedX, snappedY);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [isDragging, agent.id, updateAgentPosition]);

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

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.no-drag')) return;
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startY: e.clientY, startMX: posRef.current.x, startMY: posRef.current.y };
    setIsDragging(true);
  }, []);

  // keep ref in sync
  useEffect(() => { sizeRef.current = { w: cardW, h: cardH }; }, [cardW, cardH]);

  // ── resize ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isResizing) return;
    const onMove = (e: MouseEvent) => {
      const dw = e.clientX - resizeRef.current.startX;
      const dh = e.clientY - resizeRef.current.startY;
      const newW = Math.max(MIN_W, resizeRef.current.startW + dw);
      const newH = Math.max(MIN_H, resizeRef.current.startH + dh);
      setCardW(newW);
      setCardH(newH);
    };
    const onUp = () => {
      setIsResizing(false);
      updateAgentSize(agent.id, sizeRef.current.w, sizeRef.current.h);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, [isResizing, agent.id, updateAgentSize]);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    resizeRef.current = { startX: e.clientX, startY: e.clientY, startW: cardW, startH: cardH };
    setIsResizing(true);
  }, [cardW, cardH]);

  const displayW = minimized ? 240 : cardW;
  const displayH = minimized ? 48 : cardH;
  const displayX = isDragging ? dragPos.x : agent.x;
  const displayY = isDragging ? dragPos.y : agent.y;

  return (
    <div
      id={`agent-card-${agent.id}`}
      data-agent-card="true"
      style={{
        position: 'absolute',
        left: displayX,
        top: displayY,
        transition: `${isDragging || isResizing ? 'none' : 'left 0.25s ease, top 0.25s ease'} all var(--anim-normal)`,
        width: displayW,
        height: displayH,
        boxSizing: 'border-box',
        zIndex: isDragging || isResizing ? 1000 : agent.id === selectedAgentId ? 100 : 10,
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
          background: 'linear-gradient(135deg, rgba(20, 20, 20, 0.55) 0%, rgba(10, 10, 10, 0.65) 100%)',
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
            if (agent.status === 'sleeping') wakeAgent(agent.id);
            handleDragStart(e);
          }}
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '0 12px',
            height: 40,
            background: '#222524',
            borderBottom: minimized
              ? 'none'
              : '1px solid rgba(255, 255, 255, 0.06)',
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
          <span style={{ fontFamily: "'JetBrains Mono', 'Cascadia Code', monospace", fontSize: 13, letterSpacing: 0.3, color: 'rgba(234, 244, 244, 0.88)', fontWeight: 600, flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {agent.name}
          </span>
          <button className="glass-btn no-drag" onClick={(e) => { e.stopPropagation(); setMinimized(!minimized); }}
            style={{ width: 24, height: 24, padding: 0, fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.06)', color: 'rgba(234, 244, 244, 0.72)' }}>
            {minimized ? <Maximize2 size={12} /> : <Minus size={12} />}
          </button>
          <button className="glass-btn no-drag" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onClose(); }}
            style={{ width: 24, height: 24, padding: 0, fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.06)', color: 'rgba(234, 244, 244, 0.72)' }}>
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
            ) : agent.terminalId ? (
              <ErrorBoundary>
                {agent.terminalId?.startsWith('vps:') ? (
                  <VpsTerminal
                    agentId={agent.terminalId.replace('vps:', '')}
                    onSessionEnded={onClose}
                  />
                ) : agent.provider && ['claude-code', 'codex', 'opencode', 'hermes'].includes(agent.provider) ? (
                  <CliTerminal sessionId={agent.terminalId} />
                ) : (
                  <TerminalView sessionId={agent.terminalId} />
                )}
              </ErrorBoundary>
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
            onMouseDown={handleResizeStart}
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
