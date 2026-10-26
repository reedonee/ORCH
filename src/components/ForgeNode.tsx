// ── ORCH Forge Node — Canvas Panel ──────────────────────────────
// World-class forge pipeline UI. Every element serves a function.
// No empty states, no decorative fluff, no blur on glass.

import React, { useRef, useEffect, useState } from 'react';
import { GlassPanel } from './GlassPanel';
import { useForgeStore, type ForgePhase } from '../stores/useForgeStore';
import { useFeedbackStore, FEEDBACK_STATUSES } from '../stores/useFeedbackStore';
import type { FeedbackStatus } from '../stores/useFeedbackStore';
import { usePanelDrag } from '../hooks/usePanelDrag';
import { usePanelRegistry } from '../stores/usePanelRegistry';
import { computePanelZIndex } from '../lib/z-stack-manager';
import { useThemeStore } from '../stores/useThemeStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import {
  X, Hammer, Bug, CheckSquare, Square, Circle, Camera,
  CheckCircle, XCircle, Clock, Cpu, FileText,
  Play, Download, Trash2, Plus, ToggleLeft, ToggleRight,
} from 'lucide-react';

// ── Tokens ───────────────────────────────────────────────────────

const STATUS: Record<FeedbackStatus, { label: string; dot: string }> = {
  pending:      { label: 'Pending',      dot: '#8E7C9A' },
  in_progress:  { label: 'In Progress',  dot: '#F4A261' },
  forge_queued: { label: 'Forge Queued', dot: '#4EA8DE' },
  resolved:     { label: 'Resolved',     dot: '#00E676' },
};

type Tab = 'tasks' | 'feedback' | 'pipeline' | 'metrics';

const B = {
  background: 'transparent', border: 'none', padding: 0,
  cursor: 'pointer', fontFamily: 'inherit', fontSize: 'inherit', color: 'inherit',
} as const;

const PHASES: Array<{ key: ForgePhase; label: string }> = [
  { key: 'deconstructing', label: 'Parse' },
  { key: 'assigning',      label: 'Assign' },
  { key: 'consensus',      label: 'Review' },
  { key: 'testing',        label: 'Test'  },
  { key: 'complete',       label: 'Done'  },
];

const PANEL_ID = 'forge-node';
const W = 720;
const H = 500;

// ═══════════════════════════════════════════════════════════════════

