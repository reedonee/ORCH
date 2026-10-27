import React, { useState, useCallback, useEffect } from 'react';
import { GlassPanel } from './GlassPanel';
import { CliTerminal } from './CliTerminal';
import { useAppStore, type Agent } from '../stores/useAppStore';
import { usePanelRegistry } from '../stores/usePanelRegistry';
import { withAlpha } from '../lib/color';
import { AgentCardBack } from './AgentCardBack';
import { useThemeStore } from '../stores/useThemeStore';
import { useTerminalStore } from '../stores/useTerminalStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { usePanelDrag } from '../hooks/usePanelDrag';
import { computePanelZIndex } from '../lib/z-stack-manager';
import { BUILTIN_PROVIDERS } from '../types/settings';
import { X, Minus, Maximize2, RefreshCw, Moon, ShieldAlert, ShieldCheck, Shield, Crown } from 'lucide-react';
import { useApprovalStore } from '../stores/useApprovalStore';
import { useLatestRef } from '../lib/use-latest-ref';

/** Providers whose permission prompts ORCH recognises (mirrors
 *  APPROVAL_PROVIDERS in electron/agent-approvals.ts). */
const APPROVAL_PROVIDERS = ['claude-code', 'codex'];
/** Providers ORCH points at its MCP server (mcp-agent-config.ts). */
const MCP_PROVIDERS = ['claude-code', 'codex', 'hermes', 'opencode'];
import { wakeAgent } from '../lib/electron-api';
import { PROVIDER_ICONS } from './icons/ProviderIcon';

/** Shared empty array so "no conflicts" keeps a stable identity and
 *  cannot itself trigger a re-render. */
const EMPTY_CONFLICTS: string[] = [];

const DEFAULT_W = 520;
const DEFAULT_H = 360;
/** One flip, start to finish. Long enough to read as a turn, short
 *  enough to never feel like waiting. */
const FLIP_MS = 820;
/** One unbroken ease-in-out arc: gentle start, fastest edge-on, settles
 *  without overshoot. */
const FLIP_EASE = 'cubic-bezier(0.65, 0, 0.35, 1)';
/** Depth for the turn, baked into each face's own transform. Not closer:
 *  at 1800px the near edge is magnified enough that Chromium re-rasters
 *  the face mid-turn, stalling presentation ~120 ms at edge-on (traced);
 *  from 4000px it presents every frame. Must match globals.css. */
const FLIP_PERSPECTIVE = 'perspective(4000px)';

interface AgentCardProps {
  agent: Agent;
  onClose: () => void;
  onFocus?: () => void;
}