const ForgeNode: React.FC = () => {
  const s = useForgeStore();
  const fb = useFeedbackStore();
  const brandColor = useThemeStore((s) => s.theme.colors.brand);
  const themeColors = useThemeStore((s) => s.theme.colors);
  const isAdmin = useSettingsStore((s) => s.isAdmin);

  const [tab, setTab] = useState<Tab>('tasks');
  const [manualTitle, setManualTitle] = useState('');
  const [manualDesc, setManualDesc] = useState('');

  const ref = useRef<HTMLDivElement>(null);
  // Narrow selectors instead of the whole registry: subscribing to the
  // entire store re-rendered this panel on every unrelated panel move.
  const activePanelId = usePanelRegistry((s) => s.activePanelId);
  const dragPanelId = usePanelRegistry((s) => s.dragPanelId);
  const resizePanelId = usePanelRegistry((s) => s.resizePanelId);
  const zStack = usePanelRegistry((s) => s.zStack);
  const registerPanel = usePanelRegistry((s) => s.registerPanel);
  const unregisterPanel = usePanelRegistry((s) => s.unregisterPanel);
  const updatePanel = usePanelRegistry((s) => s.updatePanel);
  const focusPanel = usePanelRegistry((s) => s.focusPanel);
  const { dragHandlers, positionStyle, transition, isDragging } = usePanelDrag({ panelId: PANEL_ID, snapToGrid: 32 });

  const z = computePanelZIndex(PANEL_ID, 'canvas', 10, true,
    activePanelId, dragPanelId, resizePanelId, zStack);
  const isActive = activePanelId === PANEL_ID;

  useEffect(() => {
    registerPanel({
      id: PANEL_ID, type: 'forge', space: 'canvas',
      x: 120, y: 80, width: W, height: H,
      minWidth: 500, minHeight: 360, defaultWidth: W, defaultHeight: H,
      participatesInAutoLayout: true, participatesInFraming: true, participatesInCollision: true,
      draggable: true, resizable: true, focusable: true, baseZIndex: 10,
    });
    return () => { unregisterPanel(PANEL_ID); };
  }, []);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) focusPanel(null);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  if (!s.visible) return null;

  const isRunning = s.phase !== 'idle' && s.phase !== 'complete';
  const done = s.phase === 'complete';
  const allSel = fb.feedbacks.length > 0 && Object.keys(fb.selectedIds).length === fb.feedbacks.length;

  // ── Tabs (Feedback Inbox gated by admin) ───────────────────

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'tasks', label: 'Tasks' },
    ...(isAdmin ? [{ id: 'feedback' as Tab, label: 'Inbox' }] : []),
    { id: 'pipeline', label: 'Pipeline' },
    { id: 'metrics', label: 'Metrics' },
  ];

  return (
    <div ref={ref} data-agent-card
      style={{ position: 'absolute', ...positionStyle, width: W, height: H, zIndex: z, transition }}>
      <GlassPanel style={{
        width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
        borderRadius: 'var(--radius-lg)', overflow: 'hidden',
        background: `linear-gradient(135deg, ${themeColors.bgAlt}CC 0%, ${themeColors.bg}E6 100%)`,
        border: `1px solid var(--brand)`,
        boxShadow: isActive
          ? `0 0 20px ${brandColor}50, 0 0 50px ${brandColor}20, var(--shadow-glow)`
          : `0 0 8px ${brandColor}15, inset 0 1px 0 rgba(255,255,255,0.06)`,
        position: 'relative', zIndex: 0,
      }}>
        {/* Frosted glass noise overlay */}
        <div style={{
          position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none',
          borderRadius: 'inherit', overflow: 'hidden',
          opacity: 0.5, mixBlendMode: 'overlay',
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 512 512' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.75' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.08'/%3E%3C/svg%3E")`,
        }} />
        <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', height: '100%' }}>
        {/* ── Header ─────────────────────────────── */}
        <div
          onMouseDown={(e: React.MouseEvent) => {
            focusPanel(PANEL_ID);
            dragHandlers.onMouseDown(e);
          }}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '0 14px', height: 40,
            background: 'var(--surface-alt)',
            borderBottom: '1px solid var(--border-dim)',
            flexShrink: 0, cursor: isDragging ? 'grabbing' : 'grab',
            userSelect: 'none', WebkitFontSmoothing: 'antialiased',
            textShadow: '0 1px 2px rgba(0,0,0,0.75)',
          }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Hammer size={14} style={{ color: brandColor }} />
            <span style={{ fontFamily: "'JetBrains Mono', 'Cascadia Code', monospace", fontSize: 13, letterSpacing: 0.3, color: 'var(--text)', fontWeight: 600 }}>
              Forge
            </span>
            {s.phase !== 'idle' && (
              <span style={{
                fontSize: 9, padding: '2px 8px', borderRadius: 'var(--radius-pill)',
                background: done ? 'color-mix(in srgb, var(--success) 20%, transparent)' : 'color-mix(in srgb, var(--accent) 18%, transparent)',
                color: done ? 'var(--success)' : 'var(--accent)',
                fontWeight: 600, letterSpacing: 0.4,
              }}>
                {s.phase}
              </span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {s.message && (
              <span style={{ fontSize: 10, color: s.message.includes('🎉') ? 'var(--success)' : 'var(--text)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {s.message}
                <button onClick={s.clearMessage} style={{ ...B, marginLeft: 4, opacity: 0.4 }}>✕</button>
              </span>
            )}
            <button className="glass-btn no-drag" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); s.setVisible(false); }}
              style={{ width: 24, height: 24, padding: 0, fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--glass-bg)', border: '1px solid var(--glass-border)', color: 'var(--text-secondary)' }}>
              <X size={12} />
            </button>
          </div>
        </div>

        {/* ── Tab Bar ──────────────────────────────── */}
        <div style={{ display: 'flex', gap: 0, padding: '0 12px', borderBottom: '1px solid var(--border-dim)', flexShrink: 0 }}>
          {tabs.map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)}
              style={{
                ...B, padding: '7px 12px', fontSize: 11, fontWeight: 600, letterSpacing: 0.3,
                borderBottom: tab === t.id ? `2px solid ${brandColor}` : '2px solid transparent',
                color: tab === t.id ? brandColor : 'var(--text)',
                transition: 'color 0.15s, border-color 0.15s',
                marginBottom: -1,
              }}>
              {t.label}
            </button>
          ))}
        </div>

        {/* ── Content ─────────────────────────────── */}
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {tab === 'tasks' && Tasks()}
          {tab === 'feedback' && Inbox()}
          {tab === 'pipeline' && Pipeline()}
          {tab === 'metrics' && Metrics()}
        </div>
      </div>
    </GlassPanel>
    </div>
  );

  // ══ TASKS ═══════════════════════════════════════════════════════

  function Tasks() {
    const manual = s.tasks.filter((t) => t.feedbackId === null);
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
        {/* Creator */}
        <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border-dim)', flexShrink: 0 }}>
          <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <input value={manualTitle} onChange={(e) => setManualTitle(e.target.value)}
              placeholder="Task title"
              style={{
                flex: 1, padding: '7px 10px', borderRadius: 'var(--radius-sm)',
                background: 'var(--surface)', border: '1px solid var(--border)',
                color: 'var(--text)', fontSize: 12, fontFamily: 'inherit', outline: 'none',
              }} />
            <button onClick={() => { if (manualTitle.trim() && manualDesc.trim()) { s.addManualTask(manualTitle.trim(), manualDesc.trim()); setManualTitle(''); setManualDesc(''); } }}
              disabled={!manualTitle.trim() || !manualDesc.trim()}
              style={{
                ...B, padding: '7px 14px', borderRadius: 'var(--radius-pill)',
                background: (manualTitle.trim() && manualDesc.trim()) ? brandColor : 'var(--border-dim)',
                color: (manualTitle.trim() && manualDesc.trim()) ? 'var(--bg)' : 'var(--text)',
                fontWeight: 700, fontSize: 11, display: 'flex', alignItems: 'center', gap: 4,
                cursor: (manualTitle.trim() && manualDesc.trim()) ? 'pointer' : 'not-allowed',
              }}>
              <Plus size={13} /> Add
            </button>
          </div>
          <textarea value={manualDesc} onChange={(e) => setManualDesc(e.target.value)}
            placeholder="What should the agents do?"
            rows={2}
            style={{
              width: '100%', padding: '7px 10px', borderRadius: 'var(--radius-sm)',
              background: 'var(--surface)', border: '1px solid var(--border)',
              color: 'var(--text)', fontSize: 12, fontFamily: 'inherit', outline: 'none', resize: 'none',
            }} />
        </div>

        {/* List */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {manual.length > 0 && manual.map((t) => (
            <div key={t.id} style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px',
              borderBottom: '1px solid var(--border-dim)',
            }}>
              <div style={{ width: 3, height: 24, borderRadius: 2, background: brandColor, flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 600 }}>{t.title}</div>
                <div style={{ fontSize: 10, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.instruction}</div>
              </div>
              <button onClick={() => s.removeManualTask(t.id)} style={{ ...B, color: 'var(--text)', padding: 4, opacity: 0.5 }}><Trash2 size={12} /></button>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ══ INBOX ═══════════════════════════════════════════════════════

  function Inbox() {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
        {/* Toolbar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderBottom: '1px solid var(--border-dim)', flexShrink: 0 }}>
          <button onClick={() => allSel ? fb.deselectAll() : fb.selectAll()} style={{ ...B, display: 'flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 'var(--radius-sm)', fontSize: 10, color: 'var(--text)' }}>
            {allSel ? <CheckSquare size={12} /> : <Square size={12} />}
            {allSel ? 'Deselect' : 'Select All'}
          </button>
          <span style={{ fontSize: 10, color: 'var(--text)' }}>{Object.keys(fb.selectedIds).length}</span>
          <div style={{ flex: 1 }} />
          {/* Batch mode */}
          <button onClick={() => s.setBatchConcurrent(!s.batchOption.concurrent)}
            style={{
              ...B, display: 'flex', alignItems: 'center', gap: 3,
              padding: '2px 8px', borderRadius: 'var(--radius-pill)', fontSize: 10, fontWeight: 600,
              background: s.batchOption.concurrent ? 'color-mix(in srgb, var(--accent) 15%, transparent)' : 'var(--surface)',
              color: s.batchOption.concurrent ? 'var(--accent)' : 'var(--text)',
              border: '1px solid var(--border-dim)',
            }}>
            {s.batchOption.concurrent ? <ToggleRight size={12} /> : <ToggleLeft size={12} />}
            {s.batchOption.concurrent ? 'All' : 'Seq'}
          </button>
          <button onClick={() => s.startForge()}
            disabled={isRunning || (Object.keys(fb.selectedIds).length === 0 && s.tasks.filter((t) => t.consensus === 'pending').length === 0)}
            style={{
              ...B, padding: '5px 14px', borderRadius: 'var(--radius-pill)',
              background: (isRunning || (Object.keys(fb.selectedIds).length === 0 && s.tasks.filter((t) => t.consensus === 'pending').length === 0)) ? 'var(--border-dim)' : 'var(--accent)',
              color: (isRunning || (Object.keys(fb.selectedIds).length === 0 && s.tasks.filter((t) => t.consensus === 'pending').length === 0)) ? 'var(--text)' : 'var(--bg)',
              fontWeight: 700, fontSize: 11, display: 'flex', alignItems: 'center', gap: 5,
              cursor: (isRunning || (Object.keys(fb.selectedIds).length === 0 && s.tasks.filter((t) => t.consensus === 'pending').length === 0)) ? 'not-allowed' : 'pointer',
            }}>
            <Play size={12} />
            {isRunning ? 'Forging…' : 'Forge'}
          </button>
        </div>

        {/* List — no empty state */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {fb.feedbacks.map((f) => {
            const checked = !!fb.selectedIds[f.id];
            const meta = STATUS[f.status];
            return (
              <div key={f.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--border-dim)' }}>
                <button onClick={() => fb.toggleSelected(f.id)} style={{ ...B, color: checked ? 'var(--accent)' : 'var(--text)', paddingTop: 2 }}>
                  {checked ? <CheckSquare size={13} /> : <Square size={13} />}
                </button>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 1 }}>{f.title}</div>
                  <div style={{ fontSize: 10, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: 3 }}>
                    {f.description}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <button onClick={() => {
                      const idx = FEEDBACK_STATUSES.indexOf(f.status);
                      fb.setStatus(f.id, FEEDBACK_STATUSES[(idx + 1) % FEEDBACK_STATUSES.length]);
                    }} style={{
                      ...B, display: 'inline-flex', alignItems: 'center', gap: 3,
                      padding: '1px 6px', borderRadius: 'var(--radius-pill)', fontSize: 8, fontWeight: 700,
                      background: `${meta.dot}18`, color: meta.dot, border: `1px solid ${meta.dot}30`,
                    }}>
                      <Circle size={5} fill={meta.dot} style={{ stroke: 'none' }} />
                      {meta.label} ↻
                    </button>
                    <span style={{ fontSize: 8, color: 'var(--text)' }}>
                      {new Date(f.submittedAt).toLocaleDateString()}
                    </span>
                    {f.screenshotPath && <Camera size={9} style={{ color: 'var(--text)' }} />}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // ══ PIPELINE ════════════════════════════════════════════════════

  function Pipeline() {
    if (s.phase === 'idle') return null;

    const stepIdx = PHASES.findIndex((p) => p.key === s.phase);

    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
        {/* Phase stepper */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 0, padding: '10px 16px', borderBottom: '1px solid var(--border-dim)', flexShrink: 0 }}>
          {PHASES.map((p, i) => {
            const isDone = i < stepIdx;
            const isActive = i === stepIdx;
            return (
              <React.Fragment key={p.key}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <div style={{
                    width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                    background: isDone ? 'var(--success)' : isActive ? 'var(--accent)' : 'var(--text)',
                    opacity: isDone || isActive ? 1 : 0.25,
                    transition: 'background 0.3s, opacity 0.3s',
                  }} />
                  <span style={{
                    fontSize: 10, fontWeight: 600, letterSpacing: 0.2,
                    color: isActive ? 'var(--accent)' : isDone ? 'var(--success)' : 'var(--text)',
                    opacity: isDone || isActive ? 1 : 0.4,
                    transition: 'color 0.3s, opacity 0.3s',
                  }}>
                    {p.label}
                  </span>
                </div>
                {i < PHASES.length - 1 && (
                  <div style={{
                    flex: 1, height: 1,
                    background: i < stepIdx ? 'var(--success)' : 'var(--border-dim)',
                    margin: '0 8px',
                  }} />
                )}
              </React.Fragment>
            );
          })}
        </div>

        {/* Task tree — no empty state */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {s.tasks.map((t) => {
            const tr = s.testRuns.find((r) => r.taskId === t.id);
            return (
              <div key={t.id} style={{ padding: '8px 14px', borderBottom: '1px solid var(--border-dim)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <div style={{
                    width: 3, height: 20, borderRadius: 2, flexShrink: 0,
                    background: t.consensus === 'approved' ? 'var(--success)' : t.consensus === 'rejected' ? 'var(--error)' : 'var(--text)',
                    opacity: t.consensus === 'approved' ? 1 : 0.3,
                  }} />
                  <span style={{ fontSize: 12, fontWeight: 600, flex: 1, minWidth: 0 }}>{t.title}</span>
                  {t.assignedAgent && (
                    <span style={{
                      padding: '1px 8px', borderRadius: 'var(--radius-pill)', fontSize: 9, fontWeight: 700,
                      background: 'color-mix(in srgb, var(--accent) 15%, transparent)', color: 'var(--accent)',
                    }}>
                      {t.assignedAgent}
                    </span>
                  )}
                  {tr && (
                    <span style={{
                      padding: '1px 6px', borderRadius: 'var(--radius-pill)', fontSize: 8, fontWeight: 700,
                      background: tr.status === 'passed' ? 'color-mix(in srgb, var(--success) 20%, transparent)' : tr.status === 'failed' ? 'color-mix(in srgb, var(--error) 20%, transparent)' : 'var(--surface)',
                      color: tr.status === 'passed' ? 'var(--success)' : tr.status === 'failed' ? 'var(--error)' : 'var(--text)',
                    }}>
                      {tr.status === 'passed' ? 'PASS' : tr.status === 'failed' ? 'FAIL' : tr.status}
                    </span>
                  )}
                </div>

                {/* Proposal + evaluation */}
                {t.proposal && (s.phase === 'consensus' || s.phase === 'testing' || s.phase === 'complete') && (
                  <div style={{ marginBottom: 6, marginLeft: 11 }}>
                    <div style={{
                      padding: '6px 10px', borderRadius: 'var(--radius-sm)', fontSize: 10, lineHeight: 1.5,
                      background: 'var(--surface)', border: '1px solid var(--border-dim)',
                      fontFamily: 'var(--font-mono)', whiteSpace: 'pre-wrap', maxHeight: 52, overflow: 'hidden',
                    }}>
                      {t.proposal}
                    </div>
                    {t.evaluation && (
                      <div style={{ marginTop: 3, fontSize: 10, color: 'var(--text)', fontStyle: 'italic' }}>
                        {t.evaluation}
                      </div>
                    )}
                  </div>
                )}

                {/* Approve/reject */}
                {s.phase === 'consensus' && t.consensus === 'pending' && (
                  <div style={{ display: 'flex', gap: 4, marginLeft: 11 }}>
                    <button onClick={() => s.approveTask(t.id)} style={{
                      ...B, padding: '3px 10px', borderRadius: 'var(--radius-pill)', fontSize: 10, fontWeight: 700,
                      background: 'color-mix(in srgb, var(--success) 15%, transparent)', color: 'var(--success)',
                      border: '1px solid color-mix(in srgb, var(--success) 30%, transparent)',
                      display: 'flex', alignItems: 'center', gap: 4,
                    }}>
                      <CheckCircle size={11} /> Approve
                    </button>
                    <button onClick={() => s.rejectTask(t.id)} style={{
                      ...B, padding: '3px 10px', borderRadius: 'var(--radius-pill)', fontSize: 10, fontWeight: 700,
                      background: 'color-mix(in srgb, var(--error) 15%, transparent)', color: 'var(--error)',
                      border: '1px solid color-mix(in srgb, var(--error) 30%, transparent)',
                      display: 'flex', alignItems: 'center', gap: 4,
                    }}>
                      <XCircle size={11} /> Reject
                    </button>
                  </div>
                )}

                {/* Test output */}
                {tr?.output && (
                  <div style={{ marginTop: 4, fontSize: 10, color: tr.status === 'passed' ? 'var(--success)' : 'var(--error)', fontFamily: 'var(--font-mono)' }}>
                    {tr.output}
                    {tr.durationMs && <span style={{ color: 'var(--text)', marginLeft: 8 }}>{tr.durationMs}ms</span>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // ══ METRICS ═════════════════════════════════════════════════════

  function Metrics() {
    const cards = [
      { icon: <Cpu size={16} />, label: 'Tokens', value: `~${s.metrics.totalTokensProcessed.toLocaleString()}` },
      { icon: <Clock size={16} />, label: 'Elapsed', value: `${(s.metrics.elapsedMs / 1000).toFixed(1)}s` },
      { icon: <CheckCircle size={16} />, label: 'Tasks', value: `${s.metrics.tasksCompleted}/${s.metrics.tasksTotal}` },
      { icon: <FileText size={16} />, label: 'Refactored', value: `~${s.metrics.locRefactored} LOC` },
    ];

    return (
      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 16px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 16 }}>
          {cards.map((c, i) => (
            <div key={i} style={{
              padding: '12px', borderRadius: 'var(--radius-md)',
              background: 'var(--surface)', border: '1px solid var(--border-dim)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                <span style={{ color: brandColor }}>{c.icon}</span>
                <span style={{ fontSize: 9, color: 'var(--text)', fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase' }}>{c.label}</span>
              </div>
              <div style={{ fontSize: 20, fontWeight: 700, fontFamily: 'var(--font-accent)' }}>
                {c.value}
              </div>
            </div>
          ))}
        </div>

        {s.testRuns.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text)', letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 8 }}>Tests</div>
            <div style={{
              padding: 12, borderRadius: 'var(--radius-md)',
              background: 'var(--surface)', border: '1px solid var(--border-dim)',
            }}>
              <div style={{ fontSize: 13, fontWeight: 700, fontFamily: 'var(--font-accent)', marginBottom: 6 }}>
                {s.metrics.testsPassed}/{s.metrics.testsTotal}
              </div>
              <div style={{ height: 3, borderRadius: 2, background: 'var(--border-dim)', overflow: 'hidden', marginBottom: 6 }}>
                <div style={{
                  height: '100%', borderRadius: 2,
                  background: s.metrics.testsTotal > 0 ? 'var(--success)' : 'var(--border-dim)',
                  width: `${s.metrics.testsTotal > 0 ? (s.metrics.testsPassed / s.metrics.testsTotal) * 100 : 0}%`,
                  transition: 'width 0.5s',
                }} />
              </div>
              <div style={{ fontSize: 10, color: 'var(--text)' }}>
                {s.metrics.testsTotal - s.metrics.testsPassed > 0
                  ? `${s.metrics.testsTotal - s.metrics.testsPassed} failed`
                  : 'All passing'}
              </div>
            </div>
          </div>
        )}

        {done && (
          <button onClick={s.exportChangelog}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              padding: '8px 18px', borderRadius: 'var(--radius-pill)',
              background: brandColor, border: 'none',
              color: 'var(--bg)', cursor: 'pointer', fontSize: 12, fontWeight: 700,
              fontFamily: 'inherit', width: '100%',
            }}>
            <Download size={14} />
            Export CHANGELOG
          </button>
        )}
      </div>
    );
  }
};

export default ForgeNode;