// memo() prevents re-render when pan/zoom changes the `agent` reference in store
export const AgentCard: React.FC<AgentCardProps> = React.memo(({ agent, onClose }) => {
  const selectedAgentId = useAppStore((s) => s.selectedAgentId);
  const setSelectedAgent = useAppStore((s) => s.setSelectedAgent);
  const brandColor = useThemeStore((s) => s.theme.colors.brand);
  const themeColors = useThemeStore((s) => s.theme.colors);
  const cardOpacity = useSettingsStore((s) => s.cardOpacity);
  const cardBlur = useSettingsStore((s) => s.cardBlur);
  const reduceMotion = useSettingsStore((s) => s.reduceMotion);
  const flipView = useAppStore((s) => s.flipView);
  // Flip phases. 'rest': flat, text crisp. 'anim': turning or face-down.
  // Between them, for two frames, the card PREPARES: it becomes a 3D layer
  // and its back face is painted before any motion starts. Doing that work
  // on the first frame of the turn (and painting the back the moment it
  // swung into view, edge-on) is what made the flip stutter.
  const [flipPhase, setFlipPhase] = useState<'rest' | 'anim'>(flipView ? 'anim' : 'rest');
  const preparing = flipView && flipPhase === 'rest' && !reduceMotion;
  const flipViewRef = useLatestRef(flipView);
  useEffect(() => {
    let r1 = 0, r2 = 0;
    if (flipView && flipPhase === 'rest') {
      r1 = requestAnimationFrame(() => {
        r2 = requestAnimationFrame(() => { if (flipViewRef.current) setFlipPhase('anim'); });
      });
    } else if (!flipView && flipPhase === 'anim' && reduceMotion) {
      r1 = requestAnimationFrame(() => setFlipPhase('rest'));
    }
    return () => { cancelAnimationFrame(r1); cancelAnimationFrame(r2); };
  }, [flipView, flipPhase, reduceMotion, flipViewRef]);
  const in3d = preparing || flipPhase === 'anim';
  // Position in the flip wave: cards turn one after another, left to right.
  const flipOrder = useAppStore((s) => {
    const sorted = [...s.agents].sort((a, b) => a.x - b.x || a.y - b.y);
    return sorted.findIndex((a) => a.id === agent.id);
  });
  const flipDelay = Math.min(Math.max(flipOrder, 0) * 40, 240);
  const report = useAppStore((s) => s.agentReports[agent.id]);
  // NOT `useAppStore((s) => s.fileConflictsFor(agent.id))`: that selector
  // builds a NEW array on every call, so zustand sees a changed reference
  // on every store update and re-renders forever ("Maximum update depth
  // exceeded"). Subscribe to the stable reports object and derive.
  const agentReports = useAppStore((s) => s.agentReports);
  const conflicts = React.useMemo(() => {
    const mine = agentReports[agent.id];
    if (!mine || mine.phase !== 'working') return EMPTY_CONFLICTS;
    // Normalise separators so Windows and POSIX spellings of one path match.
    const norm = (f: string) => f.replace(/\\/g, '/').toLowerCase();
    const theirs = new Set(
      Object.values(agentReports)
        .filter((r) => r.agentId !== agent.id && r.phase === 'working')
        .flatMap((r) => r.files.map(norm)),
    );
    const hits = mine.files.filter((f) => theirs.has(norm(f)));
    return hits.length ? hits : EMPTY_CONFLICTS;
  }, [agentReports, agent.id]);
  const createTerminal = useTerminalStore((s) => s.createTerminal);

  // ── Approvals ───────────────────────────────────────────────
  const approval = useApprovalStore((s) => s.pending[agent.id]);
  const ownMode = useApprovalStore((s) => s.modes[agent.id]);
  const defaultApprovalMode = useSettingsStore((s) => s.defaultApprovalMode);
  const approvalMode = ownMode ?? defaultApprovalMode;
  const supportsApproval = APPROVAL_PROVIDERS.includes(agent.provider || '');
  const [answering, setAnswering] = useState(false);

  // ── MCP connection and controller ───────────────────────────
  const mcp = useAppStore((s) => s.mcpConnections[agent.id]);
  const isController = useAppStore((s) => s.controllerAgentId === agent.id);
  const usesMcp = MCP_PROVIDERS.includes(agent.provider || '');
  const respond = useCallback(async (decision: 'approve' | 'deny') => {
    setAnswering(true);
    await useApprovalStore.getState().respond(agent.id, decision);
    setAnswering(false);
  }, [agent.id]);

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
  // Narrow selectors, not the whole store. Subscribing to the entire
  // registry meant every agent card re-rendered whenever ANY panel moved,
  // resized, or was registered — so dragging one card re-rendered all of
  // them, and each of those carries a live xterm instance.
  const activePanelId = usePanelRegistry((s) => s.activePanelId);
  const dragPanelId = usePanelRegistry((s) => s.dragPanelId);
  const resizePanelId = usePanelRegistry((s) => s.resizePanelId);
  const zStack = usePanelRegistry((s) => s.zStack);
  const focusPanel = usePanelRegistry((s) => s.focusPanel);
  const zIndex = computePanelZIndex(
    agent.id,
    'canvas',
    10,                          // baseZIndex for unselected agents
    true,                        // focusable
    activePanelId,
    dragPanelId,
    resizePanelId,
    zStack,
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
    const resumeArgs = ['--continue'];
    const termId = await createTerminal(
      agent.id, agent.name,
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
      agent.id, agent.name,
      prov.command, resumeArgs,
      Object.keys(env).length > 0 ? env : undefined,
      'cli', 'hermes',
    );
    if (termId) {
      useAppStore.getState().updateAgentTerminalId(agent.id, termId);
    }
  }, [agent, createTerminal]);

  const displayW = minimized ? 240 : (positionStyle.width as number || DEFAULT_W);
  // A minimised card still shows its approval banner (~46px tall).
  const displayH = minimized ? (approval ? 94 : 48) : (positionStyle.height as number || DEFAULT_H);

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
      {/* Flip container. The back face is mounted while flipped so the
          terminal underneath is never unmounted by a flip — remounting
          xterm would drop scrollback and reset the shell's view.

          3D only while flipping or flipped. A permanent preserve-3d /
          rotateY(0) / backface-visibility made the whole card a 3D
          composited layer, which the browser rasterises once and then
          stretches when the canvas zooms: card text went soft, worst
          while zooming. Flat at rest, text is redrawn at every zoom. */}
      {/* Lift: the card swells slightly toward the viewer as it turns and
          settles as it lands. Its own element and its own 2D transform
          animation, so it never interrupts the turn (see globals.css). */}
      <div
        data-flip-lift
        style={{
          width: '100%', height: '100%', position: 'relative',
          animation: flipPhase === 'anim' && !reduceMotion
            ? `orch-flip-lift ${FLIP_MS}ms ease-in-out ${flipDelay}ms both`
            : undefined,
          willChange: in3d ? 'transform' : undefined,
        }}
      >
      {/* The two faces turn independently, each with perspective() in its
          own transform: front 0° → 180°, back −180° → 0° in lockstep, each
          hidden while facing away. No shared preserve-3d scene: two
          coplanar faces in one 3D context made Chromium depth-sort and
          split them on the GPU every frame, which stalled presentation
          for 50-150 ms per flip. */}
      <div
        data-flip-turn
        style={{ width: '100%', height: '100%', position: 'relative' }}
      >
      <GlassPanel
        accent={agent.id === selectedAgentId}
        // Selecting only from the header was the bug: you click INTO a
        // terminal to type, which is the strongest possible signal that
        // this is the agent you mean — but selection never moved, so the
        // chat bar kept sending prompts to whatever card you last touched
        // by its title bar. Capture phase so it still fires when xterm
        // stops the event from bubbling.
        onMouseDownCapture={() => {
          if (selectedAgentId !== agent.id) setSelectedAgent(agent.id);
          focusPanel(agent.id);
        }}
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          borderRadius: 'var(--radius-lg)',
          // Translucent by design, across every theme.
          //
          // The card sits over the canvas wallpaper, so opacity is what
          // makes it read as a pane of glass rather than a rectangle
          // pasted on top. Blur is essential to that: transparency
          // without it just shows a busy background through the text and
          // destroys readability. Both are user-tunable in Settings →
          // Appearance; the optional terminal scrim there darkens just the
          // terminal when a bright wallpaper needs it.
          background: `linear-gradient(135deg, ${withAlpha(themeColors.bgAlt, cardOpacity)} 0%, ${withAlpha(themeColors.bg, Math.min(1, cardOpacity + 0.08))} 100%)`,
          backdropFilter: cardBlur > 0 ? `blur(${cardBlur}px) saturate(1.35)` : undefined,
          WebkitBackdropFilter: cardBlur > 0 ? `blur(${cardBlur}px) saturate(1.35)` : undefined,
          border: flash
            ? '1px solid rgba(255, 68, 68, 0.7)'
            : approval
              ? '1px solid color-mix(in srgb, var(--warning) 75%, transparent)'
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
          backfaceVisibility: in3d ? 'hidden' : undefined,
          WebkitBackfaceVisibility: in3d ? 'hidden' : undefined,
          transform: preparing
            ? `${FLIP_PERSPECTIVE} rotateY(0deg)`
            : flipPhase === 'anim' && reduceMotion && flipView ? `${FLIP_PERSPECTIVE} rotateY(180deg)` : undefined,
          animation: flipPhase === 'anim' && !reduceMotion
            ? `${flipView ? 'orch-face-front-away' : 'orch-face-front-return'} ${FLIP_MS}ms ${FLIP_EASE} ${flipDelay}ms both`
            : undefined,
          willChange: in3d ? 'transform' : undefined,
          // Chromium hit-tests the turned-away front even with its
          // backface hidden, so clicks meant for the back landed here.
          pointerEvents: flipView ? 'none' : undefined,
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
            background: `linear-gradient(180deg, ${withAlpha(themeColors.bgAlt, Math.min(1, cardOpacity + 0.10))} 0%, ${withAlpha(themeColors.bgAlt, cardOpacity)} 100%)`,
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
          {usesMcp && (
            <span
              title={mcp?.connected
                ? `Connected to ORCH${mcp.client ? ` (${mcp.client})` : ''} — this agent can see and use the canvas`
                : 'Not connected to ORCH yet — it connects when the agent starts'}
              aria-label={mcp?.connected ? 'Connected to ORCH' : 'Not connected to ORCH'}
              style={{
                width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
                background: mcp?.connected ? 'var(--success)' : 'var(--text-muted)',
                opacity: mcp?.connected ? 1 : 0.45,
                boxShadow: mcp?.connected ? '0 0 6px color-mix(in srgb, var(--success) 60%, transparent)' : 'none',
              }}
            />
          )}
          {usesMcp && (
            <button
              className="glass-btn no-drag"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                void useAppStore.getState().setController(isController ? null : agent.id);
              }}
              title={isController
                ? 'Controller: this agent coordinates the others and stays in sync with ORCH in real time. Click to stop.'
                : 'Make this agent the controller that coordinates the others'}
              aria-label={isController ? 'Controller (click to clear)' : 'Make controller'}
              aria-pressed={isController}
              style={{
                width: 24, height: 24, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: isController ? 'color-mix(in srgb, var(--brand) 22%, transparent)' : 'var(--glass-bg)',
                border: `1px solid ${isController ? 'color-mix(in srgb, var(--brand) 60%, transparent)' : 'var(--glass-border)'}`,
                color: isController ? 'var(--brand)' : 'var(--text-secondary)',
              }}
            >
              <Crown size={12} />
            </button>
          )}
          {supportsApproval && (
            <button
              className="glass-btn no-drag"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                void useApprovalStore.getState().setMode(agent.id, approvalMode === 'auto' ? 'manual' : 'auto');
              }}
              title={approvalMode === 'auto'
                ? 'Auto: ORCH approves this agent\'s tool requests. Click for Manual.'
                : 'Manual: this agent asks before running tools. Click for Auto.'}
              aria-label={`Approval mode: ${approvalMode}`}
              style={{
                height: 24, padding: '0 8px', fontSize: 10.5, fontWeight: 600, letterSpacing: 0.3,
                display: 'flex', alignItems: 'center', gap: 4, borderRadius: 'var(--radius-pill)',
                background: approvalMode === 'auto' ? 'color-mix(in srgb, var(--warning) 14%, transparent)' : 'var(--glass-bg)',
                border: `1px solid ${approvalMode === 'auto' ? 'color-mix(in srgb, var(--warning) 45%, transparent)' : 'var(--glass-border)'}`,
                color: approvalMode === 'auto' ? 'var(--warning)' : 'var(--text-secondary)',
                textShadow: 'none',
              }}
            >
              {approvalMode === 'auto' ? <ShieldCheck size={12} /> : <Shield size={12} />}
              {approvalMode === 'auto' ? 'Auto' : 'Manual'}
            </button>
          )}
          <button className="glass-btn no-drag" onClick={(e) => { e.stopPropagation(); setMinimized(!minimized); }}
            style={{ width: 24, height: 24, padding: 0, fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--glass-bg)', border: '1px solid var(--glass-border)', color: 'var(--text-secondary)' }}>
            {minimized ? <Maximize2 size={12} /> : <Minus size={12} />}
          </button>
          <button className="glass-btn no-drag" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onClose(); }}
            style={{ width: 24, height: 24, padding: 0, fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--glass-bg)', border: '1px solid var(--glass-border)', color: 'var(--text-secondary)' }}>
            <X size={12} />
          </button>
        </div>

        {/* Pending approval. Shown even when minimised: a waiting agent
            is exactly the one you need to find. */}
        {approval && (
          <div
            className="no-drag"
            role="alert"
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px',
              background: 'color-mix(in srgb, var(--warning) 13%, transparent)',
              borderBottom: '1px solid color-mix(in srgb, var(--warning) 35%, transparent)',
              fontSize: 12, color: 'var(--text)',
            }}
          >
            <ShieldAlert size={14} style={{ color: 'var(--warning)', flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {approval.kind === 'trust' ? 'Trust this folder? ORCH will remember it' : 'Needs approval'}
              </div>
              <div
                title={approval.detail}
                style={{
                  fontFamily: "'JetBrains Mono', 'Cascadia Code', monospace", fontSize: 11,
                  color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}
              >
                {approval.detail}
              </div>
            </div>
            <button
              disabled={answering}
              onClick={() => void respond('deny')}
              style={{
                padding: '5px 10px', fontSize: 11, fontWeight: 600, borderRadius: 'var(--radius-sm)', cursor: 'pointer',
                border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', fontFamily: 'inherit',
              }}
            >
              Deny
            </button>
            <button
              disabled={answering}
              onClick={() => void respond('approve')}
              style={{
                padding: '5px 12px', fontSize: 11, fontWeight: 700, borderRadius: 'var(--radius-sm)', cursor: 'pointer',
                border: '1px solid color-mix(in srgb, var(--warning) 60%, transparent)',
                background: 'color-mix(in srgb, var(--warning) 22%, transparent)',
                color: 'var(--text)', fontFamily: 'inherit',
              }}
            >
              {approval.kind === 'trust' ? 'Trust' : 'Approve'}
            </button>
          </div>
        )}

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
                  <CliTerminal sessionId={agent.terminalId} agentName={agent.name} />
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

        {/* Back face. Always laid out, so a flip never starts by building
            it — that layout-and-paint spike landed on the first frame of
            every flip. At rest it is invisible and flat (no 3D layer, no
            effect on text sharpness); it is rotated into place only while
            3D. Clicking it flips every card back over. */}
        <div
          onClick={() => window.dispatchEvent(new Event('orch-flip-back'))}
          onAnimationEnd={(e) => {
            if (e.target === e.currentTarget && e.animationName === 'orch-face-back-away' && !flipView) setFlipPhase('rest');
          }}
          title="Click to flip back"
          style={{
            visibility: in3d ? 'visible' : 'hidden',
            cursor: 'pointer',
            position: 'absolute', inset: 0,
            transform: preparing || (flipPhase === 'anim' && reduceMotion && !flipView)
              ? `${FLIP_PERSPECTIVE} rotateY(-180deg)`
              : undefined,
            animation: flipPhase === 'anim' && !reduceMotion
              ? `${flipView ? 'orch-face-back-in' : 'orch-face-back-away'} ${FLIP_MS}ms ${FLIP_EASE} ${flipDelay}ms both`
              : undefined,
            willChange: in3d ? 'transform' : undefined,
            // While preparing, the back is drawn facing away but nearly
            // transparent, which forces the browser to paint it now rather
            // than mid-turn when it first comes into view.
            backfaceVisibility: in3d && !preparing ? 'hidden' : undefined,
            WebkitBackfaceVisibility: in3d && !preparing ? 'hidden' : undefined,
            opacity: preparing ? 0.01 : undefined,
            borderRadius: 'var(--radius-lg)',
            overflow: 'hidden',
            border: `1px solid ${agent.color}40`,
            // Non-interactive while face-down, so a click can't land on a
            // control the user can't see.
            pointerEvents: flipView ? 'auto' : 'none',
          }}
          aria-hidden={!flipView}
        >
          <AgentCardBack
            report={report}
            agentName={agent.name}
            providerId={agent.provider}
            color={agent.color}
            conflicts={conflicts}
            unread={report ? 0 : 0}
            active={in3d}
          />
        </div>
      </div>
      </div>
    </div>
  );
});
